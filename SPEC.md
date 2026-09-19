# LET Junior — WhatsApp AI Sales Agent (Backend Spec)

**Audience:** the implementing developer (likely Claude Code).
**Scope:** backend only. No frontend, no dashboard, no admin UI.
**Owner:** Jordi, solo founder. Single operator, single WhatsApp number.

---

## 0. Read this first

### What this system is

A webhook service that sits between Meta's WhatsApp Cloud API and the Anthropic API. It answers inbound WhatsApp messages from parents of prospective students in Latin America, in Spanish, qualifies them, books trial classes, sends payment links, and hands off to Jordi when a human is needed.

### What this system is NOT

- Not a CRM. There is no pipeline UI, no inbox, no agent seats.
- Not a multi-tenant product. One business, one phone number, hardcode what is constant.
- Not a general assistant. It talks about LET Junior and nothing else.

### Non-negotiable rules

1. **The model never states a price, schedule, or availability from its own memory.** Every factual claim about the business comes from the knowledge file or a tool result. If the model does not have the fact, it escalates.
2. **The bot never fights the human.** If Jordi has replied to a contact from his phone, the bot is silent for that contact until explicitly resumed.
3. **Never send more than one message burst per inbound message.** The current system's failure mode is bombarding leads. Do not recreate it.
4. **`ctwa_clid` is captured on first contact or lost forever.** Treat it as critical-path data.
5. **Webhook returns HTTP 200 within 5 seconds, always.** All real work happens after the response. Meta retries aggressively and duplicate processing means duplicate messages to a real parent.

---

## 1. Stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 20+, TypeScript | Strict mode on |
| Hosting | Vercel serverless functions | Free tier is sufficient at this volume |
| Database | Supabase (Postgres) | Its table editor is the only "dashboard" in v1 |
| Queue | Supabase table + Vercel Cron | Do not add Redis or a broker |
| LLM | Anthropic API, `claude-haiku-4-5` | Escalate to a larger model only if quality demands it |
| Calendar | Google Calendar API, service account | |
| Payments | Stripe Payment Links API | |

Do not add: Redis, Docker, Kafka, a message broker, an ORM heavier than the Supabase client, or any agent framework. This is a few thousand lines of code.

### Environment variables

```
# Meta / WhatsApp
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_BUSINESS_ACCOUNT_ID
META_ACCESS_TOKEN            # system user token, long-lived
META_APP_SECRET              # for webhook signature verification
META_WEBHOOK_VERIFY_TOKEN    # random string you choose
META_GRAPH_VERSION           # e.g. v23.0 — do not hardcode in source
META_DATASET_ID              # Business Messaging dataset, Phase 2

# Anthropic
ANTHROPIC_API_KEY
ANTHROPIC_MODEL

# Supabase
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY

# Google
GOOGLE_SERVICE_ACCOUNT_JSON  # base64 encoded
GOOGLE_CALENDAR_ID

# Stripe
STRIPE_SECRET_KEY

# Ops
OWNER_WHATSAPP_NUMBER        # Jordi's personal number for escalation alerts
ENVIRONMENT                  # development | production
```

**Verify the current Graph API version against Meta's changelog before starting.** Do not trust a version number written in this document; it ages.

---

## 2. Database schema

Keep it to four tables. Resist adding more.

