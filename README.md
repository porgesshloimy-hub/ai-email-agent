# Prime Automatic

Prime Automatic is an AI-powered business email agent that connects to Gmail and Google Calendar, understands incoming business conversations, and can safely take actions on behalf of a business according to tenant-specific instructions, rules, and permissions.

The system is designed around **controlled automation**: the AI can reason about an email and determine what should happen, but backend permission checks—not the AI model—ultimately determine which actions it is allowed to perform.

---

# Current Status

Prime Automatic has progressed beyond the initial scaffold into a working production-oriented MVP.

The core end-to-end infrastructure is now connected:

**Google Gmail → Pub/Sub → Inngest → Gmail history → AI agent → permission engine → action/approval → Gmail or Calendar**

The application is deployed and accessible through the production domain, with Supabase, Google OAuth, OpenAI, Stripe billing infrastructure, Google Pub/Sub, and Inngest connected.

The remaining work is primarily hardening, testing, UX improvements, reducing AI costs, and expanding functionality.

---

# Core Principles

- **Safe by default**
- **Human approval for risky actions**
- **Tenant isolation**
- **Explicit capability checks**
- **Auditable actions**
- **Tenant-specific business context**
- **The AI never bypasses backend permissions**
- **The AI only receives tools it is actually permitted to use**
- **Actions requiring approval create proposals rather than executing immediately**

---

# Architecture

Prime Automatic is built around the following architecture:

```
Gmail
  │
  │ Gmail Push Notification
  ▼
Google Cloud Pub/Sub
  │
  ▼
/api/webhooks/gmail
  │
  ▼
Inngest
  │
  ▼
Gmail History API
  │
  ▼
Incoming Email
  │
  ▼
Agent Pipeline
  │
  ├── Tenant identification
  ├── Business context
  ├── Custom instructions
  ├── Rules
  ├── Permissions
  ├── Knowledge
  └── OpenAI
        │
        ▼
   Tool selection
        │
        ├── Allowed action
        │
        └── Approval-required action
                 │
                 ▼
             Approvals
                 │
                 ▼
        Human approval/rejection
                 │
                 ▼
          Gmail / Calendar
```

---

# Technology Stack

## Frontend / Application

- Next.js
- App Router
- TypeScript
- React
- Server Actions
- Vercel deployment

## Database / Authentication

- Supabase
- PostgreSQL
- Supabase Auth
- Row Level Security
- Tenant-based data isolation

## AI

- OpenAI API
- `gpt-5-nano` currently used for agent processing
- Tool/function calling
- Tenant-specific instructions and business context

## Google

- Gmail API
- Google Calendar API
- Google OAuth 2.0
- Google Cloud Pub/Sub
- Google Chat integration

## Background Processing

- Inngest
- Gmail push events
- Scheduled Gmail watch renewal
- Scheduled billing reconciliation

## Billing

- Stripe Billing
- Stripe Billing Meters API
- Usage-based metering
- Configurable tenant markup

---

# Authentication & Tenancy

Implemented:

- Supabase authentication
- Login/session handling
- Per-user tenant identification
- Tenant ownership checks
- Multi-tenant architecture
- Tenant-isolated data
- Server-side authentication checks
- Server-side tenant authorization

The application does not rely solely on frontend authentication.

Server actions and backend routes identify the authenticated Supabase user and then locate the tenant belonging to that user.

This prevents one tenant from accessing another tenant's configuration or actions.

---

# Dashboard

The application includes dashboard sections for:

- Dashboard/home
- Agent
- Settings
- Approvals
- Billing

The Agent section allows the business owner to configure how the agent operates.

The application uses the authenticated tenant to load the correct configuration each time the page is opened, so settings are persisted per business rather than being hardcoded into the UI.

---

# Agent Configuration

Each tenant can maintain its own agent configuration.

Implemented configuration includes:

## Custom Instructions

Businesses can provide instructions such as:

- How the agent should communicate
- How formal or casual replies should be
- Business-specific procedures
- Special handling instructions
- Things the agent should or should not do

Instructions are persisted in `agent_configs`.

