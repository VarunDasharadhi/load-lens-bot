/**
 * LLM-based message classifier + parameter extractor.
 *
 * Replaces the old regex classifyMessage() and the separate parse-instant-search /
 * parse-job tasks with a single LLM call that understands freeform English.
 *
 * Always returns structured JSON so the webhook handler can act on it directly.
 */

export type Intent =
  | 'instant_search'   // user wants to search for loads from a location
  | 'return_load'      // user wants a return load search (origin -> destination with time)
  | 'confirm'          // user is confirming a previous prompt (yes, yeah, go ahead, etc.)
  | 'cancel'           // user is declining/cancelling (no, nope, cancel, etc.)
  | 'stop'             // user wants to pause/stop a running search
  | 'accept'           // user wants to accept a specific load
  | 'keep_searching'   // user wants to continue/extend a search
  | 'status'           // user wants to see what's running
  | 'help'             // user asking what the bot can do
  | 'greeting'         // casual hello/thanks/chitchat
  | 'correction'       // user is correcting or modifying a previous request
  | 'replace'          // user chose "replace" in a duplicate prompt
  | 'keep'             // user chose "keep" in a duplicate prompt
  | 'unknown';         // can't determine intent

export interface InstantSearchParams {
  location: string;
  radiusMiles?: number;
  vehicleType?: string;
  maxWeight?: string;
  dateFilter?: 'Today' | 'Tomorrow' | 'Any time';
}

export interface ReturnLoadParams {
  origin: string;
  destination: string;
  radiusMiles?: number;     // shared default applied to both origin + destination legs (if extracted)
  dateFilter?: 'Today' | 'Tomorrow' | 'Any time';
}

export interface AcceptParams {
  loadId: string;
  collectionTime: string;
  price: string;
}

export interface ClassifyResult {
  intent: Intent;
  reply: string;                           // natural language reply to send the user
  instantSearch?: InstantSearchParams;     // populated when intent = instant_search
  returnLoad?: ReturnLoadParams;           // populated when intent = return_load
  accept?: AcceptParams;                   // populated when intent = accept
  missingFields?: string[];                // fields the LLM couldn't extract
  pauseTarget?: string;                    // destination name if user specified which to pause
  /** 0.0â€“1.0 confidence. When < 0.7 the webhook asks a clarifying question instead of guessing. */
  confidence?: number;
  /** When confidence is low, a short targeted question to resolve the ambiguity. */
  clarifyQuestion?: string;
}

interface PendingContext {
  pendingConfirmType?: 'instant_search' | 'return_load' | 'pause' | 'duplicate';
  pendingSearchSummary?: string;       // what we asked the user to confirm
  pendingFollowUpType?: 'instant_search' | 'return_load';  // set when STILL gathering fields, distinct from waiting-on-confirmation
  pendingFollowUpSummary?: string;     // partial state + remaining-fields description
  activeSearches?: string[];           // list of destination names currently running
  pendingDuplicateDestination?: string;
}

