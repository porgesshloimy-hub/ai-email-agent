-- AI Email Agent — core schema
-- Isolation model: every tenant-owned table carries tenant_id and is protected by RLS.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────
-- Tenants (one per customer account/business)
-- ─────────────────────────────────────────────
create table tenants (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  business_name text not null,
  business_description text,             -- "We are a plumbing company in Brooklyn."
  phone_number text,                     -- for Twilio SMS notifications
  timezone text not null default 'UTC',  -- IANA zone, e.g. 'America/New_York' (migration 007)
  stripe_customer_id text,               -- set once the tenant connects billing; null until then
  stripe_subscription_item_id text,      -- the metered subscription item usage is reported against
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- Gmail connections (OAuth tokens, encrypted at rest)
-- ─────────────────────────────────────────────
create table gmail_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  gmail_address text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  token_expiry timestamptz not null,
  history_id text,                       -- last Gmail history id processed (for Pub/Sub sync)
  watch_expiry timestamptz,              -- Gmail watch() expires ~7 days, must be renewed
  connected_at timestamptz not null default now(),
  unique (tenant_id)
);

-- ─────────────────────────────────────────────
-- Agent configuration: instructions + rules (free text/structured, model-facing)
-- ─────────────────────────────────────────────
create table agent_configs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  custom_instructions text,              -- "Automatically answer basic pricing questions."
  rules jsonb not null default '[]',     -- [{ "description": "Refund requests always require approval" }]
  -- Which AI provider/model powers this tenant's agent (lib/agent/run.ts,
  -- lib/agent/chat.ts). Selectable on the Agent dashboard; validated
  -- against the catalog in lib/agent/models.ts. See migration 005.
  ai_provider text not null default 'openai'
    check (ai_provider in ('openai', 'anthropic', 'mistral')),
  ai_model text not null default 'gpt-5-nano',
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

-- ─────────────────────────────────────────────
-- Permissions: the enforcement matrix (backend reads this, not the model)
-- ─────────────────────────────────────────────
create type permission_level as enum ('denied', 'approval_required', 'allowed');

create table agent_permissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  action text not null,                  -- 'gmail.read' | 'gmail.draft' | 'gmail.send' | 'gmail.archive' | 'gmail.delete' | 'calendar.read' | 'calendar.write'
  level permission_level not null default 'approval_required',
  unique (tenant_id, action)
);

-- ─────────────────────────────────────────────
-- Knowledge documents + chunks (pgvector)
-- ─────────────────────────────────────────────
create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  file_name text not null,
  storage_path text not null,            -- path in Supabase Storage
  uploaded_at timestamptz not null default now()
);

create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  document_id uuid not null references knowledge_documents(id) on delete cascade,
  content text not null,
  embedding vector(1536) not null,       -- text-embedding-3-small
  created_at timestamptz not null default now()
);

create index knowledge_chunks_embedding_idx on knowledge_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ─────────────────────────────────────────────
-- Agent memory (durable facts the agent has learned per tenant)
-- ─────────────────────────────────────────────
create table agent_memories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- Email threads the agent has processed
--
-- 'processing' — set when a message is reserved, before the agent has
--   finished (lib/agent/run.ts, RESERVE THE MESSAGE).
-- 'failed' — set when agent processing throws (lib/agent/run.ts,
--   FAILURE HANDLING).
-- ─────────────────────────────────────────────
create type email_action_status as enum (
  'processed',
  'pending_approval',
  'approved',
  'rejected',
  'sent',
  'processing',
  'failed'
);

create table email_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  gmail_thread_id text not null,
  gmail_message_id text,
  action_type text not null,             -- 'draft_reply' | 'archive' | 'escalate' | 'calendar_event' | 'calendar_proposal' | 'processing' etc.
  status email_action_status not null default 'pending_approval',
  gmail_draft_id text,                   -- Gmail's draft id, needed to send it on approval
  draft_content text,
  reasoning text,                        -- why the agent decided this (audit trail)
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Enforces the idempotency guarantee lib/agent/run.ts relies on: the
-- message-reservation insert catches Postgres error 23505 to detect a
-- concurrent duplicate reservation of the same Gmail message. Partial
-- index because gmail_message_id is nullable.
create unique index email_actions_tenant_message_unique
  on email_actions (tenant_id, gmail_message_id)
  where gmail_message_id is not null;

-- ─────────────────────────────────────────────
-- Approvals — human-in-the-loop queue for actions requiring sign-off.
--
-- action_type / action_id are polymorphic (action_id points at either
-- an email_actions row or a calendar_actions row depending on
-- action_type), so action_id is a plain uuid rather than a foreign key
-- to either table specifically.
-- ─────────────────────────────────────────────
create table approvals (
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

create index approvals_tenant_status_idx
  on approvals (tenant_id, status);

-- ─────────────────────────────────────────────
-- Calendar actions — created or proposed calendar events.
-- ─────────────────────────────────────────────
create table calendar_actions (
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
-- Usage events — billable usage, metered per lib/billing/meter.ts.
--
-- billed_cost_usd = raw_cost_usd * 1.05 (applyMarkup() in
-- lib/billing/meter.ts). Reported to Stripe's Billing Meters API in
-- cents; stripe_reported flips to true once that succeeds, and
-- reconcileUnreportedUsage() retries rows where it's still false.
-- ─────────────────────────────────────────────
create table usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  service text not null,                 -- 'openai' | 'twilio_sms' | 'storage' | 'other'
  description text,
  quantity numeric not null,
  unit text not null,                    -- 'tokens' etc.
  raw_cost_usd numeric not null,
  billed_cost_usd numeric not null,
  stripe_reported boolean not null default false,
  created_at timestamptz not null default now()
);

create index usage_events_tenant_unreported_idx
  on usage_events (tenant_id)
  where stripe_reported = false;

-- ─────────────────────────────────────────────
-- Row Level Security — tenant isolation
-- ─────────────────────────────────────────────
alter table tenants enable row level security;
alter table gmail_connections enable row level security;
alter table agent_configs enable row level security;
alter table agent_permissions enable row level security;
alter table knowledge_documents enable row level security;
alter table knowledge_chunks enable row level security;
alter table agent_memories enable row level security;
alter table email_actions enable row level security;
alter table approvals enable row level security;
alter table calendar_actions enable row level security;
alter table usage_events enable row level security;

create policy "owner can access own tenant" on tenants
  for all using (owner_user_id = auth.uid());

-- Generic pattern for tenant-scoped tables: join through tenants.owner_user_id
create policy "owner can access own gmail_connections" on gmail_connections
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own agent_configs" on agent_configs
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own agent_permissions" on agent_permissions
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own knowledge_documents" on knowledge_documents
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own knowledge_chunks" on knowledge_chunks
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own agent_memories" on agent_memories
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own email_actions" on email_actions
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own approvals" on approvals
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own calendar_actions" on calendar_actions
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

create policy "owner can access own usage_events" on usage_events
  for all using (tenant_id in (select id from tenants where owner_user_id = auth.uid()));

-- Note: background jobs (Inngest) run with the Supabase service_role key,
-- which bypasses RLS by design — tenant scoping in that path is enforced
-- in application code (lib/agent/*), always filtering by tenant_id explicitly.