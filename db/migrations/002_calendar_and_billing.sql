-- Migration 002: Calendar access + usage-based billing
-- Run this in the Supabase SQL Editor against your existing project.

-- ─────────────────────────────────────────────
-- Calendar: mark whether the existing Google connection also has
-- calendar scopes granted. Reuses the same OAuth token as Gmail — Google
-- issues one token per consent grant covering every scope requested at
-- that time, so no separate connection/token table is needed.
-- ─────────────────────────────────────────────
alter table gmail_connections
  add column if not exists calendar_scope_granted boolean not null default false;

-- Cache of calendar event ids the agent has created, so it can look them up
-- to update/cancel later without a separate Google API round trip just to
-- find the event id again.
create table if not exists calendar_events_cache (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  google_event_id text not null,
  summary text,
  start_time timestamptz,
  end_time timestamptz,
  created_by text not null default 'agent',   -- 'agent' | 'owner'
  created_at timestamptz not null default now(),
  unique (tenant_id, google_event_id)
);

alter table calendar_events_cache enable row level security;

create policy "owner can access own calendar_events_cache" on calendar_events_cache
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

-- Approval queue for calendar writes the agent isn't allowed to make
-- autonomously — the calendar equivalent of email_actions' pending_approval
-- rows. There's no "draft" concept for calendar events, so a proposed event
-- sits here until the owner confirms or dismisses it from the dashboard.
create table if not exists calendar_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  action_type text not null,             -- 'create_event' | 'update_event' | 'delete_event'
  status email_action_status not null default 'pending_approval',  -- reuses the same status enum as email_actions
  proposed_summary text,
  proposed_start timestamptz,
  proposed_end timestamptz,
  google_event_id text,                  -- set once created, or the target event for update/delete
  reasoning text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table calendar_actions enable row level security;

create policy "owner can access own calendar_actions" on calendar_actions
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

-- ─────────────────────────────────────────────
-- Billing: Stripe linkage + configurable markup per tenant
-- ─────────────────────────────────────────────
alter table tenants
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_item_id text,   -- the metered subscription item usage gets reported against
  add column if not exists usage_markup_percent numeric(5,2) not null default 3.00;  -- e.g. 3.00 = +3%

-- ─────────────────────────────────────────────
-- Usage events: one row per billable unit of work, across every metered
-- service. Costs are stored in USD with high precision (numeric, not
-- float) since these get summed and multiplied by a markup.
-- ─────────────────────────────────────────────
create type usage_service as enum ('openai', 'twilio_sms', 'storage', 'other');

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  service usage_service not null,
  description text,                       -- e.g. "gpt-4o completion, thread abc123"
  quantity numeric(14,4) not null,         -- e.g. tokens, SMS segments, MB stored
  unit text not null,                      -- e.g. "tokens", "sms_segment", "mb"
  raw_cost_usd numeric(14,6) not null,     -- actual cost from the provider, no markup
  billed_cost_usd numeric(14,6) not null,  -- raw_cost_usd with markup applied — what gets reported to Stripe
  stripe_reported boolean not null default false,
  occurred_at timestamptz not null default now()
);

create index if not exists usage_events_tenant_period_idx
  on usage_events (tenant_id, occurred_at);

alter table usage_events enable row level security;

create policy "owner can view own usage_events" on usage_events
  for select using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

-- Note: usage_events is written exclusively by server-only code using the
-- service-role client (see lib/billing/meter.ts) — there's intentionally
-- no insert/update policy for regular users, only a read policy so owners
-- can see their own usage in the dashboard.
