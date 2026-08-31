-- Migration 017: Real "agent is actively replying" status.
--
-- Replaces client-side guessing (a fixed delay before showing the
-- typing indicator, a quiet-period heuristic for deciding a multi-part
-- reply is finished) with an actual signal from the server: the
-- Inngest reply job sets this true right when it begins generating and
-- persisting a reply, and false the moment it's fully done. The client
-- polls this instead of guessing.
--
-- Run this in the Supabase SQL Editor — requires migrations 009-016
-- already applied. Idempotent.

alter table tenants
  add column if not exists chat_agent_replying boolean not null default false;
