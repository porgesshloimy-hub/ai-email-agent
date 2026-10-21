-- 022: Additional authorized owner phone numbers for SMS.
--
-- SMS is becoming a real conversation surface for the owner chat
-- (app/api/twilio/incoming). An owner may text from more than one phone,
-- but tenants.phone_number holds only one. This adds the others.
--
--   tenants.phone_number              primary number — where proactive
--                                     messages (reminders, scheduled-
--                                     action results, approval requests)
--                                     are sent.
--   tenants.additional_phone_numbers  extra numbers authorized to TEXT
--                                     the agent. Replies go back to
--                                     whichever number sent the message.
--
-- All numbers are stored in E.164 form ("+15551234567"), which is what
-- Twilio puts in an inbound message's From field; the settings form
-- normalizes before saving. The GIN index makes the inbound webhook's
-- "which tenant owns this number" lookup cheap.
--
-- Idempotent. Run this file only — never schema.sql.

alter table tenants
  add column if not exists additional_phone_numbers text[] not null default '{}';

create index if not exists tenants_additional_phone_numbers_idx
  on tenants using gin (additional_phone_numbers);
