-- Migration 013: Owner chat message log (continuity + reply-to), and
-- relaxing pending_owner_confirmations to allow more than one pending
-- item at a time now that reply-to gives an explicit way to resolve
-- which one a given reply answers.
--
-- Run this in the Supabase SQL Editor — requires migrations 009-012
-- already applied. Idempotent.

-- ─────────────────────────────────────────────
-- Full transcript of owner-facing chat (web widget, Google Chat, and any
-- future channel). Two jobs: (1) gives the agent real conversational
-- continuity — previously chat.ts sent only the single current message
-- with zero history — and (2) lets a UI "reply to this message" action
-- attach an explicit replied_to_message_id, which resolves pending
-- confirmations deterministically instead of relying on "the one most
-- recent pending item."
-- ─────────────────────────────────────────────
create table if not exists owner_chat_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text not null check (role in ('owner', 'agent')),
  content text not null,
  channel text not null,  -- 'web' | 'chat' | 'sms' | ...
  replied_to_message_id uuid references owner_chat_messages(id),
  created_at timestamptz not null default now()
);

create index if not exists owner_chat_messages_tenant_recent_idx
  on owner_chat_messages (tenant_id, created_at desc);

alter table owner_chat_messages enable row level security;

drop policy if exists "owner can access own owner_chat_messages" on owner_chat_messages;
create policy "owner can access own owner_chat_messages"
  on owner_chat_messages
  for all
  using (
    tenant_id in (select id from tenants where owner_user_id = auth.uid())
  );

-- ─────────────────────────────────────────────
-- pending_owner_confirmations: migration 012 restricted this to one row
-- per tenant specifically because there was no way to disambiguate which
-- pending item a short "yes" reply was answering if more than one
-- existed. Reply-to solves that directly — a reply naming a specific
-- message resolves unambiguously — so the artificial one-at-a-time
-- limit can be lifted. confirmation_message_id links a pending row to
-- the AGENT's own owner_chat_messages row that asked for confirmation,
-- so a reply-to on that message finds this row directly.
-- ─────────────────────────────────────────────
alter table pending_owner_confirmations
  drop constraint if exists pending_owner_confirmations_tenant_id_key;

alter table pending_owner_confirmations
  add column if not exists confirmation_message_id uuid references owner_chat_messages(id);

create index if not exists pending_owner_confirmations_tenant_idx
  on pending_owner_confirmations (tenant_id, created_at desc);

create index if not exists pending_owner_confirmations_message_idx
  on pending_owner_confirmations (confirmation_message_id)
  where confirmation_message_id is not null;