## Rules

Businesses can add and remove individual rules.

Rules are stored per tenant and loaded into the agent's context.

Rules are validated on the server, including:

- Empty-rule prevention
- Maximum rule length
- Tenant ownership

## Permissions

The permission system currently supports:

```
gmail.read
gmail.draft
gmail.send
gmail.archive
gmail.delete
calendar.read
calendar.write
```

Each capability can be assigned one of:

```
denied
approval_required
allowed
```

Permissions are enforced in backend code.

The model itself is not trusted to determine whether it is allowed to perform an action.

---

# Gmail Integration

Implemented:

- Google OAuth
- Gmail authorization
- Gmail access token storage
- Encrypted token storage
- Refresh token handling
- Gmail account identification
- Gmail connection persistence
- Gmail connection status
- Gmail message retrieval
- Gmail thread retrieval
- Gmail draft creation
- Gmail draft sending
- Thread-aware replies
- Gmail push notifications

The OAuth flow also requests the Google Calendar scopes during the same Google authorization process.

The Google connection stores:

- Gmail address
- Encrypted access token
- Encrypted refresh token
- Token expiration
- Calendar authorization state
- Gmail history ID
- Gmail watch expiration

---

# Gmail Push Processing

Prime Automatic does not rely on constantly polling Gmail.

Google Gmail watches are registered through the Gmail API.

When Gmail detects a relevant mailbox change:

```
Gmail
  ↓
Google Pub/Sub
  ↓
/api/webhooks/gmail
  ↓
Inngest event
```

The webhook intentionally performs minimal work and immediately queues the event for background processing.

This prevents Pub/Sub requests from timing out while the AI agent processes an email.

---

# Gmail History Processing

The Inngest Gmail handler:

1. Receives the Gmail email address and history ID.
2. Finds the corresponding tenant.
3. Loads the previously processed Gmail history ID.
4. Requests Gmail history changes.
5. Identifies newly added messages.
6. Retrieves/processes those messages.
7. Sends each incoming email through the AI agent.
8. Updates the stored history ID only after processing succeeds.

The history ID is deliberately updated after successful processing so that an AI failure does not silently cause an email to be lost.

## Gmail Message Idempotency

Incoming Gmail messages are protected against duplicate processing using the `email_actions` table.

The agent first checks for an existing action using the tenant and Gmail message ID, then reserves the message before calling OpenAI or creating a Gmail draft. A unique database constraint on the tenant/message combination prevents concurrent Inngest executions from processing the same message twice.

The current `email_action_status` values are:

```
processed
pending_approval
approved
rejected
sent
failed
```

Failed processing is retained as an audit record rather than being silently deleted.

---

# Inngest

Inngest is now connected and synchronized with the deployed application.

Current background functions include:

### Gmail History Handler

```
handle-gmail-history-changed
```

Processes Gmail push events and sends new messages through the agent.

### Gmail Watch Renewal

```
renew-gmail-watches
```

Runs periodically and renews Gmail watches approaching expiration.

Gmail watches expire after roughly seven days, so the application checks for watches expiring within the next 24 hours.

### Usage Reconciliation

```
reconcile-usage-reporting
```

Runs hourly and retries usage events that were not successfully reported to Stripe.

---

# AI Agent Pipeline

The agent pipeline is implemented in:

```
lib/agent/run.ts
```

The basic flow is:

```
Incoming email
    ↓
Tenant identification
    ↓
Gmail message filtering / relevance checks
    ↓
Load tenant configuration
    ↓
Load business context / knowledge
    ↓
Load permissions
    ↓
Reserve message for idempotency
    ↓
OpenAI
    ↓
Tool/function selection
    ↓
Backend permission verification
    ↓
Execute, draft, or propose action
```

The ingestion pipeline is being hardened so that promotions, newsletters, automated notifications, billing notices, and other non-conversational mail are not automatically treated as customer conversations.

The agent is also being tightened to avoid inventing business policies, prices, commitments, or instructions that are not present in tenant configuration, business knowledge, or the email itself. When the required information is not known, the safe behavior is to avoid making up an answer and use a draft/approval path or take no action.

