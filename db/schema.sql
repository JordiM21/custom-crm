-- LET Junior — WhatsApp AI Sales Agent
-- Run this once in Supabase → SQL Editor → New query → Run.
-- Safe to re-run: every statement is guarded.

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- leads — one row per parent who has ever written to the business number
-- -----------------------------------------------------------------------------
create table if not exists leads (
  id                uuid primary key default gen_random_uuid(),
  wa_id             text unique not null,        -- phone, international format, no +
  profile_name      text,                        -- name from the WhatsApp profile
  display_name      text,                        -- name the parent actually gives us
  student_name      text,
  student_age       int,
  stage             text not null default 'new',
  tags              text[] default '{}',
  ctwa_clid         text,                        -- CRITICAL: captured on first message only
  ctwa_source_id    text,
  ctwa_headline     text,
  ctwa_captured_at  timestamptz,
  bot_paused        boolean not null default false,
  bot_paused_reason text,
  bot_paused_at     timestamptz,
  first_contact_at  timestamptz not null default now(),
  last_message_at   timestamptz,
  last_inbound_at   timestamptz,                 -- drives the 24h window check
  notes             text,
  cost_usd          numeric not null default 0,  -- cumulative model spend for this lead
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- messages — full transcript, both directions
-- -----------------------------------------------------------------------------
create table if not exists messages (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid references leads(id) on delete cascade,
  wa_message_id text unique,                     -- idempotency key
  direction     text not null,                   -- inbound | outbound_bot | outbound_human
  body          text,
  raw           jsonb,
  created_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- conversion_events — Meta Conversions API queue (sent by M6)
-- -----------------------------------------------------------------------------
create table if not exists conversion_events (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid references leads(id) on delete cascade,
  event_name    text not null,                   -- Lead | Schedule | Purchase
  value         numeric,
  currency      text default 'USD',
  ctwa_clid     text,
  sent_to_meta  boolean not null default false,
  meta_response jsonb,
  attempts      int not null default 0,
  created_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- outbound_queue — every bot message waits here so pacing looks human
-- -----------------------------------------------------------------------------
create table if not exists outbound_queue (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references leads(id) on delete cascade,
  body        text not null,
  send_after  timestamptz not null,
  sent_at     timestamptz,
  cancelled_at timestamptz,
  attempts    int not null default 0,
  last_error  text,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- app_settings — key/value flags the admin panel can flip without a redeploy.
--
-- DEVIATION FROM SPEC §2 (four tables): the spec puts the kill switch in an
-- environment variable only. CLAUDE.md requires the admin page to own a kill
-- switch, and a non-technical operator cannot flip a Vercel env var and wait
-- for a redeploy during an incident. The env var still wins when set to false.
-- -----------------------------------------------------------------------------
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
create index if not exists messages_lead_created_idx
  on messages (lead_id, created_at desc);

create index if not exists outbound_queue_pending_idx
  on outbound_queue (send_after)
  where sent_at is null and cancelled_at is null;

create index if not exists conversion_events_pending_idx
  on conversion_events (created_at)
  where sent_to_meta = false;

create index if not exists leads_stage_idx on leads (stage);
create index if not exists leads_last_message_idx on leads (last_message_at desc nulls last);

-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- Every query in this service runs server-side with the service role key, which
-- bypasses RLS. Turning RLS on with no policies means the anon/public key can
-- read nothing, which is exactly what we want: the data is only reachable
-- through our own API routes.
-- -----------------------------------------------------------------------------
alter table leads             enable row level security;
alter table messages          enable row level security;
alter table conversion_events enable row level security;
alter table outbound_queue    enable row level security;
alter table app_settings      enable row level security;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists leads_touch_updated_at on leads;
create trigger leads_touch_updated_at
  before update on leads
  for each row execute function touch_updated_at();