```sql
create table leads (
  id                uuid primary key default gen_random_uuid(),
  wa_id             text unique not null,        -- phone in international format, no +
  profile_name      text,                         -- name from WhatsApp profile
  display_name      text,                         -- name the parent actually gives us
  student_name      text,
  student_age       int,
  stage             text not null default 'new',  -- see stage enum below
  tags              text[] default '{}',
  ctwa_clid         text,                         -- CRITICAL: capture on first message
  ctwa_source_id    text,                         -- ad id from referral
  ctwa_captured_at  timestamptz,
  bot_paused        boolean not null default false,
  bot_paused_reason text,
  bot_paused_at     timestamptz,
  first_contact_at  timestamptz not null default now(),
  last_message_at   timestamptz,
  last_inbound_at   timestamptz,                  -- drives the 24h window check
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table messages (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid references leads(id) on delete cascade,
  wa_message_id text unique,                      -- idempotency key
  direction    text not null,                     -- inbound | outbound_bot | outbound_human
  body         text,
  raw          jsonb,
  created_at   timestamptz not null default now()
);

create table conversion_events (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid references leads(id),
  event_name    text not null,                    -- Lead | Schedule | Purchase
  value         numeric,
  currency      text default 'USD',
  ctwa_clid     text,
  sent_to_meta  boolean not null default false,
  meta_response jsonb,
  attempts      int not null default 0,
  created_at    timestamptz not null default now()
);

create table outbound_queue (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid references leads(id) on delete cascade,
  body         text not null,
  send_after   timestamptz not null,
  sent_at      timestamptz,
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now()
);

create index on messages (lead_id, created_at desc);
create index on outbound_queue (sent_at, send_after) where sent_at is null;
create index on conversion_events (sent_to_meta) where sent_to_meta = false;
```

### Stage values

`new` → `engaged` → `qualified` → `trial_booked` → `trial_completed` → `enrolled`
Terminal: `lost`, `unqualified`, `human_handling`

Stage is advanced only by an explicit tool call from the model, never inferred by string matching.

---

## 3. The webhook

Single endpoint: `POST /api/webhook` and `GET /api/webhook`.

### 3.1 GET — verification handshake

Meta calls this once when you register the webhook.

```
GET /api/webhook?hub.mode=subscribe&hub.verify_token=XXX&hub.challenge=YYY
```

If `hub.mode === 'subscribe'` and `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN`, return `hub.challenge` as plain text with status 200. Otherwise 403.

### 3.2 POST — signature verification

