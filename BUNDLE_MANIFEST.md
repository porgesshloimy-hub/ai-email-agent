# Chat Feature — Full File Bundle

Every current file related to the owner chat assistant (personas, approval resolution,
memory schema, delayed replies, typing indicator, etc.), pulled directly from the working
sandbox — not reconstructed from chat history. This replaces the need to track individual
files across the whole conversation.

## How to apply this

1. **Extract this zip directly into the root of your project repo**, letting it overwrite
   existing files at matching paths. Every path inside this zip (e.g.
   `lib/agent/chat.ts`, `app/dashboard/components/AgentChatPanel.tsx`) is already the real,
   correct destination path — no renaming or guessing needed.
2. **Run any migrations you haven't already run** — see `db/migrations/`. All nine
   (009–017) are idempotent (safe to re-run even if already applied), so if you're unsure
   which ones you've run, it's safe to just run all nine again in order.
3. **Commit and do a full redeploy** (not a partial file copy) so Vercel rebuilds from a
   fully consistent set of files.
4. Confirm `app/api/agent-chat/typing/route.ts` specifically exists after extracting — this
   was the one confirmed missing from the last deploy (a 404 on that endpoint is what
   surfaced the whole drift issue).

## What's NOT in this bundle

Anything from this project that existed before this whole chat-feature conversation began
(the original email pipeline, dashboard pages unrelated to chat, etc.) — this bundle is
scoped specifically to what was built/changed across this thread, not the whole repo.

## Migrations included

```
009_agent_memory_system.sql
010_personas_connections.sql
011_owner_persona_seed.sql
012_pending_owner_confirmations.sql
013_owner_chat_history.sql
014_owner_persona_writing_style.sql
015_owner_chat_message_processed.sql
016_owner_typing_tracking.sql
017_agent_replying_status.sql
```

## Full file list

```
app/api/agent-chat/route.ts
app/api/agent-chat/send/route.ts
app/api/agent-chat/typing/route.ts
app/api/inngest/route.ts
app/api/webhooks/google-chat/route.ts
app/dashboard/agent-chat/page.tsx
app/dashboard/components/AgentChatPanel.tsx
app/dashboard/components/AgentChatWidget.tsx
app/dashboard/layout.tsx
lib/agent/approval/explicitness-heuristic.ts
lib/agent/approval/pending-confirmation-check.ts
lib/agent/approval/resolve.ts
lib/agent/chat-history/build-context.ts
lib/agent/chat-history/persist.ts
lib/agent/chat.ts
lib/agent/date-context.ts
lib/agent/permissions.ts
lib/agent/personas/apply-overrides.ts
lib/agent/personas/resolve.ts
lib/agent/personas/types.ts
lib/agent/run.ts
lib/agent/tools/check-calendar-availability.ts
lib/agent/tools/check-recent-emails.ts
lib/agent/tools/compose-email-draft.ts
lib/agent/tools/create-calendar-event.ts
lib/agent/tools/index.ts
lib/agent/tools/send-email.ts
lib/agent/tools/types.ts
lib/calendar/client.ts
lib/gmail/client.ts
lib/google/authClient.ts
lib/inngest/client.ts
lib/inngest/functions.ts
lib/supabase/server.ts
README.md
```
