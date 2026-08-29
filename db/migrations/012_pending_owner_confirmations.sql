-- Migration 012: Pending owner-directed action confirmations.
--
-- Discovered while building Phase 5 (owner-directed approval resolution):
-- lib/agent/tools/create-calendar-event.ts's CHAT tool currently executes
-- immediately for every owner request, with no distinction between "the
-- owner gave exact specifics" and "the owner delegated a judgment call
-- the model had to fill in itself." Closing that gap requires somewhere
-- to actually hold a drafted-but-not-yet-executed action between one
-- chat message and the owner's next reply, since Google Chat here is
-- otherwise a single stateless request/response per message with no
-- memory of what was just proposed.
--
-- Run this in the Supabase SQL Editor — requires migrations 009-011
-- already applied. Idempotent.

create table if not exists pending_owner_confirmations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  tool_name text not null,
  args jsonb not null,
  confirmation_message text not null,   -- what was shown to the owner, for reference/audit
  explicitness_score numeric,
  created_at timestamptz not null default now(),
  -- A stale, unanswered confirmation shouldn't sit around forever waiting
  -- to be accidentally confirmed by an unrelated later "yes" — 30 minutes
  -- is generous for a same-conversation reply, short enough that a truly
  -- abandoned draft doesn't linger.
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  -- One pending confirmation per tenant at a time, by design: chat.ts's
  -- single-turn request/response model can't currently juggle more than
  -- one open confirmation without also needing to disambiguate WHICH one
  -- a short "yes" reply is answering — the same ambiguity problem the
  -- reminder-ack design flagged. Simpler and safer to just not allow a
  -- second one to be created while one is outstanding (see the unique
  -- index below) until multi-item disambiguation is actually built.
  unique (tenant_id)
);

create index if not exists pending_owner_confirmations_expiry_idx
  on pending_owner_confirmations (expires_at);

alter table pending_owner_confirmations enable row level security;

drop policy if exists "owner can access own pending_owner_confirmations" on pending_owner_confirmations;
create policy "owner can access own pending_owner_confirmations"
  on pending_owner_confirmations
  for all
  using (
    tenant_id in (select id from tenants where owner_user_id = auth.uid())
  );
