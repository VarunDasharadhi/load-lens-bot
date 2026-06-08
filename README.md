# Load Lens

> Telegram bot that automates load searching and quote submission on Courier Exchange. Running in production.

Courier Exchange (CX) is the UK's largest freight matching platform. Drivers spend hours each day manually refreshing search pages and typing quotes. Load Lens automates the full cycle: a driver sends a plain-English message to the bot, it searches CX in the background, surfaces matching loads, and submits quotes -- all from Telegram.

---

## How it works

```
Driver                   Vercel             Trigger.dev          Playwright         CX
  |                         |                    |                    |               |
  |-- "loads from Leeds" -->|                    |                    |               |
  |                    webhook triggers task      |                    |               |
  |                         |-----trigger()----->|                    |               |
  |                         |                    |-- classifyMessage()|               |
  |                         |                    |   (OpenRouter LLM) |               |
  |                         |                    |                    |               |
  |                         |                    |--- launch browser ----------------->|
  |                         |                    |                    |<-- scrape -----|
  |                         |                    |<-- load results ---|               |
  |<-- load cards + Quote --|                    |                    |               |
  |                         |                    |                    |               |
  |-- (taps Quote) -------->|                    |                    |               |
  |                         |-----trigger()----->|                    |               |
  |                         |                    |--- fill quote form -------------->|
  |<-- "Bid placed" --------|                    |                    |               |
```

The webhook is a Vercel serverless function. Heavy work runs in Trigger.dev background tasks so the webhook returns fast and never times out. State between messages (pending confirmations, active search IDs, quote sessions) lives in Redis.

---

## Architecture decisions

**Why Trigger.dev for background jobs?**
Playwright sessions can take 30-60 seconds, well past Vercel's serverless timeout limit. Trigger.dev handles long-running tasks with automatic retries and built-in observability. Each driver interaction spawns an isolated task run, so concurrent users don't interfere with each other.

**Why Redis for state?**
A multi-step conversation (search -> radius picker -> date picker -> confirm -> quote flow) requires state to survive across webhook invocations. Redis gives sub-millisecond reads and supports multi-tenant key namespacing per chat ID. Upstash is used for the serverless-compatible client.

**Why an LLM for intent classification?**
Drivers type in short, informal phrases: "loads from leeds 30 today", "heading down to bristol from brum", "any work near me". Regex and keyword matching break on variations. A small LLM (Gemini 2.5 Flash Lite via OpenRouter) extracts intent + structured parameters in one call, handles corrections, and generates a natural-language reply. Temperature 0 keeps it deterministic; confidence scoring below 0.7 triggers a clarifying question instead of acting on an uncertain parse.

**Why Playwright and not the CX API?**
CX does not offer a public API. The automation layer interacts with CX the same way a human would, driving a headless browser with Playwright.

---

## Key technical challenges

**Anti-bot resilience** -- CX uses CAPTCHA-adjacent bot detection and session management that breaks naive scraping. The browser automation layer handles session persistence, login recovery, and rate limiting to stay within human-equivalent usage patterns.

**Multi-tenant session isolation** -- Multiple drivers use the same bot simultaneously. Each driver's CX credentials and session state are stored separately in Redis under their chat ID, encrypted at rest. A driver's session cookie expiring mid-search triggers re-authentication without interrupting other users.

**Stateful conversation flow** -- The quote flow spans five steps: tap Quote, select vehicle, enter price, add notes, confirm. The Trigger.dev task and the Telegram webhook communicate through Redis (a shared `quote_session` key) -- the long-running Playwright task watches for the driver's choices and executes each step as they come in.

**Concurrency at the browser level** -- Multiple concurrent Playwright sessions on the same server can contend for resources. Task scheduling staggers multi-location searches by 60 seconds so the bot never opens simultaneous CX sessions for the same driver.

---

## Stack

| Layer | Tech |
|---|---|
| Bot interface | Telegram Bot API |
| Webhook + API | Vercel (serverless) |
| Background jobs | Trigger.dev |
| Browser automation | Playwright (proprietary, not in this repo) |
| LLM intent classification | OpenRouter / Gemini 2.5 Flash Lite |
| State management | Upstash Redis |
| Language | TypeScript |

---

## What is in this repo

This is a public showcase of the architecture and selected production modules. The full production repo is private.

```
src/
  classify-message.ts   LLM intent classifier + parameter extractor
  notify.ts             Telegram notification utilities (sendMessage, editMessage, typing indicators)
```

The Playwright browser automation layer (CX login, search, and quote submission) is proprietary and not included here.

---

## Status

Running in production. Phase 1 (single-tenant, one driver) is live. Phase 2 (multi-tenant, self-service signup) is in design.

Live: [loadlens.co.uk](https://loadlens.co.uk)