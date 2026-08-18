-- Migration 005: Multi-LLM support
--
-- Lets each tenant choose which AI provider/model powers their agent
-- (lib/agent/run.ts, lib/agent/chat.ts) instead of always using the
-- hardcoded OpenAI "gpt-5-nano" model. Selection is exposed on the
-- Agent dashboard (app/dashboard/agent/page.tsx) and enforced/validated
-- server-side against the catalog in lib/agent/models.ts.
--
-- Run this in the Supabase SQL Editor against your existing project,
-- then fold it into db/schema.sql (schema.sql is already documented as
-- drifting from what's actually deployed — see migration 004's note).

alter table agent_configs
  add column if not exists ai_provider text not null default 'openai',
  add column if not exists ai_model text not null default 'gpt-5-nano';

-- Fail-closed-ish sanity constraint: keep provider values to the ones the
-- app code actually knows how to call (lib/agent/llm/index.ts). Update
-- this constraint if you add a new provider adapter.
alter table agent_configs
  drop constraint if exists agent_configs_ai_provider_check;

alter table agent_configs
  add constraint agent_configs_ai_provider_check
  check (ai_provider in ('openai', 'anthropic', 'mistral'));

-- NOTE: the actual (provider, model) *combination* is validated in
-- application code (lib/agent/models.ts -> isValidModelSelection), not
-- at the database layer, since the set of valid models per provider
-- changes far more often than a migration cycle should require.
