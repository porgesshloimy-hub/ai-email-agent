-- Migration 009: Agent memory system — customer/business memory, reminders,
-- watches, self-observations, and the shared proactive-outreach queue.
-- Run this in the Supabase SQL Editor against your existing project.
-- Idempotent: safe to run more than once (if not exists / drop-then-create
-- for policies).

-- ─────────────────────────────────────────────
-- Extend agent_memories: scope, slots, provenance, verification, decay
-- ─────────────────────────────────────────────
alter table agent_memories
  add column if not exists scope text not null default 'customer'
    check (scope in ('tenant', 'customer')),
  add column if not exists customer_email text,
  add column if not exists embedding vector(1536),
  add column if not exists source_thread_id text,
  add column if not exists source text not null default 'extracted'
    check (source in ('extracted', 'owner_stated', 'customer_stated')),
  add column if not exists is_slot boolean not null default false,
  add column if not exists slot_key text,
  add column if not exists is_consequential boolean not null default false,
  add column if not exists verified boolean not null default true,
  add column if not exists importance smallint not null default 1,
  add column if not exists last_used_at timestamptz not null default now(),
  add column if not exists use_count int not null default 0,
  add column if not exists superseded_by uuid references agent_memories(id);

create index if not exists agent_memories_tenant_scope_idx
  on agent_memories (tenant_id, scope, customer_email);

create index if not exists agent_memories_slot_idx
  on agent_memories (tenant_id, customer_email, slot_key)
  where slot_key is not null;

create index if not exists agent_memories_embedding_idx
  on agent_memories using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ─────────────────────────────────────────────
-- Reminders — one-shot, time-triggered tasks the owner asks the agent to
-- hold. Delivered, then deleted on acknowledgment; falls back to the
-- passive outreach queue after repeated unanswered attempts.
-- ─────────────────────────────────────────────
create table if not exists agent_reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  content text not null,
  related_customer_email text,
  trigger_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'awaiting_ack', 'done', 'passive_queue')),
  attempt_count smallint not null default 0,
  source_thread_id text,
  created_at timestamptz not null default now()
);

create index if not exists agent_reminders_due_idx
  on agent_reminders (tenant_id, status, trigger_at);

alter table agent_reminders enable row level security;

drop policy if exists "owner can access own agent_reminders" on agent_reminders;
create policy "owner can access own agent_reminders"
  on agent_reminders
  for all
  using (
    tenant_id in (
      select id
      from tenants
      where owner_user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────
-- Watches — event-triggered: fire when a specific customer emails in.
-- One-shot watches flip to 'triggered' and stop; recurring stay 'active'
-- until the owner explicitly cancels.
-- ─────────────────────────────────────────────
create table if not exists agent_watches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  watched_customer_email text not null,
  note text,
  recurring boolean not null default false,
  status text not null default 'active'
    check (status in ('active', 'triggered', 'cancelled')),
  created_at timestamptz not null default now()
);

create index if not exists agent_watches_active_idx
  on agent_watches (tenant_id, watched_customer_email)
  where status = 'active';

alter table agent_watches enable row level security;

drop policy if exists "owner can access own agent_watches" on agent_watches;
create policy "owner can access own agent_watches"
  on agent_watches
  for all
  using (
    tenant_id in (
      select id
      from tenants
      where owner_user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────
-- Self-observations — the agent's own suggestions about its behavior.
-- Never auto-applied; always queued for owner confirmation.
-- ─────────────────────────────────────────────
create table if not exists agent_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  content text not null,
  related_customer_email text,
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'resolved', 'dismissed')),
  created_at timestamptz not null default now()
);

alter table agent_suggestions enable row level security;

drop policy if exists "owner can access own agent_suggestions" on agent_suggestions;
create policy "owner can access own agent_suggestions"
  on agent_suggestions
  for all
  using (
    tenant_id in (
      select id
      from tenants
      where owner_user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────
-- Shared outreach queue — unifies reminders/watches/suggestions for the
-- proactive-contact dispatcher. item_id is polymorphic (points at
-- agent_reminders/agent_watches/agent_suggestions depending on item_type),
-- same pattern as approvals.action_id.
-- ─────────────────────────────────────────────
create table if not exists agent_outreach_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_type text not null check (item_type in ('reminder', 'watch', 'suggestion')),
  item_id uuid not null,
  priority smallint not null,
  ready_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists agent_outreach_queue_ready_idx
  on agent_outreach_queue (tenant_id, priority desc, created_at asc);

alter table agent_outreach_queue enable row level security;

drop policy if exists "owner can access own agent_outreach_queue" on agent_outreach_queue;
create policy "owner can access own agent_outreach_queue"
  on agent_outreach_queue
  for all
  using (
    tenant_id in (
      select id
      from tenants
      where owner_user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────
-- Conversational instruction notes — owner-authored behavior instructions
-- given in chat/SMS/email rather than typed into the dashboard field.
-- Concatenated onto agent_configs.custom_instructions at prompt-build time;
-- kept as separate rows so each instruction stays individually editable.
-- ─────────────────────────────────────────────
create table if not exists agent_instruction_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  content text not null,
  source_thread_id text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table agent_instruction_notes enable row level security;

drop policy if exists "owner can access own agent_instruction_notes" on agent_instruction_notes;
create policy "owner can access own agent_instruction_notes"
  on agent_instruction_notes
  for all
  using (
    tenant_id in (
      select id
      from tenants
      where owner_user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────
-- Tenants: owner contact preferences for proactive outreach
-- ─────────────────────────────────────────────
alter table tenants
  add column if not exists owner_phone_verified text,
  add column if not exists quiet_hours_start time,
  add column if not exists quiet_hours_end time,
  add column if not exists proactive_contact_channel text default 'sms'
    check (proactive_contact_channel in ('sms', 'chat', 'email'));
