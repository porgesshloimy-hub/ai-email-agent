-- Migration 008: Tool categories / alternatives
--
-- Introduces a general "alternatives" concept: multiple tools/options
-- that fulfill the same functional need for the customer (e.g. a video
-- meeting link can come from Zoom OR Google Meet), where the business
-- may prefer one over the other when the customer didn't specify.
--
-- Built in response to a real incident: a customer asked for a Zoom
-- meeting on an account with no Zoom connection. The agent correctly
-- recognized it lacked Zoom capability and proposed a plain calendar
-- event instead — but had no framework for offering an alternative
-- (Google Meet), so the result was a calendar entry referencing "Zoom"
-- with no actual video link at all. See lib/agent/tools/categories.ts
-- for the runtime side of this fix.
--
-- agent_configs.tool_preferences stores, per category, which provider
-- the tenant prefers when more than one is available and the customer
-- didn't specify — e.g. {"video_meeting": "google_meet"}. Keyed by
-- category id (lib/agent/tools/categories.ts's TOOL_CATEGORIES), valued
-- by provider id. Absent key = no preference set; the agent falls back
-- to a documented sensible default (see categories.ts).
alter table agent_configs
  add column if not exists tool_preferences jsonb not null default '{}'::jsonb;

-- calendar_actions.request_google_meet records the model's own explicit
-- decision, at proposal time, about whether this event should include a
-- Google Meet link — a real stored fact, rather than the previous
-- implicit inference (whether the stored confirmation text happened to
-- contain the {{meeting_link}} placeholder) that app/dashboard/approvals/
-- actions.ts's confirmCalendarEvent used at approval time, which could
-- drift from what was actually intended.
alter table calendar_actions
  add column if not exists request_google_meet boolean not null default false;
