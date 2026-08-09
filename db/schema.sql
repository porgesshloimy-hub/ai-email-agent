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
  action text not null,                  -- 'gmail.read' | 'gmail.draft' | 'gmail.send' | 'gmail.archive' | 'gmail.delete'
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
-- ─────────────────────────────────────────────
create type email_action_status as enum ('processed', 'pending_approval', 'approved', 'rejected', 'sent');

create table email_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  gmail_thread_id text not null,
  gmail_message_id text,
  action_type text not null,             -- 'draft_reply' | 'archive' | 'escalate' etc.
  status email_action_status not null default 'pending_approval',
  gmail_draft_id text,                   -- Gmail's draft id, needed to send it on approval
  draft_content text,
  reasoning text,                        -- why the agent decided this (audit trail)
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

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

-- Note: background jobs (Inngest) run with the Supabase service_role key,
-- which bypasses RLS by design — tenant scoping in that path is enforced
-- in application code (lib/agent/*), always filtering by tenant_id explicitly.
