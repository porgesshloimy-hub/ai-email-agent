-- Migration 007: Tenant business timezone
--
-- Fixes a real bug: lib/agent/date-context.ts's buildCurrentDateContext()
-- (used by both lib/agent/run.ts's email pipeline and lib/agent/chat.ts's
-- Google Chat handler to tell the model what day it is) previously
-- hardcoded timeZone: "UTC" with no per-tenant override at all — there
-- was no timezone concept anywhere in the schema. For any business not
-- in (or near) UTC, the agent's notion of "today" flips to the next
-- calendar day at UTC midnight, which lands in the middle of a normal
-- business day for most of the US (e.g. mid-afternoon for Pacific time) —
-- not a rare edge case, wrong for a large fraction of every business day.
--
-- This does NOT attempt to know an individual customer's timezone (there
-- isn't one deterministic answer for a business with clients across
-- multiple zones) — see lib/agent/run.ts's updated system prompt for how
-- that's handled instead (prefer a stated/implied customer timezone in
-- the thread, always restate resolved times explicitly with a timezone
-- so a wrong guess is immediately visible, default to this column
-- otherwise). This column is specifically the business's OWN operating
-- timezone — the one its calendar, "today," and business hours actually
-- run on.
--
-- Defaults to 'UTC' (the previous hardcoded behavior) so nothing changes
-- for a tenant until they explicitly set a real value in Settings.

alter table tenants
  add column if not exists timezone text not null default 'UTC';

-- Loose sanity check: reject obviously-invalid values (empty string,
-- whitespace) without trying to validate against the full IANA tz
-- database at the SQL layer — that validation belongs in application
-- code (see lib/timezones.ts), which can be updated far more easily
-- than a check constraint if the accepted list ever changes.
alter table tenants
  drop constraint if exists tenants_timezone_not_blank;

alter table tenants
  add constraint tenants_timezone_not_blank
  check (length(trim(timezone)) > 0);