Meta sends `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the **raw request body** using `META_APP_SECRET`.

You must read the raw body before any JSON parsing. On Vercel this means disabling the default body parser for this route. Compare using a timing-safe comparison. Reject with 401 on mismatch.

This is not optional. The endpoint is public and anything that reaches it will be sent to a real parent's phone.

### 3.3 POST — response discipline

```
1. Verify signature
2. Parse body
3. Persist the raw payload
4. Return 200 immediately
5. Process asynchronously
```

Never `await` the Claude call before responding. If processing takes longer than Meta's timeout, Meta retries and the lead gets the answer twice.

Vercel serverless functions die when the response is sent, so use one of:
- `waitUntil()` from `@vercel/functions` (preferred)
- write to `outbound_queue` / a processing table and let a cron route drain it

Pick one and be consistent.

### 3.4 Idempotency

Every WhatsApp message has a unique `id`. Before processing, attempt to insert into `messages` with `wa_message_id` as a unique constraint. If the insert conflicts, the message was already handled — stop, return 200, do nothing else.

Meta will resend the same message. This check is what prevents duplicates.

---

## 4. Event types to handle

The payload shape is `entry[].changes[].value`. Branch on what the `value` object contains.

### 4.1 `value.messages[]` — inbound message from a lead

The main path. For each message:

- `from` is the lead's `wa_id`
- `type` is `text`, `interactive`, `image`, `audio`, `button`, etc.
- `value.contacts[0].profile.name` is the WhatsApp profile name

Handle `text` fully. For `image` / `audio` / `document` in v1: reply with a short line saying Jordi will look at it, set `bot_paused = true`, reason `unsupported_media`, and alert Jordi. Do not attempt transcription or vision in v1.

### 4.2 `value.messages[].referral` — the CTWA click

When a lead arrives from a Click-to-WhatsApp ad, the **first** message carries a `referral` object containing `ctwa_clid`, `source_id` (the ad id), `source_type`, `headline` and `body`.

Persist `ctwa_clid` and `source_id` on the lead row immediately, before any other processing. This value never appears again. Log loudly if a message arrives with a referral and the write fails.

Also pass the ad `headline` into the model's context for the first turn. The lead just tapped that ad; the agent should sound like it knows which offer they responded to.

### 4.3 `value.message_echoes[]` / `smb_message_echoes` — Jordi replied from his phone

This is coexistence. When Jordi types from the WhatsApp Business app on his phone, Meta pushes the message to this webhook as an echo.

On receipt:
1. Find or create the lead by the recipient's `wa_id`
2. Insert the message with `direction = 'outbound_human'`
3. **Set `bot_paused = true`, reason `human_replied`**
4. Cancel any unsent rows in `outbound_queue` for that lead

This is the primary handoff mechanism and it must be reliable. Jordi typing is the signal. There is no command to remember.

**Confirm the exact field name against current Meta docs.** It has appeared as both `message_echoes` and `smb_message_echoes` depending on the onboarding path and API version. Handle whichever your account actually emits, and log any unrecognised `change.field` values so unknown event types surface instead of vanishing.

### 4.4 `value.statuses[]` — delivery receipts

Log them. Do not act on them in v1. `failed` statuses should raise an alert to Jordi.

### 4.5 `account_update` — coexistence lifecycle

If Jordi changes phones or reinstalls the WhatsApp Business app, the Cloud API companion is automatically offboarded and an `ACCOUNT_OFFBOARDED` event fires. Reonboarding usually happens automatically and emits `ACCOUNT_RECONNECTED`.

Log both and alert Jordi on offboard. If this fires and nobody notices, the bot goes silent and nobody knows why.

---

## 5. The agent

### 5.1 Knowledge, not memory

Keep a single `knowledge/business.md` file in the repo. It holds plans, prices, class durations, age ranges, schedule, teacher bio, policies, refund terms, and the answers to the ten most common parent objections.

It is injected verbatim into the system prompt. When Jordi changes a price, he edits that file and redeploys. He does not touch prompt code.

The system prompt must state explicitly: *if the answer is not in the knowledge section or returned by a tool, do not guess — call `escalate_to_human`.*

### 5.2 System prompt structure

Assemble in this order:

1. Identity and role: a member of the LET Junior team, writing in Latin American Spanish
2. The knowledge file, verbatim
3. Conversation rules (§5.3)
4. Current lead context: stage, tags, student name and age if known, and the ad headline if they came from CTWA
5. Current date and time in the lead's likely timezone
6. Tool usage rules

### 5.3 Conversation rules to encode

These exist because the previous system read as a bot and parents stopped replying.

- Write like a person texting, not like a company. Short messages. Lowercase where natural.
- **One question per message.** Never stack two questions.
- Never send a wall of text. If a reply exceeds ~300 characters, it is too long.
- No bullet lists, no emoji walls, no "¡Hola! 👋 Gracias por contactarnos". Never open with a formal greeting block.
- Latin American Spanish, neutral register. No Spain vocabulary (no "vale", no "vosotros").
- Never claim to be human. If asked directly whether this is a bot, say plainly that it's an assistant and that Jordi reads everything personally.
- Do not pitch before understanding. Ask the child's age and current English level before mentioning plans or prices.
- Never repeat a question the parent already answered. The full conversation history is in context; use it.

### 5.4 Message pacing

The single biggest tell of automation is an instant, perfect reply.

- On inbound: mark as read, then show the typing indicator
- Compute delay: `2s + (reply_length_chars × 30ms)`, clamped to 8–45 seconds
- Between split messages in the same burst: 2–5 seconds
- Maximum 2 outbound messages per inbound message. Hard cap, enforced in code, not in the prompt.

Implement via `outbound_queue` with `send_after`, drained by a cron route running every minute. Before sending each row, re-check `bot_paused` — if Jordi jumped in during the delay, drop the queued message.

### 5.5 History assembly

Load the last 30 messages for the lead, oldest first, mapped to `user` / `assistant` roles. Include `outbound_human` messages as `assistant` turns so the agent doesn't contradict what Jordi already said.

If the conversation exceeds 30 messages, summarise the earliest turns into a paragraph and prepend it to the system prompt. Do not silently truncate.

---

## 6. Tools

Six tools. Every one is a real function with real side effects.

### `check_calendar_availability`
In: `date_range_start`, `date_range_end`, optional `preferred_time_of_day`.
Out: up to 5 available slots as human-readable local times.
Reads a Google Calendar free/busy query. Respects Jordi's working hours from config. Never returns a slot less than 12 hours out.

### `book_trial_class`
In: `slot_start_iso`, `student_name`, `student_age`, `parent_name`.
Creates a Google Calendar event, sets lead stage to `trial_booked`, writes a `Schedule` row to `conversion_events`, alerts Jordi.
Re-checks availability before writing. Two parents can book the same slot seconds apart.

### `create_payment_link`
In: `plan_id`.
Out: a Stripe Payment Link URL.
Plan IDs come from config, not from the model. If the model passes an unknown `plan_id`, return an error and let it escalate. The model must never construct a price.

### `escalate_to_human`
In: `reason`, `summary`.
Sets `bot_paused = true`, sends Jordi a WhatsApp message with the lead's name, number and the summary. Tells the lead that Jordi will reply personally shortly.

**Mandatory escalation triggers**, encoded in the prompt and enforced by a keyword pre-check in code:
- any complaint, refund request or dispute
- any price negotiation or discount request
- anything about a child's learning difficulty, disability or wellbeing
- anything the knowledge file does not cover
- a parent who sounds upset

### `update_lead`
In: any of `display_name`, `student_name`, `student_age`, `stage`, `tags`, `notes`.
The only way stage advances. Call it as facts are learned, not in a batch at the end.

### `record_conversion_event`
In: `event_name` (`Lead` | `Purchase`), optional `value`.
Writes to `conversion_events`. Actual transmission to Meta is a separate cron job (§7). `Schedule` is fired automatically by `book_trial_class` and should not be called manually.

Fire `Lead` when the parent has given the child's age and shown real interest — not on the first "hola".

---

## 7. Conversions API (Phase 2)

Separate cron route, every 15 minutes, draining `conversion_events where sent_to_meta = false`.

```
POST https://graph.facebook.com/{version}/{META_DATASET_ID}/events
```

Each event needs:
- `event_name`: `Lead`, `Schedule`, or `Purchase`
- `event_time`: unix seconds
- `action_source`: `business_messaging`
- `messaging_channel`: `whatsapp`
- `user_data.ctwa_clid`: the stored click id
- `custom_data.value` and `custom_data.currency` for `Purchase` (50 USD per student per month)

**If the lead has no `ctwa_clid`** (they came from a lead form, an old conversation, or organic) — skip the event. It cannot be attributed and sending it unattributed pollutes the dataset.

Mark `sent_to_meta = true` on a 200. On failure, increment `attempts`, store the response, retry with backoff, give up after 5 attempts and alert.

Verify events land in Events Manager before trusting anything.

**Do not switch the ad campaign to optimize for `Purchase`.** At current volume there is not enough signal. Campaigns stay optimized for conversations started; these events build attribution history and tell Jordi which creative produced paying students.

---

## 8. Sending messages

All outbound goes through one module: `lib/whatsapp.ts`.

```
POST https://graph.facebook.com/{version}/{WHATSAPP_PHONE_NUMBER_ID}/messages
```

Functions to expose: `sendText`, `markAsRead`, `sendTypingIndicator`, `sendTemplate` (Phase 3).

### The 24-hour window

Free-form messages can only be sent within 24 hours of the lead's last inbound message. Outside it, only approved templates.

Check `last_inbound_at` before every send. If the window has closed, do not attempt a free-form send — Meta will reject it. Log it and alert Jordi. In v1 there is no automatic template follow-up.

CTWA conversations open a longer free-entry-point window. **Verify the current duration and rules in Meta's docs rather than assuming.** Implement the 24-hour check as the conservative default and treat the extended window as an enhancement.

### Rate limiting and retries

Retry on 5xx and on rate-limit errors with exponential backoff, maximum 3 attempts. Never retry a 400 — a malformed message resent 3 times is 3 chances to send garbage to a parent.

---

## 9. Safety, logging, cost

### Kill switch
An environment variable `BOT_ENABLED`. When false, the webhook still records everything but sends nothing. First thing to reach for when something goes wrong in production.

### Per-lead rate limit
Maximum 10 bot messages to any single lead per 24 hours. If exceeded, pause and alert. This is a backstop against a loop that talks to a real parent forever.

### Cost ceiling
Track token usage per conversation. If a single lead exceeds a configurable threshold, escalate to human rather than continuing. Log daily spend.

### Logging
Structured JSON to stdout. Log every inbound event, every model call with token counts, every tool call with arguments and result, every outbound message, every error. Never log the full `META_ACCESS_TOKEN` or Stripe keys.

### Secrets
Environment variables only. Nothing committed. `SUPABASE_SERVICE_ROLE_KEY` is used server-side only and Row Level Security should be on.

---

## 10. Build order

Each milestone must work before the next begins.

**M1 — Plumbing.** Webhook responds to the GET handshake, verifies signatures, persists raw payloads, returns 200 in under a second, deduplicates by message id. No model, no replies.
*Done when:* a real message sent to the number lands in `messages` with the correct lead row, and a replayed payload creates no second row.

**M2 — Capture.** Lead upsert, `ctwa_clid` extraction from the referral object, profile name capture.
*Done when:* a message from a real test CTWA ad lands with `ctwa_clid` populated.

**M3 — Echo handling.** Coexistence echoes recognised, `bot_paused` set, queued messages cancelled.
*Done when:* replying from the phone app sets `bot_paused = true` within seconds.

**M4 — Agent.** Claude call, history assembly, knowledge file, outbound queue, pacing, the 2-message cap.
*Done when:* a full conversation runs end to end in Spanish without the bot repeating itself or sending more than 2 messages per turn.

**M5 — Tools.** Calendar, booking, Stripe link, escalation, lead updates.
*Done when:* a test conversation books a real calendar slot and produces a working payment link.

**M6 — Conversions API.** Cron drain, events visible in Events Manager.
*Done when:* a `Schedule` event from a CTWA-sourced test lead appears in Events Manager with correct attribution.

**Phase 3, later:** template sending for cold leads, re-engagement sequences, media handling.

---

## 11. Testing

- Unit test signature verification with a known-good payload and secret.
- Unit test idempotency by replaying the same payload 5 times.
- Fixture files for every webhook event type: text message, CTWA referral, echo, status, account update.
- A dry-run mode where `sendText` logs instead of calling Meta. Every conversation flow must be exercisable without touching a real phone.
- Do not test against Jordi's production number. Use a Meta test number until M5 passes.

---

## 12. Explicitly out of scope

Do not build: a web dashboard, an admin panel, an inbox UI, authentication, multi-user support, multi-tenancy, an email integration, analytics charts, a Kommo migration script, voice note transcription, image understanding, or a conversation-quality scoring system.

The Supabase table editor is the monitoring surface for v1. Jordi's phone is the inbox.

If a feature is not in this document, ask before building it.

---

## 13. Verify before building

These details change and this document will age. Confirm against current Meta documentation before writing code:

1. Current Graph API version.
2. The exact coexistence echo field name and payload shape for this account.
3. Whether the number can be onboarded to coexistence at all — it may currently be bound to another provider and need offboarding first. **This blocks everything; check it first.**
4. Current free-entry-point window duration for CTWA conversations.
5. Current Conversions API for Business Messaging payload requirements.
6. WhatsApp Business Platform policy on automated agents, to confirm this use case remains permitted.

One operational constraint to respect: coexistence requires the WhatsApp Business app to be opened on the phone at least once every 13 days, or the account goes inactive.
