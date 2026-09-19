# LET Junior — WhatsApp AI Sales Agent

A service that answers WhatsApp messages from parents in Spanish, qualifies
them, books trial classes, sends payment links, and hands the conversation to
Jordi the moment a human is needed.

Built to `SPEC.md`, milestones M1 through M5. **Nothing is connected to a real
account yet.** Everything below is what you do to connect it.

---

## Read this first: what actually exists right now

| Part | State |
|---|---|
| Webhook, signature check, deduplication | Done, tested |
| Lead capture and ad attribution (`ctwa_clid`) | Done, tested |
| Handoff when you reply from your phone | Done, tested |
| The agent: prompt, history, pacing, 2-message cap | Done, tested |
| The six tools: calendar, booking, Stripe, escalation, lead updates, tracking | Done, tested |
| Admin panel | Done |
| Sending conversions to Meta (M6) | **Not built.** Events are recorded and wait in the database. |
| Template messages for cold leads, voice notes, images | **Not built.** Out of scope for v1. |

103 automated tests pass. What is *not* tested is anything touching a real
account, because there are no real accounts yet.

**Right now the system runs in demo mode:** fake database, fake AI replies,
nothing sent to WhatsApp. That is deliberate. You can open the panel and use it
today, and each thing you connect switches a piece from fake to real.

---

## See it running in two minutes

```bash
npm install
npm run dev:local
```

Open <http://localhost:3000>. You get the panel with eight invented contacts and
their conversations. Nothing you do there touches a real phone.

---

# What to do next, in order

Do these in order. Each one says what breaks if you skip it. The panel's
**Conexiones** page shows the same list, live, so you can always see where you
are without reading this file again.

**Never send me a password, key or token in a chat message.** Every secret goes
straight into Vercel. When a step is done, just tell me "step 3 done".

---

## Step 0 — The blocker: can your number even be used?

**Do this before anything else.** Everything depends on it.

Your WhatsApp number may currently be tied to another provider (Kommo, or
whatever you used before). A number can only be connected to one platform at a
time. If it is tied elsewhere, it has to be released before Meta's Cloud API can
use it.

