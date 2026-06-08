/**
 * Shared notification utilities for the return load finder.
 *
 * sendTelegram  â€” send any message via Telegram Bot API
 * notifyError   â€” send a structured error alert so failures are easy to spot
 *
 * Both functions accept an optional `toChatId` override â€” when omitted they
 * fall back to the first ID in TELEGRAM_ALLOWED_CHAT_IDS.
 * Pass `callerChatId` explicitly so messages go to the right person.
 */

import { metadata } from '@trigger.dev/sdk';

export interface InlineButton { text: string; callback_data: string }
export interface ReplyMarkup  { inline_keyboard: InlineButton[][] }

/**
 * Best-effort metadata append. Called after every successful outbound Telegram
 * call so tests can observe what the bot sent without a Telegram mock. Wrapped
 * in try/catch because `metadata` only resolves inside a task run context
 * (e.g. unit-test imports or scripts that call sendTelegram directly will hit
 * an error otherwise).
 */
function recordOutbox(entry: Record<string, unknown>): void {
  try {
    metadata.append('telegramOutbox', { ...entry, at: new Date().toISOString() });
  } catch {
    /* not in a task context â€” ignore */
  }
}

/**
 * Escape Telegram Markdown V1 special characters in a dynamic field value.
 * Without this, load notes / vehicle names containing `*`, `_`, `[`, `]`, `` ` ``
 * break message parsing (e.g. "***SAME_DAY_TIMED***" is an unclosed bold +
 * unclosed italic, the entire message fails to send).
 */
