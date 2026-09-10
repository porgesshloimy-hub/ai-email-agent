-- Migration 018: Memory retrieval model — pinned/searched split.
--
-- Supersedes the original Phase 2.4 plan (auto-inject top-3-tenant +
-- top-5-customer memories into every email). Instead: a small pinned
-- tier (consequential slots + anything flagged always_surface, fetched
-- deterministically, no embedding call — see lib/agent/memory/pinned.ts)
-- rides along on every relevant task, and everything else is reached via
-- the agent-invoked search_context tool (lib/agent/memory/search-context.ts),
-- which calls the match_agent_memories() function added below.
--
-- Idempotent: safe to run more than once (if not exists / create-or-replace
-- throughout), matching the convention of every prior migration in this
-- directory.
-- Run this in the Supabase SQL Editor against your existing project.

-- ─────────────────────────────────────────────
-- Pin columns on agent_memories
-- ─────────────────────────────────────────────
alter table agent_memories
  add column if not exists always_surface boolean not null default false,
  add column if not exists pin_source text
    check (pin_source in ('owner', 'suggested'));

-- Consequential slots are treated as pinned in code (lib/agent/memory/slots.ts
-- + pinned.ts), not via this column — "consequential" is a property of the
-- slot key itself, not a per-row toggle. This column is for everything
-- else an owner (or the suggestion system, pending owner approval) wants
-- to guarantee always surfaces regardless of similarity search.
create index if not exists agent_memories_pinned_idx
  on agent_memories (tenant_id, customer_email)
  where always_surface = true and superseded_by is null;

-- ─────────────────────────────────────────────
-- email_actions.customer_email — needed by lib/agent/memory/eligibility.ts
-- to answer "has this sender emailed before" across threads. email_actions
-- previously stored no sender/customer column at all (only
-- gmail_thread_id/gmail_message_id), which is fine for idempotency but
-- can't answer a cross-thread "is this a repeat sender" question.
-- Backfill is intentionally left null for pre-existing rows — eligibility
-- checks only need this to be accurate going forward (see
-- lib/agent/run.ts's RESERVE THE MESSAGE step, updated to populate it).
-- ─────────────────────────────────────────────
alter table email_actions
  add column if not exists customer_email text;

create index if not exists email_actions_tenant_customer_idx
  on email_actions (tenant_id, customer_email)
  where customer_email is not null;

-- ─────────────────────────────────────────────
-- match_agent_memories — federated-search counterpart to the existing
-- (undocumented-in-repo, already live) match_knowledge_chunks RPC.
-- Same call shape and same similarity convention (1 - cosine distance,
-- higher is better) so lib/agent/memory/search-context.ts can treat both
-- RPCs' results uniformly.
--
-- Scope: always includes this tenant's tenant-scope memories; customer-
-- scope memories are included only when match_customer_email is passed
-- and matches. Excludes superseded slot rows and anything with no
-- embedding (a freshly-written slot may not have one yet — it doesn't
-- need to, since slots are reached via the pinned tier, not this
-- function).
-- ─────────────────────────────────────────────
create or replace function match_agent_memories(
  query_embedding vector(1536),
  match_tenant_id uuid,
  match_customer_email text default null,
  match_count int default 8
)
returns table (
  id uuid,
  content text,
  scope text,
  customer_email text,
  source text,
  is_slot boolean,
  slot_key text,
  is_consequential boolean,
  verified boolean,
  always_surface boolean,
  importance smallint,
  similarity float
)
language sql stable
as $$
  select
    m.id,
    m.content,
    m.scope,
    m.customer_email,
    m.source,
    m.is_slot,
    m.slot_key,
    m.is_consequential,
    m.verified,
    m.always_surface,
    m.importance,
    1 - (m.embedding <=> query_embedding) as similarity
  from agent_memories m
  where m.tenant_id = match_tenant_id
    and m.embedding is not null
    and m.superseded_by is null
    and (
      m.scope = 'tenant'
      or (
        m.scope = 'customer'
        and match_customer_email is not null
        and m.customer_email = match_customer_email
      )
    )
  order by m.embedding <=> query_embedding
  limit match_count;
$$;
