# AI Email Agent — Tech Stack

## Core
| Layer            | Choice                          | Notes |
|-------------------|----------------------------------|-------|
| Frontend/App      | Next.js 14 (App Router) + TypeScript | Single codebase for marketing site, auth, and dashboard |
| Hosting           | Vercel                          | Edge-friendly, zero-config deploys from GitHub |
| Source control    | GitHub                          | Vercel auto-deploys on push |
| Auth              | Supabase Auth                   | Email/password + Google OAuth for the *account* login (separate from the Gmail data-access OAuth) |
| Database          | Supabase Postgres               | Row-Level Security (RLS) scoped by `tenant_id` for isolation |
| Vector search      | pgvector (Supabase extension)   | One namespace per customer for uploaded docs/knowledge |
| File storage      | Supabase Storage                | Uploaded PDFs/knowledge docs |
| AI                | OpenAI API                      | Reasoning + drafting; called only with the context/tools the permission layer allows |
| Email data access  | Gmail API (OAuth2, separate consent from account login) | Push notifications via Google Cloud Pub/Sub (watch/history), not polling |
| Notifications      | Twilio SMS                      | Agent pings the owner; no reply-to-approve — approval happens in-app (see below) |
| Background jobs    | Inngest                         | Event-driven: `email.received`, `draft.created`, `approval.requested`, etc. |
| Payments          | Stripe                          | Subscription billing |
| Monitoring/errors  | Sentry                          | Both frontend and background job errors |

## Isolation model
"Each customer gets an isolated agent" = **logical isolation**, not separate compute:
- Every table is scoped by `tenant_id` (the customer's org/account id).
- Postgres RLS policies enforce that a request can only read/write its own `tenant_id`.
- pgvector rows are tagged with `tenant_id` and every similarity search is filtered by it.
- No per-customer containers, processes, or model instances — one backend, strict row scoping.

## Approval flow (revised)
When an action requires approval (e.g. "Send" needs approval, "Delete" is off):
1. The agent **only ever drafts** — it never calls the Gmail `send` endpoint for a gated action.
2. The draft is written to Gmail as an actual Gmail draft (visible in the customer's own Gmail) **and** stored in our DB with status `pending_approval`.
3. Twilio SMS notifies the owner that a draft is waiting (no reply-to-send parsing needed — SMS is just a nudge).
4. The owner approves/edits/sends from the in-app dashboard (or directly in Gmail, if they prefer).
5. If approved in-app, the backend calls Gmail `send` on the customer's behalf using the stored draft.

This removes the need for inbound-SMS approval parsing entirely — SMS is notification-only, the dashboard is the single source of truth for approval state.

## Permission enforcement
The backend — never the model — is the enforcement point:
- `lib/permissions.ts` checks the tenant's permission matrix + rules before any tool is exposed to the OpenAI call.
- Gated actions (e.g. send) are structurally unavailable as a tool call when approval is required; the agent's only available action in that case is "create draft."

## Repo layout (this scaffold)
```
app/
  page.tsx                     Marketing/signup landing
  dashboard/                   Authenticated app
    page.tsx                   Overview
    settings/page.tsx          Business info + Gmail connection
    agent/page.tsx             Instructions, rules, permissions
    approvals/page.tsx         Pending drafts to approve
  api/
    auth/gmail/route.ts        Starts Gmail OAuth
    auth/gmail/callback/route.ts   Handles OAuth callback, stores tokens
    webhooks/gmail/route.ts    Receives Pub/Sub push notifications
lib/
  supabase/client.ts           Browser Supabase client
  supabase/server.ts           Server Supabase client (service role, server-only)
  gmail/client.ts              Gmail API wrapper (read/draft/send, scoped by permissions)
  agent/permissions.ts         Permission + rule enforcement engine
  agent/run.ts                 Orchestrates: check permissions -> fetch context -> call OpenAI -> take allowed action
db/
  schema.sql                   Postgres schema incl. RLS policies
types/
  index.ts                     Shared TypeScript types
```
