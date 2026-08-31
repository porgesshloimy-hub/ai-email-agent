-- Migration 016: Track the owner's last typing activity in chat.
--
-- Needed for the rewired delayed-reply logic: rather than a fixed
-- random delay before responding regardless of what the owner is
-- doing, the agent now waits to see whether the owner is actively
-- typing a follow-up, and holds off responding until they've stopped.
--
-- Run this in the Supabase SQL Editor — requires migrations 009-015
-- already applied. Idempotent.

alter table tenants
  add column if not exists owner_last_typing_at timestamptz;
