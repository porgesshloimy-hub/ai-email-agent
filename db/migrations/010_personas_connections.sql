-- Migration 010: Agent personas, generalized connections, owner-directed
-- action audit, and multi-channel owner reachability.
-- Run this in the Supabase SQL Editor against your existing project,
-- after migration 009 has already been applied.
-- Idempotent: safe to run more than once (if not exists / drop-then-create
-- for policies).

-- ─────────────────────────────────────────────
-- Agent personas — Secretary, Bookkeeper, etc. Mostly config: personality,
-- allowed tool/connection categories, which audience it serves, active
-- flag. Starts with exactly one seeded row (the existing customer-facing
-- assistant) so run.ts/chat.ts's eventual refactor onto the persona model
-- has something real to resolve against.
-- ─────────────────────────────────────────────
create table if not exists agent_personas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text,
  system_prompt text not null,
  audience text not null check (audience in ('customer', 'owner', 'both')),
  allowed_tool_categories jsonb not null default '[]',
  allowed_connection_categories jsonb not null default '[]',
  permission_overrides jsonb not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists agent_personas_tenant_idx
  on agent_personas (tenant_id, active);

alter table agent_personas enable row level security;

drop policy if exists "owner can access own agent_personas" on agent_personas;
create policy "owner can access own agent_personas"
  on agent_personas
  for all
  using (
    tenant_id in (select id from tenants where owner_user_id = auth.uid())
  );

-- ─────────────────────────────────────────────
-- Generalized connections — the connector_credentials pattern the README
-- already earmarks for Drive/Dropbox and future connectors. Existing
-- gmail_connections/zoom_connections tables are untouched; this is only
-- for NEW connector types going forward, so every future integration
-- lands in one place instead of getting its own bespoke table each time.
-- ─────────────────────────────────────────────
create table if not exists connector_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null,
  category text not null,
  credentials_encrypted text not null,
  status text not null default 'connected'
    check (status in ('connected', 'reauth_required', 'disconnected')),
  connected_at timestamptz not null default now(),
  unique (tenant_id, provider)
);

create index if not exists connector_credentials_tenant_idx
  on connector_credentials (tenant_id, status);

alter table connector_credentials enable row level security;

drop policy if exists "owner can access own connector_credentials" on connector_credentials;
create policy "owner can access own connector_credentials"
  on connector_credentials
  for all
  using (
    tenant_id in (select id from tenants where owner_user_id = auth.uid())
  );

-- ─────────────────────────────────────────────
-- Owner-directed action audit — every action executed WITHOUT going
-- through the normal propose_*/approval queue because it was resolved as
-- owner-directed-explicit. Makes "the agent sent something on the
-- owner's behalf without a formal approval step" always traceable.
-- ─────────────────────────────────────────────
create table if not exists owner_directed_action_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  persona_id uuid references agent_personas(id),
  tool_name text not null,
  explicitness_heuristic_score numeric,
  executed_directly boolean not null,
  content_snapshot text not null,
  source_channel text not null,
  created_at timestamptz not null default now()
);

create index if not exists owner_directed_action_log_tenant_idx
  on owner_directed_action_log (tenant_id, created_at desc);

alter table owner_directed_action_log enable row level security;

drop policy if exists "owner can access own owner_directed_action_log" on owner_directed_action_log;
create policy "owner can access own owner_directed_action_log"
  on owner_directed_action_log
  for all
  using (
    tenant_id in (select id from tenants where owner_user_id = auth.uid())
  );

-- ─────────────────────────────────────────────
-- tenants: multi-channel reachability. Additive — the existing
-- proactive_contact_channel column (single value, from migration 009)
-- is left in place untouched so the current dispatcher keeps working;
-- only switch code over to this new column once multiple channels are
-- actually wired (see build plan Phase 6.6).
-- ─────────────────────────────────────────────
alter table tenants
  add column if not exists proactive_contact_channels jsonb not null default '["sms"]',
  add column if not exists slack_workspace_id text;

-- ─────────────────────────────────────────────
-- Seed: one default persona per existing tenant, so any tenant created
-- before this migration has a real persona row to resolve against once
-- run.ts/chat.ts are refactored onto the persona model (build plan
-- Phase 4.3). Safe to run more than once — only inserts where a tenant
-- has zero personas yet.
-- ─────────────────────────────────────────────
insert into agent_personas (tenant_id, name, description, system_prompt, audience,
  allowed_tool_categories, allowed_connection_categories, permission_overrides, active)
select
  t.id,
  'Assistant',
  'Default customer-facing agent, migrated from pre-persona configuration.',
  coalesce(ac.custom_instructions, 'You are a helpful business assistant.'),
  'customer',
  '[]'::jsonb,
  '[]'::jsonb,
  '{}'::jsonb,
  true
from tenants t
left join agent_configs ac on ac.tenant_id = t.id
where not exists (
  select 1 from agent_personas p where p.tenant_id = t.id
);