The model receives only the tools appropriate for the current permission configuration.

Even when a tool is presented to the model, the backend performs a second permission check before actually executing the action.

---

# OpenAI

OpenAI is integrated into the live agent pipeline.

The agent uses function/tool calling to determine what action should be taken.

The current production configuration uses `gpt-5-nano`.

OpenAI usage is also incorporated into the application's usage-metering system.

Earlier testing exposed the organization's GPT-4o token-per-minute limit:

```
Limit: 30,000 TPM
```

This is a rate-limit/capacity issue rather than an OAuth, Gmail, Pub/Sub, or Inngest connection failure.

Reducing unnecessary context and token usage is therefore an active optimization area.

---

# Knowledge / Business Context

The agent is designed to use tenant-specific business knowledge rather than relying solely on the model's general knowledge.

Business information can be incorporated into the agent context so that different businesses can have different:

- Policies
- Services
- Procedures
- FAQs
- Customer-response information
- Internal instructions

Knowledge retrieval is intended to use PostgreSQL/pgvector for semantic search.

---

# Permission Engine

The permission engine is one of the most important security layers in the system.

Located at:

```
lib/agent/permissions.ts
```

The permission engine determines what the agent can do for a particular tenant.

Permission levels:

```
denied
approval_required
allowed
```

Example:

```
gmail.read       → allowed
gmail.draft      → allowed
gmail.send       → approval_required
gmail.delete     → denied
calendar.read    → allowed
calendar.write   → approval_required
```

The AI cannot override these settings.

---

# Email Drafts & Approvals

Email sending supports a human-approval workflow.

When sending requires approval:

```
Incoming email
    ↓
AI determines a reply should be sent
    ↓
AI proposes the action
    ↓
Approval record created
    ↓
Draft/action appears in Approvals
    ↓
User approves
    ↓
Backend re-checks tenant ownership/permissions
    ↓
Email is sent
```

The model does not receive a tool capable of bypassing the approval requirement.

For gated actions, it receives a proposal tool instead.

This distinction is intentional:

```
Allowed
→ model can use the actual execution tool

Approval required
→ model can only create a proposal

Denied
→ model does not receive the capability
```

---

# Google Calendar

Google Calendar is integrated into the same permission architecture as Gmail.

Implemented functionality includes:

- Calendar authorization
- Reading calendar information
- Checking availability
- Creating events
- Updating events
- Deleting events
- Attendee handling
- Permission-controlled calendar writes

Calendar actions are represented in the database and can be associated with approvals.

For example, when calendar writing requires approval:

```
AI
 ↓
propose_calendar_event
 ↓
calendar_actions
 ↓
pending_approval
 ↓
approvals
 ↓
human approval
 ↓
Google Calendar
```

The actual Calendar API call is not made until the approved backend action executes.

---

# Google Chat

Google Chat integration is implemented.

The agent can be accessed directly from Google Chat.

Supported use cases include:

- Asking the agent about pending work
- Requesting calendar actions
- Interacting with the agent without sending an email

Google Chat requests are verified using Google's signed JWT mechanism.

The sender is matched to the appropriate tenant using the connected Gmail address or an alternate address configured in Settings.

Google Chat webhook:

```
/api/webhooks/google-chat
```

---

# Billing & Usage Metering

Usage-based billing infrastructure is implemented.

The system tracks AI usage and Twilio/SMS usage and reports usage to Stripe.

The tenant has a configurable:

```
usage_markup_percent
```

The default markup is:

```
3%
```

The system:

1. Records usage.
2. Calculates the billable amount.
3. Applies the tenant's markup.
4. Reports usage to Stripe's Billing Meters API.
5. Records whether the event was successfully reported.
6. Retries failed reports through the scheduled reconciliation job.

The billing dashboard exposes usage/charges to the tenant.

---

# Stripe

Stripe Billing Meter infrastructure is connected.

The intended billing model is usage-based rather than a simple flat subscription.

The application uses a Stripe meter for usage such as:

