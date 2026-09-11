-- Migration 019: reminder dispatch tracking.
--
-- Needed by lib/agent/reminders/dispatch.ts and lib/agent/outreach/dispatcher.ts
-- (Phase 3.2/5.2 of the memory-system build plan) to know when a reminder
-- was last actually sent, so an unacknowledged reminder can be retried
-- after a spacing interval rather than either spamming on every dispatch
-- cycle or never retrying at all. agent_reminders (migration 009) tracks
-- attempt_count already but never recorded WHEN the last attempt happened.
--
-- Idempotent: safe to run more than once.

alter table agent_reminders
  add column if not exists last_attempted_at timestamptz;
