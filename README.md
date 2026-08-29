# Prime Automatic

Prime Automatic is an AI-powered business email agent that connects to Gmail, Google Calendar,
Zoom, and Google Chat, understands incoming business conversations, and can safely take actions
on behalf of a business according to tenant-specific instructions, rules, and permissions.

The system is designed around **controlled automation**: the AI can reason about an email and
decide what should happen, but the backend — not the AI model — ultimately decides which
actions it is actually allowed to perform, whether the tools for those actions even get offered
to it, and whether its own claims about what it just did are actually true.

---

# Current Status

Prime Automatic is a working, deployed multi-tenant application with the full pipeline
connected end to end:

**Gmail → Pub/Sub → Inngest → Gmail history → capability router → AI agent → permission
engine → content-safety/grounding checks → action/approval → Gmail or Calendar**

Supabase, Google OAuth (Gmail + Calendar, shared consent), Zoom OAuth, OpenAI/Anthropic/Mistral,
Stripe billing, Google Pub/Sub, Inngest, Twilio SMS, and Google Chat are all connected in
production.

Recent work has focused less on "does the pipeline work at all" and more on **trust**: making
sure the agent only ever gets offered tools it can actually use, that it can't narrate an action
as done when it wasn't, that a human approving something later doesn't reopen the same gaps
the live agent path already closed, that "today" means the same thing to the agent as it does
to the business, and that when the agent can't do exactly what was asked, it reaches for a real
alternative instead of a dead end.

---

# Core Principles

- **Safe by default**
- **Human approval for risky actions**
- **Tenant isolation**
- **Explicit capability checks — checked against real connections, not just configured
  permission levels**
- **Auditable actions**
- **Tenant-specific business context**
- **The AI never bypasses backend permissions**
- **The AI only receives tools it is actually permitted to use**
- **The AI's claims about what it did are independently checked, not trusted on their own**
- **Actions requiring approval create proposals rather than executing immediately, and the
  proposal's eventual send is checked again, not just the original proposal**
- **When the preferred way to do something isn't available, the agent offers a real alternative
  it actually has, rather than silently doing nothing or referencing something that doesn't exist**
- **"Today" is defined by the business's own timezone, not the server's** — and when a customer's
  timezone might differ, the agent says so explicitly rather than leaving it ambiguous

---

# Architecture

```
Gmail / Google Chat / Twilio SMS
          │
          ▼
   /api/webhooks/*  or  /api/twilio/incoming
          │
          ▼
      Inngest
          │
          ▼
   Gmail History API (for email) / direct handling (for Chat, SMS)
          │
          ▼
    Incoming message
          │
          ▼
┌─────────────────────────────────────────────┐
│              Agent pipeline                  │
│                                               │
│  Tenant identification                       │
│  Idempotency reservation                      │
│  Business context / knowledge (pgvector)      │
│  Custom instructions + rules                  │
│  Permission engine (connection-checked)       │
│         │                                     │
│         ▼                                     │
│  Capability pre-router (heuristics + cheap    │
│  classifier) — narrows the tool set an email  │
│  actually needs before the main model runs    │
│         │                                     │
│         ▼                                     │
│  Main LLM call (OpenAI / Anthropic / Mistral, │
│  tenant-selectable)                           │
│         │                                     │
│         ▼                                     │
│  Tool call ──► content-safety + grounding     │
│                checks ──► backend permission  │
│                re-check ──► execute / draft /  │
│                propose                        │
└─────────────────────────────────────────────┘
          │
          ▼
   Gmail send/draft, Calendar event, Zoom meeting,
   or an Approval queued for the human owner
          │
          ▼
   Human approves (dashboard or SMS) ──► same
   content-safety + grounding checks run again
   right before the confirmation email actually
   sends ──► Gmail
```

---

# Technology Stack

## Frontend / Application

- Next.js (App Router), TypeScript, React, Server Actions
- Vercel deployment

## Database / Authentication

- Supabase (PostgreSQL, Supabase Auth, Row Level Security)
- Tenant-based data isolation

## AI

- Multi-provider: OpenAI, Anthropic, and Mistral, each with its own adapter under
  `lib/agent/llm/`
- Per-tenant model selection (`agent_configs.ai_provider` / `ai_model`), chosen on the Agent
  dashboard and validated server-side against `lib/agent/models.ts`'s catalog
