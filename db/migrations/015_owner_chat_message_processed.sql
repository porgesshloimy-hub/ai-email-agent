-- Migration 015: Track which owner chat messages have been answered.
--
-- Needed for delayed, batched agent replies (Option B — an Inngest
-- background job waits a random 7-20s before responding, so a
-- follow-up message sent during that window gets folded into the same
-- reply instead of triggering a separate, possibly-overlapping one).
-- "processed" marks an owner message as already covered by a
-- generated reply; only meaningful for role = 'owner' rows.
--
-- Run this in the Supabase SQL Editor — requires migrations 009-014
-- already applied. Idempotent.

alter table owner_chat_messages
  add column if not exists processed boolean not null default false;

create index if not exists owner_chat_messages_unprocessed_idx
  on owner_chat_messages (tenant_id, created_at)
  where role = 'owner' and processed = false;