```
usage_cost_cents
```

A metered price can then charge the customer according to their actual usage.

Stripe webhook infrastructure is also part of the application architecture.

---

# Database

Supabase/PostgreSQL is used as the application's primary database.

Important tables include functionality for:

- Tenants
- Agent configurations
- Agent permissions
- Gmail connections
- Approvals
- Calendar actions
- Usage events
- Knowledge/business information
- Billing information

Database migrations are stored under:

```
db/migrations/
```

The schema is maintained in:

```
db/schema.sql
```

Tenant-specific data is protected using Row Level Security where appropriate, while trusted server-side operations use the service-role client only after authentication and tenant ownership have been established.

---

# Security Model

Security is intentionally layered.

## Layer 1 — Authentication

The user must have a valid Supabase session.

## Layer 2 — Tenant Ownership

The authenticated user must belong to the tenant being accessed.

## Layer 3 — Permission Configuration

The tenant's configured permission determines whether an action is:

```
denied
approval_required
allowed
```

## Layer 4 — Tool Exposure

The AI receives only the tools it is permitted to consider.

## Layer 5 — Backend Verification

The backend independently verifies the permission before executing a tool call.

## Layer 6 — Approval

Approval-required actions are stored as pending actions and cannot execute until approved.

---

# Important Security Principle

**The AI model is never the final authority on whether an action is allowed.**

For example, even if the model attempts to call:

```
create_calendar_event
```

the backend checks the actual tenant permission before executing it.

Likewise, when Calendar writing is approval-only, the execution tool is unavailable and the model can only create a proposal.

---

# Production OAuth Flow

Google OAuth is handled separately from Supabase authentication.

There are two important callback flows:

```
/app/auth/callback
```

handles the Supabase authentication callback.

```
/app/api/auth/google/callback
```

handles the Google Gmail/Calendar OAuth connection.

The Google callback:

1. Validates the OAuth state.
2. Exchanges Google's authorization code for tokens.
3. Retrieves the Google account email.
4. Verifies the user is authenticated with Prime Automatic.
5. Finds the user's tenant.
6. Encrypts and stores Google tokens.
7. Preserves an existing refresh token if Google does not return a new one.
8. Records Calendar authorization.
9. Registers the Gmail watch.
10. Saves the Gmail history/watch information.
11. Redirects back to Settings.

---

# Gmail Watch Renewal

Gmail push watches expire periodically.

The application therefore maintains:

```
watch_expiry
```

for each Gmail connection.

The scheduled Inngest function looks for watches expiring soon and renews them automatically.

This prevents the Gmail ingestion pipeline from silently stopping after the original watch expires.

---

# Error Handling & Observability

The system logs failures throughout the critical pipeline.

Examples include:

- Google OAuth failures
- Token exchange failures
- Gmail connection failures
- Tenant lookup failures
- Gmail watch failures
- Gmail history failures
- Gmail message filtering/skipping
- AI processing failures
- Email action reservation/idempotency failures
- Permission violations
- Approval creation failures
- Calendar API failures
- Stripe usage-reporting failures

Inngest provides background-job execution history and retry visibility.

---

# Current Production Test Flow

The core Gmail automation can now be tested end-to-end.

A test email can be sent to the connected Gmail account and should follow:

```
Email arrives
 ↓
Gmail detects change
 ↓
Pub/Sub notification
 ↓
Gmail webhook
 ↓
Inngest event
 ↓
Gmail history lookup
 ↓
New message retrieved
 ↓
Agent processing
 ↓
OpenAI
 ↓
Permission evaluation
 ↓
Draft / proposal / action
```

The current testing phase is focused on verifying each step individually and optimizing the AI request size.

---

# Current Known Issues / Work Remaining

## Email Relevance / Automatic Mail

The agent must not reply to every message that enters the Inbox. Promotions, newsletters, automated notifications, receipts, billing notices, system alerts, and similar mail need to be classified and skipped unless there is a clear business reason to handle them. This is an active hardening area.

## Hallucination / Unsupported Business Claims

