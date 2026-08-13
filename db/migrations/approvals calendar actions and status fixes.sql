-- Migration: close the gaps between schema.sql and what the agent code
-- (lib/agent/run.ts, lib/inngest/functions.ts) actually reads and writes.
--
-- Rename/renumber this file to match your existing db/migrations/
-- sequence, and fold the same changes into db/schema.sql once applied,
-- since schema.sql is apparently already out of sync with what's
-- shipped (this migration exists because of that drift).

-- ─────────────────────────────────────────────
-- 1. email_action_status: add the two values the code actually writes.
--
-- 'processing' — set when a message is reserved, before the agent has
--   finished (lib/agent/run.ts, RESERVE THE MESSAGE).
-- 'failed' — set when agent processing throws (lib/agent/run.ts,
--   FAILURE HANDLING). Without this value, that update fails, and a
--   failed email_actions row is stuck at 'processing' forever.
--
-- Postgres allows adding enum values outside a transaction block:
-- ALTER TYPE ... ADD VALUE cannot run inside the same transaction as
-- a later statement that uses the new value, so these are run as
-- standalone statements.
-- ─────────────────────────────────────────────

alter type email_action_status add value if not exists 'processing';
alter type email_action_status add value if not exists 'failed';

-- ─────────────────────────────────────────────
-- 2. email_actions: enforce the uniqueness the idempotency guard
--    assumes exists.
--
-- lib/agent/run.ts inserts a reservation row and relies on catching
-- Postgres error 23505 (unique_violation) to detect a concurrent
-- duplicate reservation of the same Gmail message. Without an actual
-- unique index, two concurrent Inngest runs can both reserve the same
-- message and both take action on it.
--
-- gmail_message_id is nullable, so this is a partial unique index —
-- it only applies where a message id is actually present.
-- ─────────────────────────────────────────────

create unique index if not exists email_actions_tenant_message_unique
  on email_actions (tenant_id, gmail_message_id)
  where gmail_message_id is not null;

-- ─────────────────────────────────────────────
-- 3. approvals
--
-- action_type / action_id are polymorphic (they point at either an
-- email_actions row or a calendar_actions row depending on
-- action_type), so action_id is a plain uuid rather than a foreign key
-- to either table specifically.
-- ─────────────────────────────────────────────

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  action_type text not null,             -- 'gmail.send' | 'calendar.create' etc.
  action_id uuid not null,               -- references email_actions.id or calendar_actions.id, depending on action_type
  status text not null default 'pending', -- 'pending' | 'approved' | 'rejected' | 'expired'
  description text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists approvals_tenant_status_idx
  on approvals (tenant_id, status);

-- ─────────────────────────────────────────────
-- 4. calendar_actions
-- ─────────────────────────────────────────────

create table if not exists calendar_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  action_type text not null default 'create_event',
  status text not null default 'pending_approval',  -- 'pending_approval' | 'sent' | 'rejected'
  proposed_summary text,
  proposed_start timestamptz,
  proposed_end timestamptz,
  google_event_id text,                  -- set once the event actually exists in Google Calendar
  reasoning text,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 5. usage_events — confirmed against lib/billing/meter.ts.
--
-- recordUsage() inserts tenant_id, service, description, quantity,
-- unit, raw_cost_usd, AND billed_cost_usd (raw_cost_usd * 1.05,
-- computed in applyMarkup()) — billed_cost_usd was missing from the
-- first pass at this table. reconcileUnreportedUsage() later selects
-- "id, billed_cost_usd" and reportUsageToStripe() reports that
-- billed amount (in cents) to Stripe, then flips stripe_reported.
-- ─────────────────────────────────────────────

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  service text not null,                 -- 'openai' | 'twilio_sms' | 'storage' | 'other'
  description text,
  quantity numeric not null,
  unit text not null,                    -- 'tokens' etc.
  raw_cost_usd numeric not null,
  billed_cost_usd numeric not null,      -- raw_cost_usd * 1.05, computed in lib/billing/meter.ts applyMarkup()
  stripe_reported boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_tenant_unreported_idx
  on usage_events (tenant_id)
  where stripe_reported = false;

-- ─────────────────────────────────────────────
-- 5b. tenants: add the Stripe linkage columns lib/billing/meter.ts
-- reads (select("stripe_customer_id, stripe_subscription_item_id")
-- in recordUsage(), select("stripe_customer_id") in
-- reconcileUnreportedUsage()). Neither exists on tenants today.
-- Nullable — a tenant with no Stripe connection yet is expected
-- (recordUsage() no-ops the Stripe report, keeping the usage_events
-- row locally, when stripe_customer_id is absent).
-- ─────────────────────────────────────────────

alter table tenants add column if not exists stripe_customer_id text;
alter table tenants add column if not exists stripe_subscription_item_id text;

-- ─────────────────────────────────────────────
-- 6. RLS — same owner-scoped pattern as every other tenant table.
-- Service-role background jobs (Inngest) bypass RLS as documented in
-- schema.sql; these policies are for the dashboard's direct queries.
-- ─────────────────────────────────────────────

alter table approvals enable row level security;
alter table calendar_actions enable row level security;
alter table usage_events enable row level security;

create policy "owner can access own approvals" on approvals
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own calendar_actions" on calendar_actions
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own usage_events" on usage_events
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));