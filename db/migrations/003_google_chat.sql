-- Migration 003: Google Chat linking
-- Run this in the Supabase SQL Editor against your existing project.

-- Lets an owner chat with the agent from a Google account other than the
-- one connected as the agent's Gmail — e.g. a personal account rather than
-- the shared business inbox. Optional: if unset, lib/googlechat/matchTenant.ts
-- falls back to matching against gmail_connections.gmail_address.
alter table tenants
  add column if not exists owner_google_email text;
