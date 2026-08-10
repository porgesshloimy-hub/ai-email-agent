# AI Email Agent — scaffold

See `STACK.md` for the full architecture writeup.

## What's implemented in this scaffold
- Next.js App Router structure (landing, dashboard, settings, agent config, approvals, billing)
- Supabase schema with RLS-based tenant isolation (`db/schema.sql`, plus incremental migrations in `db/migrations/`)
- Gmail OAuth connect flow with encrypted token storage — now also requests Calendar scopes in the same consent grant
- Permission enforcement engine (`lib/agent/permissions.ts`) — the backend gate, not the model — covering Gmail *and* Calendar actions
- Agent pipeline (`lib/agent/run.ts`): permission check -> knowledge lookup -> OpenAI call with only the allowed tools -> take only the allowed action
- **Draft-only approval flow** for email sends, and the same pattern applied to calendar writes: when a gated action needs approval, the model only ever gets a "propose" tool, never one that actually executes. The Approvals page is the only place a gated send or booking actually happens, and it re-checks tenant ownership before acting.
- **Google Calendar integration** (`lib/calendar/client.ts`): list/create/update/delete events, availability checks, all gated by the same permission engine as email
- **Usage-based billing** (`lib/billing/`): every OpenAI call and Twilio SMS is metered, marked up by a configurable percentage (`tenants.usage_markup_percent`, default 3%), and reported to Stripe's Billing Meters API in real time, with an hourly reconciliation job for anything that failed to report
- **Google Chat integration** (`lib/agent/chat.ts`, `app/api/webhooks/google-chat/`): message the agent directly from Google Chat — ask what's pending, request calendar bookings. Verified via Google's signed JWT on every request; the sender is matched to a tenant by their connected Gmail address (or an alternate address set in Settings)
- Gmail push notifications via Pub/Sub webhook -> Inngest background job instead of polling

## Not yet wired up (left as clear stubs)
- Embeddings + pgvector similarity search (`searchKnowledge` in `lib/agent/run.ts`)
- Gmail `history.list` diffing to pull actual new messages
- Supabase Auth UI (signup/login pages)
- Business info / agent instructions / permissions / Google Chat linking forms are currently read-only display — wire to server actions
- Stripe Checkout session creation (to actually subscribe a tenant to the metered price) — see setup steps below
- Sentry init

## Setup
1. `cp .env.example .env.local` and fill in credentials as you set each service up.
2. Create a Supabase project, run `db/schema.sql`, then each file in `db/migrations/` in order, in the SQL editor.
3. Google Cloud project: enable Gmail API + Calendar API + Chat API. Create OAuth credentials for the Gmail/Calendar
   consent flow. Create a Pub/Sub topic + subscription pointed at `/api/webhooks/gmail`, granting
   `gmail-api-push@system.gserviceaccount.com` publish rights.
4. For Google Chat: in Cloud Console -> Chat API -> Configuration, set the App URL to
   `https://yourapp.com/api/webhooks/google-chat`, and note your GCP **project number** (not project ID) for
   `GOOGLE_CHAT_PROJECT_NUMBER`.
5. Stripe: see the setup walkthrough provided separately — create the `usage_cost_cents` meter, a metered Price
   against it, and a webhook pointed at `/api/webhooks/stripe`.
6. `npm install && npm run dev`.
7. Restricted Gmail/Calendar scopes require Google's CASA security assessment before scaling past ~100 test users —
   start that process early.
