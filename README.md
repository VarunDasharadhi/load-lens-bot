<div align="center">

# Load Lens

**Telegram bot that automates load searching and quote submission on Courier Exchange.**

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Telegram](https://img.shields.io/badge/Telegram%20Bot-2CA5E0?style=flat-square&logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Trigger.dev](https://img.shields.io/badge/Trigger.dev-6D28D9?style=flat-square)](https://trigger.dev)
[![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white)](https://vercel.com)
[![Production](https://img.shields.io/badge/status-production-brightgreen?style=flat-square)](https://loadlens.co.uk)

[loadlens.co.uk](https://loadlens.co.uk)

</div>

---

Courier Exchange (CX) is the UK's largest freight matching platform. Drivers spend hours each day manually refreshing search pages and typing quotes. Load Lens eliminates that: send a plain-English message, get matching loads in seconds, submit a bid in four taps -- all from Telegram, without ever opening a browser.

---

## ✨ Features

- **Natural language search** -- type anything: "loads from Leeds 30 miles today", "Bristol to Manchester tomorrow", "any work near me"
- **LLM intent classifier** -- Gemini 2.5 Flash Lite parses freeform driver language into structured search parameters with confidence scoring
- **Automated load fetching** -- headless browser navigates CX, applies filters, and surfaces matching loads as Telegram cards
- **One-tap quoting** -- select vehicle, enter price, add notes, confirm; the bot fills and submits the CX quote form
- **Polling mode** -- "keep searching for 2 hours" schedules recurring searches and DMs new loads as they appear
- **Multi-tenant** -- each driver has isolated credentials and session state in Redis; sessions persist across restarts

---

## 🏗️ How it works

```
Driver (Telegram)        Vercel              Trigger.dev             Playwright
      |                    |                      |                       |
      | "loads from Leeds" |                      |                       |
      |------------------->|                      |                       |
      |            trigger('telegram-webhook')    |                       |
      |                    |--------------------->|                       |
      |                    |           classify intent (LLM)              |
      |                    |           trigger('search-loads')            |
      |                    |                      |--- launch browser --->|
      |                    |                      |              login + search CX
      |                    |                      |<-- load results ------|
      |<-- load cards + [💷 Quote] --------------|  (direct to Telegram) |
      |                    |                      |                       |
      | (taps 💷 Quote)    |                      |                       |
      |------------------->|                      |                       |
      |            trigger('telegram-webhook')    |                       |
      |                    |--------------------->|                       |
      |                    |         write quote intent to Redis          |
      |                    |         running search task sees it          |
      |                    |                      |--- open quote modal ->|
      |                    |                      |<-- vehicle options ---|
      |<-- "Which vehicle?" [buttons] ------------|                       |
      |  ...vehicle > price > confirm...          |                       |
      |                    |                      |--- fill + submit ---->|
      |<-- "✅ Bid placed" ----------------------|  (direct to Telegram) |
```

The **Vercel webhook** is a thin forwarder -- it receives Telegram's HTTP callback and immediately calls `tasks.trigger()`. All logic runs in **Trigger.dev** background tasks that can run for minutes without timing out. The **Playwright task** drives a headless browser on CX; it also acts as the live quote co-ordinator, watching Redis for the driver's choices and submitting the form step by step. **Results are sent directly from the task to Telegram** -- they never route back through Vercel.

---

## 🧠 Architecture decisions

**Why Trigger.dev for background jobs?**
A single CX session (login + search + parse) takes 30-60 seconds -- well past Vercel's serverless timeout. Trigger.dev handles long-running tasks with automatic retries and built-in run observability. Each webhook invocation spawns an isolated task run, so concurrent drivers don't block each other.

**Why Redis for state?**
A complete interaction spans multiple webhook invocations: search request, radius picker, date picker, confirm, then a five-step quote flow. State must survive between them. Redis gives sub-millisecond reads and supports per-chat-ID key namespacing for multi-tenant isolation. The quote flow uses a shared `quote_session` key as a co-ordination channel between the webhook task (reading driver choices) and the Playwright task (executing browser actions).

**Why an LLM for intent classification instead of regex?**
Drivers type informally: "loads from brum 30 today", "heading down to bristol from sheffield", "any work near me". Regex breaks on variations. A small LLM (Gemini 2.5 Flash Lite via OpenRouter) handles freeform input, extracts structured parameters, generates a natural reply, and scores confidence -- all in one call. When confidence drops below 0.7, the bot asks a clarifying question instead of guessing. See [`src/classify-message.ts`](src/classify-message.ts).

**Why Playwright instead of a CX API?**
CX does not offer a public API. The automation layer interacts with CX exactly as a human would.

---

## ⚡ Key technical challenges

**Anti-bot resilience** -- CX uses session-based bot detection that breaks naive scraping. The browser automation layer handles cookie persistence, login recovery after session expiry, and request pacing to stay within human-equivalent usage patterns.

**Multi-tenant session isolation** -- Multiple drivers use the same bot simultaneously. Credentials and session cookies are stored per chat ID in Redis, encrypted at rest. One driver's session expiring never interrupts another driver's active search.

**Stateful quote flow** -- The quote flow spans five steps across separate webhook invocations (tap Quote, pick vehicle, enter price, add notes, confirm). The running Playwright task watches Redis for each step and executes the matching browser action in sequence, while the webhook tasks co-ordinate purely through shared state.

**Multi-origin searches** -- "loads from Leeds and Manchester" fans out into two search tasks, staggered 60 seconds apart so the bot never opens simultaneous CX sessions for the same driver, keeping load patterns human-equivalent.

---

## 🛠️ Stack

| Layer | Technology |
|---|---|
| 💬 Bot interface | Telegram Bot API |
| 🌐 Webhook | Vercel serverless |
| ⚙️ Background jobs | Trigger.dev |
| 🤖 Intent classification | OpenRouter / Gemini 2.5 Flash Lite |
| 🧭 Browser automation | Playwright (proprietary -- not in this repo) |
| 🗄️ State management | Upstash Redis |
| 🔤 Language | TypeScript |

---

## 📁 What is in this repo

Public showcase of the architecture and selected production modules. The full production repo (CX scraping layer, credential handling) is private.

```
src/
  classify-message.ts   LLM intent classifier + parameter extractor
  notify.ts             Telegram notification utilities: send, edit, typing indicators, rate-limit retry
```

---

## 🚀 Status

Phase 1 running in production. Phase 2 (multi-tenant self-service signup) in design.

**Live:** [loadlens.co.uk](https://loadlens.co.uk)