-- Migration 011: Seed a default "owner" persona per tenant.
--
-- Migration 010 seeded a "customer" persona for every tenant, but
-- lib/agent/chat.ts (Google Chat) is actually the OWNER-facing surface —
-- discovered while wiring persona narrowing into that file. Without an
-- owner persona row, resolvePersona(tenantId, "owner") silently falls
-- back to a synthetic default for every tenant, which means no
-- owner-specific permission narrowing is possible yet. This closes that
-- gap the same way 010 did for the customer persona.
--
-- Run this in the Supabase SQL Editor — requires migrations 009 and 010
-- already applied. Idempotent: only inserts where a tenant has no
-- "owner"-or-"both" audience persona yet, so safe to run more than once.

insert into agent_personas (tenant_id, name, description, system_prompt, audience,
  allowed_tool_categories, allowed_connection_categories, permission_overrides, active)
select
  t.id,
  'Owner Assistant',
  'Default owner-facing agent for Google Chat, seeded to close the gap between migration 010 (customer-only seed) and chat.ts''s actual owner audience.',
  concat(
    'You are the AI assistant for ', t.business_name, ', talking directly with the business owner. ',
    'Be concise — this is a chat conversation, not email.'
  ),
  'owner',
  '[]'::jsonb,
  '[]'::jsonb,
  '{}'::jsonb,
  true
from tenants t
where not exists (
  select 1
  from agent_personas p
  where p.tenant_id = t.id
    and p.audience in ('owner', 'both')
);