export async function classifyMessage(
  message: string,
  sentAt: string,
  context: PendingContext,
): Promise<ClassifyResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const now = new Date(sentAt);
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toISOString().split('T')[1].substring(0, 5);

  // Build context section so the LLM knows what state the conversation is in
  const contextLines: string[] = [];
  if (context.pendingConfirmType) {
    contextLines.push(`The bot is currently waiting for the user to confirm a ${context.pendingConfirmType} request.`);
    if (context.pendingSearchSummary) {
      contextLines.push(`The pending request summary: ${context.pendingSearchSummary}`);
    }
  }
  if (context.pendingFollowUpType) {
    contextLines.push(`The bot is currently GATHERING MISSING DETAILS for a ${context.pendingFollowUpType} request (NOT yet awaiting a Yes/No confirmation).`);
    if (context.pendingFollowUpSummary) {
      contextLines.push(context.pendingFollowUpSummary);
    }
    contextLines.push(`When the user supplies a value for one of the missing fields (a time, a duration, a route, a radius, a date, etc.), classify their message as "${context.pendingFollowUpType}" with the new value placed in the appropriate parameter. Do NOT classify those replies as "confirm" -- "confirm" is reserved for explicit yes-style answers ("yes", "yeah", "go ahead", "do it").`);
  }
  if (context.pendingDuplicateDestination) {
    contextLines.push(`The bot asked the user to choose "Replace" or "Keep" for a duplicate search to ${context.pendingDuplicateDestination}.`);
  }
  if (context.activeSearches && context.activeSearches.length > 0) {
    contextLines.push(`Currently running searches: ${context.activeSearches.join(', ')}`);
  }

  const contextBlock = contextLines.length > 0
    ? `\n\nCONVERSATION STATE:\n${contextLines.join('\n')}`
    : '';

  const systemPrompt = `You are a chatbot for a courier driver. You help them find loads on Courier Exchange.
Today is ${dateStr}, current time is approximately ${timeStr} UTC.
${contextBlock}

Your job: classify the user's message and extract any relevant parameters. Return ONLY valid JSON.

JSON schema:
{
  "intent": one of: "instant_search", "return_load", "confirm", "cancel", "stop", "accept", "keep_searching", "status", "help", "greeting", "correction", "replace", "keep", "unknown",
  "reply": "string -- a short, friendly, natural reply to send back. Write like a mate who works in logistics. Keep it brief. Use emojis sparingly. For search/job requests, summarise what you understood and ask for confirmation. For confirmations, acknowledge warmly. For greetings, be friendly.",
  "instantSearch": { "location": "string", "radiusMiles": number|null, "vehicleType": "string"|null, "maxWeight": "string"|null, "dateFilter": "Today" | "Tomorrow" | "Any time" | null } or null,
  "returnLoad": { "origin": "string", "destination": "string", "radiusMiles": number|null -- if user gives a single radius for a journey, set this; the bot applies it to both legs, "dateFilter": "Today" | "Tomorrow" | "Any time" | null } or null,
  "accept": { "loadId": "string", "collectionTime": "string", "price": "string" } or null,
  "missingFields": ["field1", "field2"] or [],
  "pauseTarget": "string or null -- if the user says which search to stop, the destination name",
  "confidence": 0.0 to 1.0 -- how confident you are in the intent classification. Use 1.0 when it's crystal clear. Use < 0.7 when the message is genuinely ambiguous (e.g. a bare location name with no action verb, mixed signals, or total non-sequitur),
  "clarifyQuestion": "string or null -- when confidence < 0.7, a single SHORT question that resolves the ambiguity. E.g. 'Loads *from* Manchester or *to* Manchester?' or 'Did you want to start a new search, or continue setting up the current one?'"
}

INTENT RULES:
- "instant_search": user wants to find available loads from a SINGLE location. e.g. "search from London", "I'm in Birmingham find me loads", "what's available near Leeds", "any loads around Manchester". Extract location, radius, date. ONLY classify as instant_search when the user mentions one location -- if they name two cities (an origin AND a destination), it's a return_load even if nothing else is given. Conversational phrasings like "going to X", "heading to X", "driving down to X", "to X" mentioned alongside another city count as a SECOND location -- treat the whole message as return_load.
- "return_load": user is describing a journey with an origin AND a destination -- they want to find loads going from A to B. e.g. "from london to manchester", "doing the cardiff to bristol run", "I'm driving down to leeds from sheffield", "I'm in IV30 going to glasgow", "find loads near IV30 to glasgow". Extract origin, destination, and (optionally) a radius. Two locations always means return_load, not instant_search. Do NOT extract any times or durations -- the bot no longer uses departure times or drive durations.
- "confirm": user is saying yes/agreeing to a pending prompt. e.g. "yes", "yeah", "go ahead", "yep", "sure", "sounds good", "do it", "that's right". ONLY classify as confirm if there is a pending confirmation in the conversation state.
- "cancel": user is declining. e.g. "no", "nope", "cancel", "wrong", "start over". ONLY if there is a pending confirmation. Do NOT treat "hang on", "hold on", "wait", "one sec", "gimme a sec", "hold up" as cancel -- those are the driver pausing to think, NOT abandoning the search. Classify those as "unknown" so the bot can offer Continue / Start fresh instead of tearing the search down.
- "stop": user wants to stop/pause a search. e.g. "pause", "stop", "stop search", "end it", "halt".
- "accept": user wants to accept a load. Format: "accept [loadId] [time] [price]". Extract the three parts.
- "keep_searching": user wants to continue searching. e.g. "keep searching", "continue looking", "don't stop".
- "status": user asking what's running. e.g. "status", "what's running", "any updates", "show searches".
- "help": user asking what the bot does. e.g. "help", "commands", "what can you do".
- "greeting": casual chat. e.g. "hi", "hey", "thanks", "cheers", "morning".
- "correction": user is modifying a previous request while a confirmation is pending. e.g. "actually make it 40 miles", "change the time to 2pm", "no, I meant Birmingham not London".
- "replace": user chose to replace a duplicate search.
- "keep": user chose to keep an existing search when duplicate was detected.
- "unknown": cannot determine intent.

REPLY RULES:
- For instant_search: Summarise what you understood and ask "Does that look right? Reply Yes to search, or tell me what to change."
- For return_load: Summarise the route (from -> to), then ask for confirmation.
- For confirm/cancel/stop/status/help/greeting: Write a natural, friendly response.
- For correction: Acknowledge the change, show the updated version, and ask for confirmation again.
- If important fields are missing, your reply should ask for them naturally (don't just list field names).
- Keep replies SHORT. 2-4 lines max for most things. Don't be robotic.
- Use Telegram Markdown: *bold* for emphasis, _italic_ for examples.
- Use -- instead of dashes for ranges (Telegram Markdown issue with em-dashes).

PARAMETER RULES:
- radiusMiles: ONLY set this if the user EXPLICITLY mentions a radius (e.g. "30 miles", "within 25mi", "50 mile radius"). Otherwise leave as null -- the bot has a dedicated radius picker for that case and must not be bypassed by an LLM-supplied default.
- Do NOT extract or infer any times, pickup times, departure times, or drive durations. The bot does not use them. Ignore phrases like "pick up in 1hr", "leaving at 9am", "2h drive" -- they do not change the search.
- Clean up location names to proper capitalisation
- Vehicle types: Small Van, Midi Van, SWB, MWB, LWB, XLWB, Luton, 7.5T
- dateFilter (instant_search AND return_load): set to "Today" if user mentions "today" / "right now" / "this morning" / "this afternoon" / "this evening". Set to "Tomorrow" if they mention "tomorrow" / "next morning". Set to "Any time" if they mention "any time" / "anytime" / "any day" / "this week" / "next few days" / "no rush". If the user did NOT mention a date at all, leave dateFilter as null -- do NOT default to Today, the bot will ask. This applies to corridor (return_load) searches too: "leeds to london tomorrow" -> dateFilter "Tomorrow".

FEW-SHOT EXAMPLES (match this extraction shape exactly):
- "I'm in IV30 going to Glasgow find loads" -> intent=return_load, returnLoad={origin:"IV30", destination:"Glasgow", radiusMiles:null}
- "find a load from london to manchester within 50 miles" -> intent=return_load, returnLoad={origin:"London", destination:"Manchester", radiusMiles:50}
- "doing the cardiff to bristol run" -> intent=return_load, returnLoad={origin:"Cardiff", destination:"Bristol", radiusMiles:null}
- "leeds to london tomorrow" -> intent=return_load, returnLoad={origin:"Leeds", destination:"London", radiusMiles:null, dateFilter:"Tomorrow"}
- "find loads from London 30 miles today" -> intent=instant_search, instantSearch={location:"London", radiusMiles:30, dateFilter:"Today"}
- "any loads near Birmingham" -> intent=instant_search, instantSearch={location:"Birmingham", radiusMiles:null, dateFilter:null}
- "loads please" -> intent=instant_search, instantSearch={location:"", radiusMiles:null, ...}, missingFields=["location"]
- "any work near me" -> intent=instant_search, instantSearch={location:"", radiusMiles:null, ...}, missingFields=["location"]
- "hang on" / "hold on" / "wait a sec" / "one sec" -> intent=unknown (driver is pausing to think; if a picker is open the bot offers Continue / Start fresh rather than cancelling)
- "hi" -> intent=greeting, reply="Hey! Send me a search like _loads from Birmingham, 30 miles_ and I'll get looking."
- "what can you do" -> intent=help`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/trigger-demo',
      'X-Title': 'CX Load Search Bot',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash-lite',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${err}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0].message.content;

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.error('Failed to parse LLM response:', content);
    return {
      intent: 'unknown',
      reply: `Sorry, I didn't quite get that. Try something like:\n_"Search from London, 30 miles"_\nor _"Luton to Sheffield, 9am, 2.5hr drive"_`,
    };
  }

  const result: ClassifyResult = {
    intent: parsed.intent ?? 'unknown',
    reply: parsed.reply ?? '',
    missingFields: parsed.missingFields ?? [],
    pauseTarget: parsed.pauseTarget ?? undefined,
  };

  // Attach extracted params based on intent
  if (parsed.instantSearch && parsed.intent === 'instant_search') {
    result.instantSearch = {
      location: parsed.instantSearch.location,
      radiusMiles: parsed.instantSearch.radiusMiles ?? undefined,
      vehicleType: parsed.instantSearch.vehicleType ?? undefined,
      maxWeight: parsed.instantSearch.maxWeight ?? undefined,
      dateFilter: parsed.instantSearch.dateFilter ?? undefined,
    };
  }

  if (parsed.returnLoad && parsed.intent === 'return_load') {
    result.returnLoad = {
      origin: parsed.returnLoad.origin,
      destination: parsed.returnLoad.destination,
      radiusMiles: parsed.returnLoad.radiusMiles ?? undefined,
      dateFilter: parsed.returnLoad.dateFilter ?? undefined,
    };
  }

  if (parsed.accept && parsed.intent === 'accept') {
    result.accept = {
      loadId: parsed.accept.loadId,
      collectionTime: parsed.accept.collectionTime,
      price: parsed.accept.price,
    };
  }

  // Handle corrections: if LLM detected a correction with updated search params, attach them
  if (parsed.intent === 'correction') {
    if (parsed.instantSearch) {
      result.instantSearch = {
        location: parsed.instantSearch.location,
        radiusMiles: parsed.instantSearch.radiusMiles ?? undefined,
        vehicleType: parsed.instantSearch.vehicleType ?? undefined,
        maxWeight: parsed.instantSearch.maxWeight ?? undefined,
        dateFilter: parsed.instantSearch.dateFilter ?? undefined,
      };
    }
    if (parsed.returnLoad) {
      result.returnLoad = {
        origin: parsed.returnLoad.origin,
        destination: parsed.returnLoad.destination,
        radiusMiles: parsed.returnLoad.radiusMiles ?? undefined,
        dateFilter: parsed.returnLoad.dateFilter ?? undefined,
      };
    }
  }

  return result;
}
