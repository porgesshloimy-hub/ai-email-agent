-- Migration 020: scheduled tool execution ("send an email tomorrow
-- morning").
--
-- Distinct from agent_reminders (migration 009): a reminder is just a
-- notification back to the owner — nothing external happens. A scheduled
-- action actually DOES something (right now: send/draft an email) at a
-- future time, unattended, so it needs its own status lifecycle and its
-- own permission re-check at fire time rather than reusing the reminder
-- table.
--
-- Scope of this pass: tool_name is always 'send_email'. The table shape
-- (tool_name + a generic-ish set of columns) leaves room for a future
-- second scheduled tool without a rework, but only send_email is actually
-- implemented — see lib/agent/scheduled-actions/dispatch.ts.
--
-- Idempotent: safe to run more than once.

create table if not exists agent_scheduled_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  tool_name text not null default 'send_email'
    check (tool_name in ('send_email')),
  to_email text not null,
  subject text not null,
  body text not null,
  trigger_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'executed_sent', 'executed_draft', 'failed', 'cancelled')),
  -- What actually happened, in plain language — surfaced back to the
  -- owner via the same proactive channel reminders use (see
  -- lib/agent/outreach/dispatcher.ts's notifyTenant helper) once the
  -- action fires, so "send an email tomorrow morning" doesn't just
  -- silently happen (or silently fail) with no confirmation.
  result_summary text,
  source_thread_id text,
  attempt_count smallint not null default 0,
  last_attempted_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists agent_scheduled_actions_due_idx
  on agent_scheduled_actions (tenant_id, status, trigger_at);

alter table agent_scheduled_actions enable row level security;

drop policy if exists "owner can access own agent_scheduled_actions" on agent_scheduled_actions;
create policy "owner can access own agent_scheduled_actions"
  on agent_scheduled_actions
  for all
  using (
    tenant_id in (
      select id
      from tenants
      where owner_user_id = auth.uid()
    )
  );