The agent must not invent policies, prices, refunds, commitments, procedures, or other business facts. Responses should be grounded in the tenant's custom instructions, explicit rules, retrieved business knowledge, and the actual email. If the necessary information is unavailable, the agent should not fabricate an answer.

## Gmail Action Status / Failure Handling

The `email_actions` workflow now uses the database's actual `email_action_status` enum. The temporary `processing` value is not valid and must not be written to the database. Failed reservations or processing errors are represented with `failed` and retained for auditing.

## OpenAI Token Usage

The previous GPT-4o organization limit was:

```
30,000 tokens per minute (historical testing limit)
```

Large agent prompts/context can consume a significant portion of that limit.

The next optimization work should focus on:

- Reducing unnecessary context
- Reducing duplicated instructions
- Limiting retrieved knowledge
- Reducing tool/schema overhead
- Avoiding unnecessarily large email/thread payloads
- Choosing a more cost-efficient model where appropriate
- Adding appropriate retry/backoff handling for 429 responses

---

## Billing Verification

The application currently records and displays usage, but billing calculations should continue to be tested against actual OpenAI usage to ensure the displayed customer charge precisely matches the intended markup and cost calculation.

---

## Additional Testing

The following should continue to be tested:

- Gmail replies
- Promotions/newsletters/automated emails are skipped
- Hallucination/unsupported-business-fact tests
- Long threads
- Multiple simultaneous incoming messages
- Approval-required sends
- Allowed direct sends
- Denied actions
- Calendar proposals
- Calendar approvals
- Calendar availability
- Google Chat requests
- OAuth token refresh
- Gmail watch expiration/renewal
- Inngest retries
- Duplicate Pub/Sub notifications
- Stripe usage reconciliation

---

# Remaining Product Work

The core platform is functioning, but several areas can still be expanded.

Potential next development areas include:

- Better agent conversation history
- More sophisticated knowledge retrieval
- Additional Gmail actions
- More Calendar actions
- SMS/Twilio integration
- Google Chat expansion
- More detailed billing controls
- Better approval notifications
- Email classification
- Automatic follow-ups
- Customer/contact memory
- Improved agent testing tools
- Production monitoring/Sentry
- More robust onboarding
- Subscription/checkout UX
- Cost optimization
- Model selection based on task complexity

---

# Environment Variables

The application uses environment variables for external services and secrets.

Examples include:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET

OPENAI_API_KEY

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET

INNGEST_EVENT_KEY
INNGEST_SIGNING_KEY

