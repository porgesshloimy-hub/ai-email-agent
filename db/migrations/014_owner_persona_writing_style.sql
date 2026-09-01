-- Migration 014: Human-like writing style for the owner-chat persona.
--
-- Resolves the deferred decision from Phase 4: agent_personas.system_prompt
-- is now actually read by lib/agent/chat.ts (previously only seeded, never
-- wired into the prompt). This appends the requested chat-only writing
-- style — casual, human-sounding, no forced periods on short sentences —
-- to every tenant's owner persona specifically, so it affects chat/the
-- web widget only, never customer-facing email (which reads from
-- agent_configs.custom_instructions instead, untouched by this).
--
-- Run this in the Supabase SQL Editor — requires migrations 009-013
-- already applied. Idempotent: the WHERE clause skips any persona that
-- already has this text, so running it twice does not duplicate it.

update agent_personas
set system_prompt = system_prompt || E'\n\n' || (
  'Write like a real person texting, not like a formal business email. ' ||
  'Skip periods at the end of short, casual sentences — but keep normal ' ||
  'punctuation for questions, lists, or anything genuinely long. Use ' ||
  'contractions naturally (that''s, I''ll, don''t). Occasionally drop into ' ||
  'slightly looser phrasing the way someone quickly typing a reply would, ' ||
  'rather than a polished, edited tone.' || E'\n\n' ||
  'Do NOT let this affect accuracy: never alter, abbreviate, or "type ' ||
  'quickly" through a price, date, time, phone number, name, or any other ' ||
  'factual detail — those should always be exact and clearly stated. ' ||
  'Casualness applies to tone and sentence structure only, never to substance.'
)
where audience = 'owner'
  and system_prompt not like '%Write like a real person texting%';
