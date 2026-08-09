# AI Email Agent — scaffold

See `STACK.md` for the full architecture writeup.

## What's implemented in this scaffold
- Next.js App Router structure (landing, dashboard, settings, agent config, approvals)
- Supabase schema with RLS-based tenant isolation (`db/schema.sql`)
- Gmail OAuth connect flow (`app/api/auth/gmail/*`) with encrypted token storage
- Permission enforcement engine (`lib/agent/permissions.ts`) — the backend gate, not the model
- Agent pipeline (`lib/agent/run.ts`) implementing: permission check -> knowledge lookup -> OpenAI call
  with only the allowed tools -> take only the allowed action
- **Draft-only approval flow**: when "send" requires approval, the model is only ever given a
  `create_draft` tool. The draft goes into the customer's real Gmail drafts folder, gets logged with
  `status = pending_approval`, and Twilio sends a notification-only SMS (no reply-to-approve parsing).
  The dashboard's Approvals page (`app/dashboard/approvals`) is the only path that can call Gmail's
  `send`, and it re-checks that the requesting user owns the tenant before doing so.
- Gmail push notifications via Pub/Sub webhook -> Inngest background job (`app/api/webhooks/gmail`,
  `lib/inngest/functions.ts`) instead of polling

## Not yet wired up (left as clear stubs)
- Embeddings + pgvector similarity search (`searchKnowledge` in `lib/agent/run.ts`)
- Gmail `history.list` diffing to pull actual new messages (`diff-history` step in `lib/inngest/functions.ts`)
- Supabase Auth UI (signup/login pages)
- Business info / agent instructions / permissions forms (currently read-only display; wire to server actions)
- Stripe billing
- Sentry init

## Setup
1. `cp .env.example .env.local` and fill in credentials.
2. Create a Supabase project, run `db/schema.sql` in the SQL editor.
3. Set up a Google Cloud project: enable the Gmail API, create OAuth credentials, create a Pub/Sub
   topic + subscription pointed at `/api/webhooks/gmail`, and grant `gmail-api-push@system.gserviceaccount.com`
   publish rights on the topic.
4. `npm install && npm run dev`
5. Gmail's OAuth consent screen will need Google's CASA security assessment before scaling past ~100
   test users, given the scopes requested (readonly + compose + send + modify). Start that process early.