What to check, in [business.facebook.com](https://business.facebook.com) →
WhatsApp Accounts:

1. Is your number listed there?
2. Is it connected to another provider (a "BSP")?
3. Does Meta offer you the **coexistence** option for it? Coexistence is what
   lets you keep using the WhatsApp Business app on your phone *and* have this
   service answer at the same time. It is the whole design of this system.

**Tell me what you find.** If the number is locked to another provider, that is
the first thing to solve and no other step matters until it is done.

One rule to remember forever: with coexistence, **you must open the WhatsApp
Business app on your phone at least once every 13 days** or the connection goes
inactive.

---

## Step 1 — Put it online (Vercel)

1. Go to [vercel.com](https://vercel.com), sign in with GitHub.
2. **Add New → Project**, pick `JordiM21/custom-crm`.
3. Framework preset: **Other**. Don't change anything else.
4. Deploy.

You get a URL like `https://custom-crm-xxxx.vercel.app`. The panel is at that
URL. It still runs on demo data.

Then set the first two variables, in **Settings → Environment Variables**:

| Variable | Value |
|---|---|
| `ADMIN_PASSWORD` | A long password you invent. This is what opens the panel. |
| `SESSION_SECRET` | Any long random string. |

After adding variables you must **Deployments → ⋯ → Redeploy** for them to take
effect. That is true for every step below.

**If you skip this:** the panel is open to anyone who finds the URL.

**Send me:** the Vercel URL.

---

## Step 2 — The database (Supabase)

Without this, every contact and conversation disappears on each deploy.

1. [supabase.com](https://supabase.com) → new project. Free tier is enough.
   Pick a region close to Latin America (`us-east-1` is fine).
2. Wait for it to finish provisioning.
3. Left menu → **SQL Editor** → **New query**.
4. Open `db/schema.sql` from this repo, copy all of it, paste, **Run**.
   It should say success. It is safe to run twice.
5. Left menu → **Project Settings → API**. Copy two things:

| Variable | Where it is in Supabase |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → `service_role` key (**secret**, never put it in a browser or a message) |

6. Put both in Vercel, redeploy.

The panel stops saying "datos de ejemplo" and goes empty. That is correct: it is
now showing your real data, and you have none yet.

**If you skip this:** nothing is ever saved.

---

## Step 3 — The AI provider

**No provider is chosen yet, and the code does not care which one you pick.**
Everything the model does goes through one small interface (`lib/ai/`) with
three adapters. You switch providers with one environment variable and no code
change.

### Option A — Anthropic (Claude)

```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5
```

Key from [console.anthropic.com](https://console.anthropic.com) → API Keys.

### Option B — anything that speaks the OpenAI format

This covers OpenAI, Groq, Together, OpenRouter, Mistral, DeepSeek, Fireworks
and most self-hosted servers.

```
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1     # or the provider's URL
AI_API_KEY=...
AI_MODEL=gpt-4o-mini                       # whatever model you picked
```

### Option C — decide later

Leave `AI_PROVIDER=mock`. The bot replies with fixed demo sentences. Everything
else works. Useful for testing the plumbing without paying anyone.

### Cost control

```
AI_COST_CEILING_USD=1.00     # one conversation costs more than this -> it goes to you
AI_PRICE_IN_PER_MTOK=3       # set these from your provider's pricing page
AI_PRICE_OUT_PER_MTOK=15     # they are only used to estimate spend
```

The price defaults are deliberately high, so an unconfigured deployment
over-estimates what it is spending and hands conversations to you early rather
than running up a bill quietly.

**If you skip this:** the bot answers with demo sentences, not real answers.

**Tell me:** which provider you chose. I do not need the key.

---

## Step 4 — WhatsApp (Meta)

This is the longest step. Do Step 0 first.

### 4a. Create the app

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps** →
   **Create App** → type **Business**.
2. In the app, add the **WhatsApp** product.
3. Connect your Business portfolio and your phone number.

### 4b. Collect four values

| Variable | Where |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → "Phone number ID" (a number, **not** your phone number) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Same page, "WhatsApp Business Account ID" |
| `META_ACCESS_TOKEN` | Business Settings → Users → **System Users** → create one with admin access → Generate token → select your app → permissions `whatsapp_business_messaging` and `whatsapp_business_management`. Choose **never expires**. A temporary token will work for a day and then break silently. |
| `META_APP_SECRET` | App Settings → Basic → App Secret → Show |

Plus one you invent yourself:

| Variable | Value |
|---|---|
| `META_WEBHOOK_VERIFY_TOKEN` | Any random string. You type it into Meta in the next step, and Meta sends it back to prove it is really them. |

Put all five in Vercel and redeploy.

### 4c. Point Meta at the webhook

1. In the app → WhatsApp → **Configuration** → Webhooks → Edit.
2. Callback URL: `https://YOUR-VERCEL-URL/api/webhook`
3. Verify token: the `META_WEBHOOK_VERIFY_TOKEN` you invented.
4. Click **Verify and save**. It must go green. If it does not, the token does
   not match or the redeploy did not happen.
5. Subscribe to these fields:
   - `messages` — required
   - `message_echoes` **and/or** `smb_message_echoes` — subscribe to whichever
     ones your account shows. This is how the bot knows you replied from your
     phone. Without it the bot will talk over you.
   - `account_update` — tells you if WhatsApp disconnects the number

### 4d. Check the Graph API version

`META_GRAPH_VERSION` defaults to `v23.0`. Check
[Meta's changelog](https://developers.facebook.com/docs/graph-api/changelog)
for the current version and set it. Do not trust the number written here — it
ages.

### 4e. Your own number, for alerts

| Variable | Value |
|---|---|
| `OWNER_WHATSAPP_NUMBER` | Your personal number, international format, no `+` and no spaces. Example: `573001112233`. |

One thing to know: Meta applies the same 24-hour rule to your own number. If
you have not written to the business number in a day, these alerts get rejected.
**The admin panel is the reliable place to see what needs you.** WhatsApp alerts
are the convenient extra.

**If you skip this step:** the bot cannot receive or send anything.

---

## Step 5 — Tell the bot about your business

**This is the one only you can do, and it decides whether the bot sounds like
you or like a bot.**

Open `knowledge/business.md`. Everything between `«these marks»` is a blank for
you to fill in: plans, prices, class length, ages, schedule, your bio, refund
policy, and your answer to each of the ten objections you actually hear.

Write it the way you would say it to a parent. That file is injected into the
prompt word for word.

**While any blank is left, the bot is not allowed to quote a price, a schedule
or a policy.** It will greet parents, ask the child's age, and hand everything
else to you. That is on purpose: without it the bot would read
`«USD ___ al mes»` aloud to a parent as though it were a price.

Two ways to do it:
- Edit the file on GitHub directly and commit. Vercel redeploys automatically.
- Or write it out and send it to me, and I will put it in.

To change a price later: edit that file, commit, redeploy. You never touch code.

**If you skip this:** the bot can start conversations but cannot close them.

---

## Step 6 — Google Calendar (trial class booking)

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **Credentials → Create credentials → Service account**. Create it, then open
   it → **Keys → Add key → JSON**. A file downloads.
4. Open [calendar.google.com](https://calendar.google.com) → your calendar →
   Settings → **Share with specific people** → add the service account's email
   (it looks like `something@project.iam.gserviceaccount.com`) with permission
   **"Make changes to events"**. Without this the service account can see
   nothing.
5. Encode the JSON file into one line:
   ```bash
   base64 -w0 your-service-account.json     # Linux
   base64 -i your-service-account.json      # Mac
   ```

| Variable | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The base64 output from above |
| `GOOGLE_CALENDAR_ID` | Calendar settings → "Integrate calendar" → Calendar ID. Usually your email. |
| `BOOKING_TIMEZONE` | e.g. `America/Bogota` |
| `BOOKING_HOURS_START` | First hour you teach, 24h clock. e.g. `14` |
| `BOOKING_HOURS_END` | Last hour, e.g. `20` |

The bot never offers a slot less than 12 hours away, and re-checks the calendar
immediately before booking, because two parents can accept the same slot
seconds apart.

**If you skip this:** the bot cannot offer times. It hands those parents to you.

---

## Step 7 — Stripe (payment links)

1. [dashboard.stripe.com](https://dashboard.stripe.com) → **Developers → API
   keys** → Secret key. Use a **test** key first.
2. **Products** → create one product per plan → inside it, copy the **price ID**
   (starts with `price_`).
3. Open `config/plans.json` and paste each price ID next to its plan. Commit.

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` at first, `sk_live_...` when you are ready |

The bot can only send a link for a plan that exists in that file. It is
incapable of inventing a price: if it tries an unknown plan, the tool returns an
error and the conversation goes to you.

**If you skip this:** the bot cannot send payment links. It hands those parents
to you.

---

## Step 8 — Going live

Until now `ENVIRONMENT=development` means **nothing is ever sent to a real
phone**; every message is written to the log instead. Test everything in that
mode first.

Test with a Meta test number, never with your production number, until you have
seen a full conversation work end to end.

When you are ready:

```
ENVIRONMENT=production
BOT_ENABLED=true
CRON_SECRET=<any long random string>
```

Redeploy. The bot is now live.

**The kill switch:** the toggle at the top right of the panel stops the bot
immediately, with no redeploy. Messages keep being recorded; nothing is sent.
That is the first thing to reach for if something goes wrong. `BOT_ENABLED=false`
in Vercel is the stronger version: it forces the bot off and the panel cannot
override it.

---

# What I need from you next

Ordered by what unblocks the most work:

1. **The answer to Step 0.** Can your number be onboarded to coexistence, or is
   it locked to another provider? Nothing else matters until this is known.
2. **`knowledge/business.md`, filled in.** Prices, plans, schedule, policies,
   your ten objections, in your words, in Spanish. Send it as text and I will
   put it in, or edit it on GitHub yourself.
3. **Which AI provider you picked.** Not the key, just the name.
4. **Your Vercel URL,** once Step 1 is done.
5. **Your plan structure**: how many plans, what each includes, what each costs.
   I need this for `config/plans.json`.
6. **Anything that failed.** A screenshot of the panel's Conexiones page tells
   me almost everything.

Secrets go in Vercel, never in a message to me.

---

# How it works, briefly

A parent writes → Meta calls `/api/webhook` → we check the signature, save the
message, and **answer Meta within a second**, because Meta retries anything
slower and a retry would mean the parent gets the same reply twice.

Then, in the background: if this is their first message from an ad, the click id
is saved (it appears once and never again — it is what lets Meta tell you which
ad produced a paying student). The conversation so far is sent to the AI
provider along with your business file. The reply goes into a queue with a
delay of 8 to 45 seconds, because an instant perfect answer is the clearest
sign a parent is talking to software.

Before each queued message is actually sent, the system re-checks: did Jordi
reply from his phone in the meantime? Did the 24-hour window close? Is the kill
switch off? Has this parent already had 10 bot messages today? Any of those and
the message is dropped rather than sent.

**When you reply from your phone, the bot goes silent for that parent.** Meta
echoes your message to us and that is the signal. There is no command to
remember. Reactivate from the panel when you want the bot to take over again.

Some things never reach the model at all. A parent asking for a discount, a
refund, or mentioning a child's learning difficulty goes straight to you — that
is a keyword check in code, not a suggestion in the prompt, because those are
the conversations where being wrong costs a customer or hurts a child.

---

# Day to day

- **The panel is the dashboard.** Contacts in red ("Te toca a ti") need you.
- **Answer from your phone as normal.** The bot steps aside automatically.
- **Changing a price:** edit `knowledge/business.md`, commit, redeploy.
- **Something feels wrong:** flip the switch off. Diagnose afterwards.
- **Every 13 days:** open the WhatsApp Business app on your phone, or the
  coexistence connection goes inactive.

---

# When something breaks

| What you see | What it means |
|---|---|
| Panel says "datos de ejemplo" | Supabase is not connected. Step 2. |
| Meta webhook won't verify | `META_WEBHOOK_VERIFY_TOKEN` doesn't match, or you didn't redeploy after setting it. |
| Messages arrive but nothing is answered | Bot switched off, or no AI provider, or the lead is paused. The panel says which. |
| The bot replies *over* you | You are not subscribed to the echo fields. Step 4c. |
| "Pasaron más de 24 horas" | WhatsApp only allows free messages within 24h of the parent's last message. You have to write first. |
| A contact suddenly paused itself | Either you replied from your phone, or it hit the 10-messages-per-day cap, or it escalated. The panel says which in plain words. |
| Bot went completely silent | Check for an `ACCOUNT_OFFBOARDED` alert — changing phones or reinstalling the WhatsApp Business app disconnects the API. |

---

# For a developer

```bash
npm install
npm test          # 103 tests, no network, no accounts needed
npm run typecheck
npm run dev:local # panel + API at localhost:3000, no Vercel needed
```

Layout:

```
api/          HTTP entry points (webhook, cron, admin)
lib/ai/       provider interface + anthropic, openai-compatible, mock adapters
lib/agent/    prompt, history, pacing, tools, escalation
lib/store/    Store interface + supabase and in-memory drivers
lib/meta/     webhook payload types, signature verification
public/       the admin panel
knowledge/    business.md — the only file Jordi edits
config/       plans.json
db/schema.sql
fixtures/     one payload per webhook event type
tests/
```

Two deliberate deviations from `SPEC.md`, both documented where they are made:

- **A fifth table, `app_settings`**, so the panel's kill switch works without a
  redeploy. The spec puts the kill switch in an env var only; a non-technical
  operator cannot wait for a build during an incident. The env var still wins.
- **The webhook drains its own queue** instead of relying only on the cron
  route, because Vercel's free plan runs cron jobs once a day, which would leave
  every reply stuck for hours. The cron remains the safety net.

Still to build: **M6**, sending conversion events to Meta's Conversions API.
The events are already recorded in `conversion_events` with their click ids and
are waiting to be drained. Leads with no click id are skipped by design —
sending them unattributed pollutes the dataset.