- Tool/function calling, uniform across all three provider adapters
- A separate, always-cheap model (independent of the tenant's chosen model) powers two
  cost-optimization/safety passes: the capability router's classifier and the grounding guard
  (see below)

## Google

- Gmail API, Google Calendar API (shared OAuth consent — one token, two scopes)
- Google OAuth 2.0, Google Cloud Pub/Sub
- Google Chat integration, verified via Google's signed JWT mechanism

## Zoom

- Zoom OAuth, its own independent token lifecycle from Google's

## SMS

- Twilio — inbound SMS currently supports a fixed APPROVE/DENY/permission-toggle command set
  against pending approvals, not the full agent pipeline

## Background Processing

- Inngest — Gmail push events, scheduled Gmail watch renewal, scheduled draft-status
  reconciliation, scheduled billing reconciliation

## Billing

- Stripe Billing, Stripe Billing Meters API, usage-based metering with a configurable
  per-tenant markup

---

# Authentication & Tenancy

- Supabase authentication, session handling
- Per-user tenant identification and ownership checks
- Multi-tenant, tenant-isolated data throughout
- Server-side authentication and tenant-authorization checks — the app never relies on
  frontend auth alone

Server actions and backend routes identify the authenticated Supabase user, then locate the
tenant that user owns, so one tenant can never reach another tenant's configuration or actions.

---

# Dashboard

Routes (`app/dashboard/components/DashboardNav.tsx`):

```
/dashboard                     Overview
/dashboard/approvals           Approvals
/dashboard/agent               Agent — instructions, model, permissions, preferences, rules, knowledge
/dashboard/settings            Connections — Google / Zoom OAuth connect-disconnect, business timezone
/dashboard/settings/knowledge  Knowledge (also reachable from the Agent page)
/dashboard/billing             Usage & billing
```

Every page loads the authenticated tenant's own configuration on each visit, rather than
anything being hardcoded into the UI.

---

# Agent Configuration (`/dashboard/agent`)

## Custom Instructions

Free-text business context: communication style, formality, special handling instructions,
things the agent should or should not do. Persisted in `agent_configs`.

## AI Model

Per-tenant selection across OpenAI/Anthropic/Mistral tiers (`lib/agent/models.ts`), shown with
a plain-language description of what each tier is good for.

## Permissions

```
gmail.read      gmail.draft      gmail.send      gmail.archive      gmail.delete
calendar.read   calendar.write   calendar.meet
zoom.meet
```

Each capability is one of `denied` / `approval_required` / `allowed`. **A configured level is
not the same as real access** — see "Permission Engine" below for why the backend checks an
actual connection before ever honoring a configured level, for Calendar and Zoom alike.

The permissions UI itself reflects this: each row shows the relevant service's logo, and any
row for an integration that isn't actually connected renders faded with its control replaced by
a static "Not connected" link to Settings — not just a disabled dropdown, genuinely
non-interactive, since changing it wouldn't do anything different on the backend anyway.
Save confirmations ("Permission saved", "Model updated", etc.) render as small toasts fixed to
the bottom of the viewport so they're visible regardless of scroll position, and self-dismiss
after a few seconds.

## Rules

Tenant-specific plain-language rules ("Refund requests always require approval"), server-side
validated (empty-rule prevention, max length, tenant ownership) and scanned against each
incoming email's topic tags to force approval where they match.

## Preferences ("alternatives")

Some things the agent can offer have more than one way to actually be fulfilled — a video
meeting link can come from a real Zoom meeting, or from a Google Calendar event with a Meet
conference attached. `lib/agent/tools/categories.ts` defines these as **categories** (currently
just `video_meeting`, with `zoom` and `google_meet` as its two providers) and resolves, per
tenant per request, which providers are actually connected and which one to default to when the
customer doesn't specify.

The Agent page shows a preference picker for a category only when **two or more** of its
providers are actually connected for that tenant — nothing to prefer between otherwise. The
choice is stored in `agent_configs.tool_preferences` (jsonb, category id → provider id) and
consulted by the system prompt ahead of the tenant's saved default, itself a fallback for
whichever provider needs the least setup to work well out of the box.

This exists because of a real incident: a customer asked for a Zoom meeting on an account with
no Zoom connection. The agent correctly refused to fabricate a Zoom meeting — but had no
framework for offering what it actually *did* have (Google Meet), so the result was a calendar
event referencing "Zoom" with no real video link at all. The category system is the general fix:
as more interchangeable tools get added for other functions, they plug into this same registry
rather than each needing its own bespoke "what if the preferred one isn't available" logic.

## Knowledge

Uploaded documents (PDF/DOCX/TXT) and manually-entered facts, chunked and embedded via
pgvector for semantic retrieval into the agent's context per email.

---

# Permission Engine

Located at `lib/agent/permissions.ts`. This is one of the most important security layers in the
system — the model is never trusted to know or self-report what it's allowed to do.

**A permission level alone is not enough — real access must exist behind it:**

```
resolveSendCapability            → gmail.send / gmail.draft levels only
resolveCalendarWriteCapability   → calendar.write level, AND an actual Calendar
                                    connection (tenantHasCalendarAccess) — a
                                    configured "allowed" with no real Calendar
                                    scope granted resolves to "none"
canReadCalendar                  → calendar.read level, AND the same real
                                    Calendar connection check
resolveZoomCapability            → zoom.meet level, AND an actual row in
                                    zoom_connections — a configured "allowed"
                                    with no connected Zoom account resolves to
                                    "none"
```

This connection-checked design was previously only correct for Zoom; Calendar's two resolvers
used to check only the configured level, which meant a tenant could have `calendar.write =
allowed` in Settings with no real Calendar scope granted, and the model would still be offered
`create_calendar_event`/`propose_calendar_event`/`check_calendar_availability`. Both functions
now call the same `tenantHasCalendarAccess` check Zoom already used, closing that gap.

The result is handed to the model as an explicit, deterministic status line in its system
prompt ("Zoom is NOT connected — no Zoom meeting can be created or referenced...") rather than
leaving the model to infer availability from which tools happen to be present — cheap (no extra
model call, just a few more prompt tokens) and reduces reliance on catching a bad claim after
the fact.

---

# Capability Pre-Router

Located at `lib/agent/router/`. Sits between permission resolution and the main model call, and
exists purely for cost/latency — it never grants anything the permission engine wouldn't have.

```
1. Deterministic availability filter   → the tenant's real, connection-checked
                                          capability set (unchanged, hard gate)
2. Deterministic intent heuristics     → keyword/thread-history signals decide
                                          confidently-relevant / confidently-
                                          irrelevant capabilities for free
3. Cheap LLM classifier                → only for what step 2 left ambiguous,
                                          one small structured-output call,
                                          independent of the tenant's chosen
                                          main-agent model
4. Final tool set = available ∩ (heuristic-yes ∪ classifier-yes), always
   including the always-on baseline (create_draft/send_reply)
5. Escape hatch: request_additional_capability — re-runs the same real
   permission check for anything the router narrowed away, never trusts the
   model's request as proof it's allowed
6. Caching — the tenant's available-capability set is cached (short TTL,
   invalidated on permission/connection change); the classifier's per-email
   output deliberately isn't, since inbound emails are rarely identical
```

The classifier here **fails open** on error (it's a cost optimization, not a security layer —
an outage must never cause the agent to lose a capability it's otherwise authorized to use).

---

# AI Agent Pipeline

`lib/agent/run.ts` (email) and `lib/agent/chat.ts` (Google Chat) share the same tool registry
(`lib/agent/tools/`) and the same permission/capability logic, filtered per-surface so the two
never drift into offering different tools for the same underlying permission state.

```
Reserve message (idempotency) → permissions → capability router → knowledge
retrieval → system prompt (including explicit connection-status ground truth)
→ model call → tool call → content-safety check → grounding check → backend
permission re-check (again, independently of the router) → execute / draft
/ propose → repeat until a terminal action or MAX_AGENT_STEPS
```

## Tools (`lib/agent/tools/`)

```
send_reply                     create_draft
create_calendar_event          propose_calendar_event
create_zoom_meeting            propose_zoom_meeting
check_calendar_availability    check_pending_approvals
no_action_required             request_additional_capability (router escape hatch)
```

`check_calendar_availability` wraps `lib/calendar/client.ts`'s Google Calendar freebusy lookup
— previously unused by the agent entirely, so the model had no way to verify a time was actually
free before creating or proposing a meeting. Gated on `calendar.read`, available on both the
email and chat surfaces.

Each `ToolDefinition` carries a `capability` tag (used by the router), a `surfaces` tag
(`email`/`chat`), and optionally `marksCapabilityCompleted: true` — set only on tools whose
successful execution means a real external side effect actually just happened
(`create_zoom_meeting`, `create_calendar_event`). That flag feeds the grounding guard below.

## Content Safety (`lib/agent/content-safety.ts`)

Two checks applied to every customer-facing string a tool is about to act on (`body`,
`confirmationMessage`, `description`, `agenda`):

- **`stripKnownSafePlaceholders`** — silently removes genuinely cosmetic placeholders
  (`[Your Name]`, generic sign-offs) that can't misrepresent a fact.
- **`detectHallucinatedContent`** — hard-blocks (never silently edits) anything else: any
  leftover bracketed placeholder text of any wording, an unsubstituted `{{meeting_link}}` where
  substitution was supposed to have already happened, or any mention of Zoom when this tenant
  has no Zoom connection at all.

This replaced an earlier version whose bracket regex only matched a fixed whitelist of leading
words (`company|business|organization|...`) — a placeholder like `[zoom meeting link]` fell
outside that whitelist and passed straight through untouched. Extracted into its own module so
both the live agent loop and the human-approval send path (below) run the identical check.

## Grounding Guard (`lib/agent/grounding-guard.ts`)

The content-safety checks catch specific textual patterns; this catches the broader case they
can't: the model describing a business action as already done, confirmed, or booked when
nothing this run actually performed it. A single cheap structured-output LLM call compares the
draft reply text against two plain lists — the account's real available capabilities, and which
capabilities were *actually fulfilled with a real tool result* during this run (a ledger built
from `marksCapabilityCompleted`) — and flags any claim that outruns the ledger.

Runs before `send_reply`/`create_draft` execute, and **fails closed** (unlike the router's
classifier) — a check that can't run blocks the send and asks the model to reassess, since this
is a safety gate, not a cost optimization. Skipped entirely when an account has no
non-`gmail` capability available at all, so it costs nothing for plain support-only tenants.
Adding a future connector (Drive, Dropbox, etc.) requires no changes here — it only needs to tag
its own real-completion tool with `marksCapabilityCompleted`.

## Reaching the same checks from the approval path

`app/dashboard/approvals/actions.ts`'s `sendStoredConfirmation` — the function that actually
sends a customer confirmation once a human approves a pending Zoom/Calendar proposal — used to
run none of the above. It sends text the model wrote at proposal time, possibly days earlier,
with no re-check. It now runs the same `content-safety` check (with an
`allowMeetingLinkPlaceholder: false` flag, since substitution has already been attempted by this
point — a placeholder still present means substitution failed) and the same grounding check,
scoped to the one capability (`zoom` or `calendar`) that was just actually fulfilled. A
violation here doesn't roll back the approval — the real meeting/event already exists — it just
skips the confirmation email and logs loudly for manual follow-up, matching how a Gmail API
failure was already handled in that function.

This also surfaced and fixed a live bug in the same file: `confirmCalendarEvent` never passed
`createGoogleMeet: true` to `createEvent`, so an approved calendar proposal never actually had a
real meeting link — meaning a stored confirmation containing `{{meeting_link}}` would send that
literal placeholder text to the customer. It now only requests a Meet when the stored
confirmation actually expects one.

---

# Timezone Handling

`lib/agent/date-context.ts`'s `buildCurrentDateContext()` tells the model what day it is —
`today`, `tomorrow`, and a 14-day lookahead table for resolving phrases like "next Monday."
Previously hardcoded to UTC with no per-tenant override anywhere in the schema, which meant
"today" flipped to the next calendar date at UTC midnight regardless of where the business
actually was — for most of the US that lands mid-business-day (UTC midnight is mid-afternoon
Pacific time), so the agent's stated "today" was wrong for a large fraction of every business
day, not a rare edge case.

Fixed with a real `tenants.timezone` column (IANA string, e.g. `America/New_York`; migration
`007`), set on `/dashboard/settings`, defaulting to UTC until a tenant sets a real value. Both
`run.ts` and `chat.ts` fetch it and pass it into `buildCurrentDateContext()`, which anchors
"today" to that timezone (`lib/timezones.ts`'s `isValidTimezone()` validates it against the
runtime's actual `Intl` implementation, falling back to UTC safely rather than throwing on a
bad value).

This deliberately does **not** try to determine an individual customer's timezone — there's no
single correct answer for a business with clients across multiple zones, and a silent wrong
guess is worse than no guess. Instead, the system prompt instructs the model to: prefer a
timezone actually stated or implied in the conversation, default to the business's own timezone
otherwise, and **always spell out the timezone explicitly** whenever confirming a specific date
or time, so a wrong guess is visible and correctable rather than silent. The same principle
extends to the calendar tools' `startTime`/`endTime` parameters, which now explicitly require a
UTC offset baked into the ISO string (Google Calendar interprets an offset-less datetime as UTC,
silently creating events at the wrong moment otherwise).

---

# Knowledge / Business Context

PostgreSQL/pgvector-backed semantic search over tenant-uploaded documents and manually-entered
facts. The agent is explicitly instructed not to originate a policy, price, or commitment that
isn't grounded in knowledge, a rule, tool permission, or the email itself.

---

# Email Drafts & Approvals

```
Allowed             → model gets the real execution tool
Approval required   → model gets a propose_* tool only, which creates an
                       Approval row; a human approving it later triggers the
                       real backend action AND a re-run of content-safety +
                       grounding checks before the confirmation email sends
Denied               → model never receives the capability at all
```

# Google Calendar

Read, check availability, create/update/delete events, attendee handling — all gated through
the same connection-checked permission engine as Gmail. Calendar actions live in the
`calendar_actions` table and can be tied to an `approvals` row.

# Google Chat

`/api/webhooks/google-chat`, verified via Google's signed JWT. Matches the sender to a tenant
via the connected Gmail address or an explicit `tenants.owner_google_email` override. Shares the
same tool registry and permission logic as the email surface (filtered to `surfaces: ["chat"]`).

# SMS (Twilio)

`/api/twilio/incoming` currently understands a fixed APPROVE/DENY/permission-toggle command
vocabulary against pending approvals — not the full agent pipeline.

---

# Billing & Usage Metering

Tracks AI usage (across all three providers) and Twilio/SMS usage, applies a configurable
`usage_markup_percent` (default 3%), and reports to Stripe's Billing Meters API. Failed reports
are retried by a scheduled Inngest reconciliation job; the reconciliation status is recorded per
event.

---

# Database

Supabase/PostgreSQL. Base schema in `db/schema.sql`; incremental changes in `db/migrations/`.
**`db/schema.sql` is known to drift behind what's actually deployed** — several migrations exist
specifically to close gaps between the two (see `004_add_zoom_connections.sql`,
`005_multi_llm_support.sql`, `006 additional migration for multi LLM support.sql`,
`approvals calendar actions and status fixes.sql`, `007_tenant_timezone.sql`, and
`008_tool_preferences_and_meet_selection.sql`). Re-check actual deployed schema via migrations,
not `schema.sql` alone, before relying on a column/enum value being present. **Always run the
specific migration file against an existing database — never `schema.sql` itself, which
`CREATE TABLE`s from scratch and will fail (or worse, on some hosts, silently skip) against
tables that already have real data.** `schema.sql` is only for a genuinely fresh install.

Key tables:

```
tenants                  agent_configs             agent_permissions
gmail_connections        zoom_connections          calendar_events_cache
knowledge_documents      knowledge_chunks          agent_memories
email_actions            approvals                 calendar_actions
usage_events
```

Notable columns added after the base schema (see the migration list above for exact
provenance): `tenants.timezone` (IANA string, defaults `'UTC'`), `agent_configs.tool_preferences`
(jsonb, category id → preferred provider id — see "Preferences" above), and
`calendar_actions.request_google_meet` (boolean — the model's own explicit decision at proposal
time about whether a Google Meet link should be attached, read directly by the approval flow
rather than re-inferred from the confirmation text).

`email_action_status` enum: `processed`, `pending_approval`, `approved`, `rejected`, `sent`,
`failed`, plus `processing` (added by migration to match what `lib/agent/run.ts` actually writes
when reserving a message for idempotency — earlier project notes called `processing` invalid;
it has since been added to the enum rather than removed from the code).

RLS protects tenant-specific data where appropriate; trusted server-side operations use the
service-role client only after authentication and tenant ownership are established.

---

# Security Model

```
Layer 1 — Authentication         Valid Supabase session required
Layer 2 — Tenant Ownership       Authenticated user must own the tenant being accessed
Layer 3 — Permission + Connection   Configured level AND a real, checked connection
                                     (Calendar and Zoom both now require this — see
                                     "Permission Engine")
Layer 4 — Tool Exposure          The AI receives only tools cleared by Layers 1-3,
                                  further narrowed (never expanded) by the capability
                                  pre-router
Layer 5 — Backend Verification   The backend independently re-verifies permission
                                  before executing any tool call
Layer 6 — Content Safety         Outgoing text is checked for unresolved placeholders
                                  and impossible claims (e.g. referencing an
                                  unconnected integration) before it's used
Layer 7 — Grounding              A claim that a business action is "done" is checked
                                  against what this run actually, verifiably performed
Layer 8 — Approval                Approval-required actions are stored as pending and
                                  cannot execute until approved — and the eventual send
                                  re-runs Layers 6-7 rather than trusting the original
                                  proposal text unconditionally
```

**The AI model is never the final authority on whether an action happened, or on whether it's
allowed to say it did.**

---

# Production OAuth Flow

Google OAuth is separate from Supabase authentication:

```
/app/auth/callback                Supabase auth callback
/app/api/auth/google/callback     Google Gmail/Calendar OAuth connection
/app/api/auth/zoom/callback       Zoom OAuth connection
```

Google's callback validates state, exchanges the code, verifies the Prime Automatic session,
finds the tenant, encrypts and stores tokens (preserving an existing refresh token if Google
doesn't return a new one), records Calendar scope grant, registers the Gmail watch, and redirects
to Settings.

**Google OAuth is currently in Testing publishing status** — refresh tokens expire on a fixed
cycle regardless of use, which affects Gmail and Calendar (shared consent) but not Zoom (its own
independent token lifetime). Moving the OAuth consent screen out of Testing removes this
recurring-reconnect requirement; it's a Google Cloud Console setting, not a code change.

## Detecting a dead Google grant

`lib/gmail/client.ts`'s `getGmailClient()` — the single function every one of its 9 exported
functions calls first — makes a `getProfile()` diagnostic call as its very first live API
request, which is also the earliest point an expired/revoked token (`invalid_grant`) will
surface. That catch block detects it, calls `markGoogleReauthRequired()`
(`lib/google/authClient.ts`), and throws a short, clear error instead of letting the raw OAuth
error propagate.

This used to only be handled inside `readThread`'s own catch block, which wraps a *later* API
call — not the profile check, where `invalid_grant` almost always actually fires first. The
practical effect: a dead token got silently retried on every single Gmail push notification
(Inngest re-invoking `getHistoryChanges` → `getGmailClient` on each one), each attempt logging
the full raw error and never marking the connection for reconnect — an ever-growing wall of
identical log spam with no corresponding prompt anywhere telling the tenant to fix it.
`/dashboard/settings` also now actually reads `gmail_connections.google_reauth_required` (it
previously didn't select the column at all) and shows "Needs reconnect" for Google, the same way
it already did for Zoom's token expiry. The flag is cleared automatically
(`clearGoogleReauthRequired`) once the tenant successfully reconnects.

---

# Gmail Watch Renewal

`renew-gmail-watches` (Inngest, scheduled) renews any `gmail_connections.watch_expiry` within
24 hours of expiring, so the ingestion pipeline never silently stops after the original ~7-day
watch lapses.

---

# Inngest Functions

```
handle-gmail-history-changed   Processes Gmail push events through the agent pipeline;
                                also resolves draft-sent/draft-deleted events found in
                                the same history diff
renew-gmail-watches            Scheduled; renews watches expiring within 24h
reconcile-pending-drafts       Scheduled backup reconciliation for draft status, in
                                case a real-time resolution above was missed
reconcile-usage-reporting      Scheduled hourly; retries usage events not yet
                                successfully reported to Stripe
```

Registered at `/api/inngest`; the Inngest production app must stay synchronized with this
endpoint for background processing to run.

---

# Error Handling & Observability

Logged throughout the critical path: OAuth/token-exchange failures, Gmail/Calendar/Zoom
connection and API failures, tenant lookup failures, watch failures, history-processing
failures, message filtering/skipping decisions, AI processing failures, idempotency-reservation
failures, permission violations, content-safety and grounding-check violations (including which
check fired and why), approval-creation failures, and Stripe usage-reporting failures. Inngest
provides background-job execution history and retry visibility.

---

# Current Known Issues / Work Remaining

## Email Relevance / Automatic Mail

Promotions, newsletters, automated notifications, receipts, and billing notices still need
reliable classification so they aren't treated as customer conversations by default.

## `db/schema.sql` Drift

As noted above, `schema.sql` doesn't yet reflect every migration. Folding the migrations back
into a single current schema file (or moving to a proper migration-runner setup) would remove a
real footgun: reasoning about "the schema" from `schema.sql` alone is currently unreliable.

## Twilio SMS Scope

Inbound SMS only understands a fixed approval-response vocabulary, not the general agent
pipeline — a deliberate, narrower scope for now, not a bug, but worth being explicit about if
it's ever assumed to be "the agent, just over SMS."

## OpenAI Token Usage / Cost

Multi-provider support (OpenAI/Anthropic/Mistral) plus the capability router and grounding guard
each add their own token/call cost profile. Continued work: reducing unnecessary context,
limiting retrieved knowledge, watching the grounding guard's per-send classifier cost on
integration-heavy tenants, and retry/backoff handling for provider rate limits.

## Billing Verification

Usage is recorded and displayed; the displayed customer charge should continue to be tested
against actual multi-provider usage to confirm the markup/cost calculation is exactly right
across all three providers, not just OpenAI.

## Production Monitoring

No Sentry/equivalent yet — currently relying on Inngest's execution history plus the structured
console logging described above.

---

# Additional Testing Checklist

```
Gmail replies (send + draft)             Promotions/newsletters correctly skipped
Hallucination / unsupported-claim tests  Content-safety + grounding guard false-
                                          positive and false-negative checks
Long threads                             Multiple simultaneous incoming messages
Approval-required sends                  Allowed direct sends
Denied actions                           Calendar proposals + approvals
Calendar availability checks             Google Chat requests
SMS approve/deny commands                OAuth token refresh (Google + Zoom)
Gmail watch expiration/renewal           Inngest retries
Duplicate Pub/Sub notifications          Stripe usage reconciliation
Multi-provider model switching           Router false-exclusion rate (tool the
                                          email actually needed, but the router
                                          didn't offer)
```

---

# Remaining Product Work

- Drive/Dropbox as knowledge-storage connectors (planned; a generic `connector_credentials`
  table and per-connector `lib/connectors/<service>/` folder pattern have been designed but not
  yet built) — each would register into `lib/agent/tools/categories.ts` as a provider in a
  document-storage-style category, following the same pattern `video_meeting` established, rather
  than needing its own bespoke "what if this isn't connected" handling
- More tool categories as multi-provider functions get added (currently only `video_meeting`
  exists)
- A generalized capability-router pattern for future connectors beyond Calendar/Zoom
- WhatsApp as a messaging surface (deferred — would need its own inbound handler, likely via
  Twilio's WhatsApp Business API or Meta's Cloud API directly)
- Better agent conversation history / customer memory (`agent_memories` table exists; usage is
  still limited)
- More detailed billing controls, better approval notifications, automatic follow-ups
- Production monitoring/Sentry, more robust onboarding, subscription/checkout UX

---

# Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
GOOGLE_PUBSUB_TOPIC
GOOGLE_CHAT_AUDIENCE

ZOOM_CLIENT_ID
ZOOM_CLIENT_SECRET

OPENAI_API_KEY
ANTHROPIC_API_KEY
MISTRAL_API_KEY

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET

TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_FROM_NUMBER

TOKEN_ENCRYPTION_KEY

NEXT_PUBLIC_APP_NAME
NEXT_PUBLIC_APP_URL
```

Keep these in `.env.local` for local development and in the production deployment environment
for production. Never commit secrets to Git.

---

# Local Development

```
npm install
cp .env.example .env.local
npm run dev
```

# Production Deployment

Next.js on Vercel. Requires: Supabase production project, Google Cloud production OAuth config,
Zoom OAuth app, Google Pub/Sub, Inngest production environment synced against `/api/inngest`,
OpenAI/Anthropic/Mistral keys as needed, Stripe, Twilio, Google Chat.

---

# Important Routes

```
Auth        /app/auth/callback
            /app/api/auth/google/callback
            /app/api/auth/zoom/callback

Webhooks    /app/api/webhooks/gmail
            /app/api/webhooks/google-chat
            /app/api/webhooks/stripe
            /app/api/twilio/incoming

Inngest     /app/api/inngest

Dashboard   /dashboard
            /dashboard/agent
            /dashboard/settings
            /dashboard/settings/knowledge
            /dashboard/approvals
            /dashboard/billing
```

---

# Important Server-Side Components

```
lib/
├── agent/
│   ├── run.ts                    Email agent loop
│   ├── chat.ts                   Google Chat agent (shares tool registry with run.ts)
│   ├── permissions.ts            Permission engine (connection-checked)
│   ├── content-safety.ts         Placeholder/hallucination text checks
│   ├── grounding-guard.ts        LLM-based "was this actually done" check
│   ├── date-context.ts           Timezone-aware date-resolution table for the model
│   ├── models.ts                 Multi-provider model catalog
│   ├── llm/                      Per-provider adapters (openai, anthropic, mistral)
│   ├── router/                   Capability pre-router (heuristics + classifier)
│   └── tools/
│       ├── categories.ts         Tool "alternatives" registry + resolution (see Preferences)
│       └── ...                   One module per tool + the shared registry
│
├── billing/                      meter.ts, pricing.ts, stripe.ts
├── calendar/client.ts            Google Calendar API wrapper
├── gmail/client.ts               Gmail API wrapper (centralized invalid_grant detection)
├── zoom/client.ts                Zoom API wrapper
├── google/authClient.ts          Shared Google OAuth token handling
├── googlechat/                   matchTenant.ts, verify.ts
├── inngest/                      client.ts, functions.ts
├── integrations/                 config.ts, icons.tsx (per-integration UI metadata)
├── timezones.ts                  Curated IANA timezone list + validation
├── supabase/server.ts
└── crypto.ts
```

---

# Design Philosophy

The model is responsible for understanding the conversation, determining what's needed,
selecting a capability, drafting a response, and proposing actions.

The application backend is responsible for authentication, tenant isolation, permission
enforcement (against real connections, not just configured levels), approval enforcement, API
access, executing actions, verifying the model's claims about what it did before anything
customer-facing goes out, auditing, and billing.

This separation is fundamental, and has been reinforced rather than loosened as the project has
grown: every incident that's come up (a fabricated Zoom confirmation, a literal
`{{meeting_link}}` placeholder reaching a customer, a permission level with no real connection
behind it) has been fixed by adding another backend check the model can't talk its way around,
not by trusting the model more carefully worded instructions.

---

# Development Philosophy

1. Build the complete workflow.
2. Verify each external integration independently.
3. Trace failures through the entire pipeline.
4. Keep permissions outside the model — and keep verifying that "permission" actually means
   "real, connected access," not just a configured setting.
5. Make risky actions approval-based, and don't assume a proposal's stored content is still
   trustworthy by the time a human approves it — re-check at send time too.
6. Meter actual usage, across every model provider in use.
7. Optimize AI cost only after correctness and safety checks are in place, not before.
8. Expand functionality (new connectors, new surfaces) incrementally, designing each new
   integration to plug into the existing capability-tag and content-safety machinery rather than
   growing its own special-cased checks.

---

# Status Summary

| Area                            | Status                  |
| -------------------------------- | ------------------------ |
| Next.js application              | ✅ Implemented            |
| Production deployment            | ✅ Implemented            |
| Multi-tenancy / tenant isolation | ✅ Implemented            |
| Agent settings UI (redesigned)   | ✅ Implemented            |
| Multi-provider AI (OpenAI/Anthropic/Mistral) | ✅ Implemented |
| Permission engine (connection-checked) | ✅ Implemented       |
| Capability pre-router             | ✅ Implemented            |
| Content-safety checks             | ✅ Implemented            |
| Grounding guard                   | ✅ Implemented            |
| Approval-path content re-checks   | ✅ Implemented            |
| Gmail OAuth / Calendar OAuth (shared) | ✅ Implemented        |
| Zoom OAuth                        | ✅ Implemented            |
| check_calendar_availability tool  | ✅ Implemented            |
| Per-tenant timezone (business-anchored "today") | ✅ Implemented |
| Tool alternatives / categories (video meeting: Zoom vs. Meet) | ✅ Implemented |
| Google invalid_grant detection + reconnect prompt | ✅ Implemented |
| Google Chat                       | ✅ Implemented            |
| Twilio SMS (approval commands only) | ✅ Implemented (narrow scope) |
| Usage metering / Stripe Billing Meters | ✅ Implemented       |
| Knowledge/context system (pgvector) | ✅ Implemented          |
| Email relevance filtering         | 🟡 In progress            |
| `db/schema.sql` drift cleanup     | 🟡 In progress            |
| Drive/Dropbox connectors          | ⏳ Planned, not started   |
| WhatsApp surface                  | ⏳ Deferred               |
| Production monitoring/Sentry      | ⏳ Remaining              |

---

# Security Reminder

Never commit `.env.local` or any Google/Supabase/OpenAI/Anthropic/Mistral/Zoom/Stripe/
Twilio/Inngest production secrets to the repository. OAuth refresh tokens and other credentials
stay encrypted and server-side.

---

# Long-Term Vision

Prime Automatic is being built as a multi-tenant AI business operations layer, not a
single-purpose email responder:

```
Email · SMS · Google Chat · Calendar · Zoom · Business Knowledge · Customer Context
                                  ↓
                            Prime Automatic
                                  ↓
        Reasoning + Permission Engine + Content-Safety/Grounding Checks
                                  ↓
                               Actions
```

The goal is to let businesses automate repetitive communication and administrative work while
retaining explicit, verifiable control over what the AI is allowed to do — and, increasingly,
verifiable proof that what it says happened actually did.