export function mdEscape(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/([_*[\]`])/g, '\\$1');
}

export async function sendTelegram(
  message: string,
  toChatId?: string,
  replyMarkup?: ReplyMarkup,
): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = toChatId ?? process.env.TELEGRAM_ALLOWED_CHAT_IDS?.split(',')[0]?.trim();

  if (!token || !chatId) {
    console.warn('[NOTIFY] Telegram env vars not set â€” skipping send');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  // One automatic retry on Telegram 429. The bot API rate-limits to ~30 msg/sec
  // group-wide; bursts during pagination or polling can trip it. Telegram tells
  // us how long to wait via `parameters.retry_after` â€” honor it (capped at 30s)
  // and retry the same payload once. If the second attempt still fails, fall
  // through to the normal error path.
  try {
    let res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const errBody = await res.clone().json().catch(() => ({})) as { parameters?: { retry_after?: number }; description?: string };
      const retryAfter = Math.min(30, Math.max(1, errBody?.parameters?.retry_after ?? 5));
      console.warn(`[NOTIFY] Telegram 429 -- retrying in ${retryAfter}s (${errBody?.description})`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    if (!res.ok) {
      const err = await res.json() as { description?: string };
      console.error(`[NOTIFY] Telegram send failed: ${err?.description ?? res.status}`);
      recordOutbox({
        method: 'sendMessage',
        chatId,
        text: message,
        replyMarkup: replyMarkup ?? null,
        ok: false,
        error: err?.description ?? `http_${res.status}`,
      });
      return;
    }
    recordOutbox({
      method: 'sendMessage',
      chatId,
      text: message,
      replyMarkup: replyMarkup ?? null,
      ok: true,
    });
  } catch (err) {
    console.error('[NOTIFY] sendTelegram network error:', err);
    recordOutbox({
      method: 'sendMessage',
      chatId,
      text: message,
      replyMarkup: replyMarkup ?? null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Send a Telegram chat action (typing/upload_photo/...). Free, native, expires
 * after ~5s â€” call this around long CX-driving operations so the driver sees
 * "...is typing" instead of dead air. Failures are swallowed; this is purely
 * cosmetic feedback.
 */
export async function sendChatAction(toChatId?: string, action: 'typing' = 'typing'): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = toChatId ?? process.env.TELEGRAM_ALLOWED_CHAT_IDS?.split(',')[0]?.trim();
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    /* cosmetic â€” ignore */
  }
}

/**
 * Start a typing-indicator loop that pings every ~4s (the indicator naturally
 * expires after 5s on Telegram). Returns a stop fn that cancels the loop and
 * is safe to call multiple times. Call it from a finally block so a thrown
 * search task can't leave the indicator looping forever.
 */
export function startTypingLoop(toChatId?: string): () => void {
  let cancelled = false;
  const tick = async () => {
    if (cancelled) return;
    await sendChatAction(toChatId, 'typing');
  };
  void tick();
  const handle = setInterval(() => { void tick(); }, 4000);
  return () => {
    if (cancelled) return;
    cancelled = true;
    clearInterval(handle);
  };
}

/**
 * Edit an existing message's text in place. Used to turn the "Searching..."
 * message into a live status feed without spamming the chat with new sends.
 * Returns false if Telegram rejected the edit (most commonly "message is not
 * modified" â€” harmless, just means the new text matched the old).
 */
export async function editTelegramText(
  toChatId: string | undefined,
  messageId: number,
  text: string,
  replyMarkup?: ReplyMarkup,
): Promise<boolean> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = toChatId ?? process.env.TELEGRAM_ALLOWED_CHAT_IDS?.split(',')[0]?.trim();
  if (!token || !chatId || !messageId) return false;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ok = res.ok;
    recordOutbox({
      method: 'editMessageText',
      chatId,
      messageId,
      text,
      replyMarkup: replyMarkup ?? null,
      ok,
    });
    return ok;
  } catch (err) {
    console.error('[NOTIFY] editTelegramText network error:', err);
    return false;
  }
}

/**
 * Edit just the inline keyboard on an existing message. Used to "disable" a
 * picker after the user taps it (replace the row with a single `âœ“ {choice}`
 * row that has a no-op callback). Pass `null` to strip the keyboard entirely.
 */
export async function editTelegramReplyMarkup(
  toChatId: string | undefined,
  messageId: number,
  replyMarkup: ReplyMarkup | null,
): Promise<boolean> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = toChatId ?? process.env.TELEGRAM_ALLOWED_CHAT_IDS?.split(',')[0]?.trim();
  if (!token || !chatId || !messageId) return false;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ok = res.ok;
    recordOutbox({
      method: 'editMessageReplyMarkup',
      chatId,
      messageId,
      replyMarkup,
      ok,
    });
    return ok;
  } catch (err) {
    console.error('[NOTIFY] editTelegramReplyMarkup network error:', err);
    return false;
  }
}

/**
 * Build a one-row inline keyboard that visually marks a picker as "tapped".
 * The callback_data is `noop:done` â€” the webhook ignores it.
 */
export function tappedKeyboard(label: string): ReplyMarkup {
  const safe = label.length > 60 ? `${label.slice(0, 57)}...` : label;
  return { inline_keyboard: [[{ text: `âœ“ ${safe}`, callback_data: 'noop:done' }]] };
}

/**
 * React to a message with an emoji. Falls back silently when the chat / bot
 * doesn't permit reactions (private chats and groups where the bot isn't an
 * admin with the right permission both reject the call). Replaces the old
 * "Got it -- {x}" acknowledgement pattern for callback handlers.
 */
export async function reactToMessage(
  toChatId: string | undefined,
  messageId: number,
  emoji: string = 'ðŸ‘',
): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = toChatId ?? process.env.TELEGRAM_ALLOWED_CHAT_IDS?.split(',')[0]?.trim();
  if (!token || !chatId || !messageId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
        is_big: false,
      }),
    });
    recordOutbox({ method: 'setMessageReaction', chatId, messageId, emoji, ok: true });
  } catch (err) {
    /* best-effort â€” swallow */
    recordOutbox({
      method: 'setMessageReaction',
      chatId,
      messageId,
      emoji,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Cycle a status message through animation frames while a long operation runs.
 * Returns a stop fn that cancels the loop. Frames are cycled at `intervalMs`
 * (default 1500 ms â€” well under Telegram's 30-edits/min/message ceiling).
 *
 * Stage-level edits (via `editTelegramText` directly) always supersede this
 * cycle: just call the stop fn before the stage edit so the next tick won't
 * overwrite the stage text.
 */
export function startEmojiCycleOnMessage(
  toChatId: string | undefined,
  messageId: number,
  frames: string[],
  intervalMs: number = 1500,
): () => void {
  if (!messageId || frames.length === 0) return () => {};
  let cancelled = false;
  let i = 0;
  const tick = async () => {
    if (cancelled) return;
    const frame = frames[i % frames.length];
    i += 1;
    await editTelegramText(toChatId, messageId, frame);
  };
  const handle = setInterval(() => { void tick(); }, intervalMs);
  return () => {
    if (cancelled) return;
    cancelled = true;
    clearInterval(handle);
  };
}

/** Send a Telegram message and return the message_id of the created message,
 *  or null on failure. Useful when the caller needs to edit the message later
 *  (status messages, pickers that get disabled after a tap). */
export async function sendTelegramReturningId(
  message: string,
  toChatId?: string,
  replyMarkup?: ReplyMarkup,
): Promise<number | null> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = toChatId ?? process.env.TELEGRAM_ALLOWED_CHAT_IDS?.split(',')[0]?.trim();
  if (!token || !chatId) return null;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    let res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const errBody = await res.clone().json().catch(() => ({})) as { parameters?: { retry_after?: number } };
      const retryAfter = Math.min(30, Math.max(1, errBody?.parameters?.retry_after ?? 5));
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      const err = await res.json() as { description?: string };
      console.error(`[NOTIFY] sendTelegramReturningId failed: ${err?.description ?? res.status}`);
      recordOutbox({
        method: 'sendMessage',
        chatId,
        text: message,
        replyMarkup: replyMarkup ?? null,
        ok: false,
        error: err?.description ?? `http_${res.status}`,
      });
      return null;
    }
    const data = await res.json() as { result?: { message_id?: number } };
    const messageId = data?.result?.message_id ?? null;
    recordOutbox({
      method: 'sendMessage',
      chatId,
      text: message,
      replyMarkup: replyMarkup ?? null,
      ok: true,
      messageId,
    });
    return messageId;
  } catch (err) {
    console.error('[NOTIFY] sendTelegramReturningId network error:', err);
    return null;
  }
}

/** Acknowledge a button tap so Telegram's spinner clears. */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !callbackQueryId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
    recordOutbox({ method: 'answerCallbackQuery', callbackQueryId, text: text ?? null, ok: true });
  } catch (err) {
    console.error('[NOTIFY] answerCallbackQuery network error:', err);
    recordOutbox({
      method: 'answerCallbackQuery',
      callbackQueryId,
      text: text ?? null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Send a Telegram error alert.
 *
 * @param taskName   - e.g. "search-loads"
 * @param error      - the caught error
 * @param runId      - ctx.run.id from Trigger.dev (optional)
 * @param toChatId   - chat ID override for multi-user scenarios
 */
export async function notifyError(taskName: string, error: unknown, runId?: string, toChatId?: string): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const runLink  = runId
    ? `\nðŸ”— Run ID: ${runId}\nhttps://cloud.trigger.dev/runs/${runId}`
    : '';

  const alert =
    `ðŸš¨ *Task failed: ${taskName}*\n` +
    `âŒ ${message}${runLink}\n\n` +
    `Check Trigger.dev logs for the full stack trace.`;

  await sendTelegram(alert, toChatId);
}