GOOGLE_CHAT_PROJECT_NUMBER
```

Exact variables should be kept in `.env.local` during local development and in the production deployment environment for production.

Secrets must never be committed to Git.

---

# Local Development

Install dependencies:

```
npm install
```

Create the environment file:

```
cp .env.example .env.local
```

Run the development server:

```
npm run dev
```

The application can then be accessed locally through the Next.js development server.

---

# Production Deployment

The application is deployed using Next.js/Vercel.

Important production integrations include:

- Supabase production project
- Google Cloud production OAuth configuration
- Gmail API
- Google Calendar API
- Google Pub/Sub
- Inngest production environment
- OpenAI
- Stripe
- Google Chat

The Inngest production application must be synchronized with the deployed `/api/inngest` endpoint.

---

# Inngest Endpoint

The application exposes the Inngest functions through:

```
/api/inngest
```

The route registers:

```
handleGmailHistoryChanged
renewGmailWatches
```

and other background functions as they are added.

Inngest must be synchronized against the deployed production endpoint before production background processing will work.

---

# Important Routes

## Authentication

```
/app/auth/callback
/app/api/auth/google/callback
```

## Gmail

```
/app/api/webhooks/gmail
```

## Google Chat

```
/app/api/webhooks/google-chat
```

## Stripe

```
/app/api/webhooks/stripe
```

## Inngest

```
/app/api/inngest
```

## Dashboard

```
/dashboard
/dashboard/agent
/dashboard/settings
/dashboard/approvals
/dashboard/billing
```

---

# Important Server-Side Components

```
lib/
├── agent/
│   ├── run.ts
│   ├── permissions.ts
│   └── chat.ts
│
├── billing/
│   └── meter.ts
│
├── calendar/
│   └── client.ts
│
├── gmail/
│   └── client.ts
│
├── inngest/
│   ├── client.ts
│   └── functions.ts
│
├── supabase/
│   └── server.ts
│
└── crypto.ts
```

---

# Design Philosophy

Prime Automatic is intentionally different from a simple "AI that sends emails."

The model is responsible for:

- Understanding the conversation
- Determining what the user appears to need
- Selecting an appropriate capability
- Drafting a response
- Proposing actions

The application backend is responsible for:

- Authentication
- Tenant isolation
- Permission enforcement
- Approval enforcement
- API access
- Executing actions
- Auditing actions
- Billing

This separation is fundamental to the architecture.

---

# Development Philosophy

The project favors a practical, production-oriented approach:

1. Build the complete workflow.
2. Verify each external integration independently.
3. Trace failures through the entire pipeline.
4. Keep permissions outside the model.
5. Make risky actions approval-based.
6. Meter actual usage.
7. Optimize AI costs only after the end-to-end workflow is working.
8. Expand functionality incrementally.

---

# Status Summary

| AreaStatus                     |                        |
| ------------------------------ | ---------------------- |
| Next.js application            | ✅ Implemented          |
| Production deployment          | ✅ Implemented          |
| Supabase                       | ✅ Connected            |
| Authentication                 | ✅ Implemented          |
| Multi-tenancy                  | ✅ Implemented          |
| Tenant isolation               | ✅ Implemented          |
| Agent settings                 | ✅ Implemented          |
| Custom instructions            | ✅ Implemented          |
| Agent rules                    | ✅ Implemented          |
| Permission controls            | ✅ Implemented          |
| Gmail OAuth                    | ✅ Implemented          |
| Calendar OAuth                 | ✅ Implemented          |
| Encrypted Google tokens        | ✅ Implemented          |
| Gmail message retrieval        | ✅ Implemented          |
| Gmail drafts                   | ✅ Implemented          |
| Gmail sending                  | ✅ Implemented          |
| Gmail Pub/Sub                  | ✅ Connected            |
| Gmail history processing       | ✅ Implemented          |
| Gmail message idempotency      | ✅ Implemented          |
| Email action failure auditing  | 🟡 In progress          |
| Email relevance filtering      | 🟡 In progress          |
| Gmail watch renewal            | ✅ Implemented          |
| Inngest                        | ✅ Connected and synced |
| OpenAI agent                   | ✅ Connected            |
| Tool/function calling          | ✅ Implemented          |
| Approval workflow              | ✅ Implemented          |
| Calendar integration           | ✅ Implemented          |
| Calendar approval workflow     | ✅ Implemented          |
| Google Chat                    | ✅ Implemented          |
| Usage metering                 | ✅ Implemented          |
| Stripe Billing Meters          | ✅ Connected            |
| Usage reconciliation           | ✅ Implemented          |
| Knowledge/context system       | ✅ Implemented          |
| Production end-to-end testing  | 🟡 In progress         |
| OpenAI cost optimization       | 🟡 In progress         |
| Billing verification           | 🟡 In progress         |
| Production monitoring/Sentry   | ⏳ Remaining            |
| Expanded product functionality | ⏳ Ongoing              |

---

# Security Reminder

Never commit:

```
.env.local
```

or any Google, Supabase, OpenAI, Stripe, Inngest, or other production secrets to the repository.

Google OAuth refresh tokens and other credentials must remain encrypted and server-side.

---

# Long-Term Vision

Prime Automatic is being built as a multi-tenant AI business agent rather than a single-purpose email responder.

The long-term system can act as a business's operational AI layer:

```
Email
SMS
Google Chat
Calendar
Business Knowledge
Customer Context
        ↓
   Prime Automatic
        ↓
Reasoning + Permissions
        ↓
Actions
```

The goal is to allow businesses to automate repetitive communication and administrative work while retaining explicit control over what the AI is allowed to do.