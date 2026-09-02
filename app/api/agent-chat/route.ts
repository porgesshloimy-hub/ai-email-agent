import { NextRequest, NextResponse } from "next/server";
import {
  createServerSupabase,
  createServiceSupabase,
} from "@/lib/supabase/server";
import { handleChatMessage } from "@/lib/agent/chat";

/**
 * Resolves the authenticated dashboard user's own tenant. Same pattern
 * as app/dashboard/agent/actions.ts's getAuthenticatedTenantId() —
 * duplicated here rather than extracted into a shared helper, matching
 * this codebase's existing convention of each server-side entry point
 * declaring its own copy.
 */
async function getAuthenticatedTenantId(): Promise<string> {
  const userSupabase = await createServerSupabase();

  const {
    data: { user },
    error: userError,
  } = await userSupabase.auth.getUser();

  if (userError || !user) {
    throw new Error("Not authenticated");
  }

  const { data: tenant, error: tenantError } = await userSupabase
    .from("tenants")
    .select("id")
    .eq("owner_user_id", user.id)
    .single();

  if (tenantError || !tenant) {
    throw new Error("Tenant not found");
  }

  return tenant.id;
}

/**
 * Returns owner chat history for the widget's display — sourced
 * directly from owner_chat_messages (migration 013), a completely
 * different, much larger window than lib/agent/chat-history's
 * fetchChatHistoryTurns(), which trims to ~10 messages / 30 hours
 * specifically to bound what's re-sent to the LLM on every call (a
 * real, recurring token cost). Showing a human the fuller transcript
 * has no LLM-cost implication at all — it's just a database read and a
 * render — so the two are deliberately NOT the same cap.
 *
 * Supports `?before=<ISO timestamp>` for keyset pagination, so a very
 * long-lived account's full history is reachable without ever loading
 * thousands of rows in one request. Raised the single-page size from
 * the original 50 to 100 as a reasonable default; the client requests
 * older pages via `before` as the owner scrolls up, rather than this
 * route trying to guess a "whole history" cutoff.
 *
 * Also supports `?after=<ISO timestamp>`, added for the delayed-batch
 * reply flow: since a reply may now arrive asynchronously (up to
 * 7-20+ seconds later, via lib/inngest/functions.ts's
 * processDelayedChatReply), the widget no longer holds one long
 * request open waiting for it — it polls this endpoint with `after`
 * set to the last message it already has, until the new reply shows
 * up. Ascending order for `after` (oldest-of-the-new-batch first),
 * versus `before`'s descending order for backward pagination.
 */
export async function GET(request: NextRequest) {
  try {
    const tenantId = await getAuthenticatedTenantId();
    const supabase = createServiceSupabase();

    const before = request.nextUrl.searchParams.get("before");
    const after = request.nextUrl.searchParams.get("after");

    if (after) {
      /**
       * `chat_agent_replying` is queried on every poll tick. As of the
       * backend-pacing move, this is a real, accurate signal covering
       * two distinct things under one flag: genuine multi-second
       * server-side pacing between parts of a reply
       * (lib/agent/chat.ts, via lib/agent/chat-pacing.ts), AND the
       * later, rare phantom "changed their mind mid-typing" simulation
       * (lib/inngest/functions.ts's processDelayedChatReply) — a
       * typing indicator with no message behind it at all. The client
       * doesn't need to distinguish which case is which; it just shows
       * "typing" whenever this is true.
       */
      const [messagesResult, tenantResult] = await Promise.all([
        supabase
          .from("owner_chat_messages")
          .select("id, role, content, replied_to_message_id, created_at")
          .eq("tenant_id", tenantId)
          .gt("created_at", after)
          .order("created_at", { ascending: true })
          .limit(50),
        supabase.from("tenants").select("chat_agent_replying").eq("id", tenantId).single(),
      ]);

      if (messagesResult.error) {
        console.error("FAILED TO POLL FOR NEW CHAT MESSAGES:", messagesResult.error);
        return NextResponse.json({ error: "Failed to check for new messages" }, { status: 500 });
      }

      if (tenantResult.error) {
        // Doesn't fail the request — messages matter more than the
        // typing signal — but logged so a missing/misbehaving column
        // is diagnosable rather than silently defaulting.
        console.error("FAILED TO READ chat_agent_replying STATUS:", {
          tenantId,
          error: tenantResult.error,
        });
      }

      return NextResponse.json({
        messages: messagesResult.data ?? [],
        agentReplying: tenantResult.data?.chat_agent_replying ?? false,
      });
    }

    let query = supabase
      .from("owner_chat_messages")
      .select("id, role, content, replied_to_message_id, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (before) {
      query = query.lt("created_at", before);
    }

    const { data, error } = await query;

    if (error) {
      console.error("FAILED TO FETCH CHAT WIDGET HISTORY:", error);
      return NextResponse.json({ error: "Failed to load chat history" }, { status: 500 });
    }

    const rows = data ?? [];

    return NextResponse.json({
      messages: rows.slice().reverse(),
      // True when this page was exactly full — a strong hint there may
      // be more/older messages the client can page back for via
      // `?before=` set to the oldest row's created_at in this batch.
      hasMore: rows.length === 100,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 401 }
    );
  }
}

/**
 * Sends one owner message to the agent and returns both the owner's own
 * persisted row and every agent-reply row created this turn (a reply
 * can become more than one message — see lib/agent/chat.ts's
 * message-splitting comment), so the client has real database ids to
 * hang a future "reply to this" action off of and can render each part
 * as its own bubble.
 *
 * Accepts an optional `ownerMessageId` — set by the widget after it's
 * already persisted the owner's own message via the fast
 * POST /api/agent-chat/send endpoint, so this route (and
 * handleChatMessage() underneath it) doesn't persist it a second time.
 *
 * NOT called by the widget's normal flow anymore as of the
 * delayed-batch reply rearchitecture (see /send/route.ts and
 * lib/inngest/functions.ts's processDelayedChatReply) — that endpoint
 * now handles both the instant-confirmation-reply case and scheduling
 * the delayed case directly. Left in place (unused by the UI, not
 * removed) in case anything else calls this route directly.
 */
export async function POST(request: NextRequest) {
  try {
    const tenantId = await getAuthenticatedTenantId();

    const body = await request.json();
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const repliedToMessageId =
      typeof body?.repliedToMessageId === "string" ? body.repliedToMessageId : null;
    const alreadyPersistedOwnerMessageId =
      typeof body?.ownerMessageId === "string" ? body.ownerMessageId : undefined;

    if (!message) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    const result = await handleChatMessage(tenantId, message, {
      channel: "web",
      repliedToMessageId,
      alreadyPersistedOwnerMessageId,
    });

    const supabase = createServiceSupabase();

    const idsToFetch = [result.ownerMessageId, ...result.messageIds].filter(
      (id): id is string => Boolean(id)
    );

    if (idsToFetch.length === 0) {
      console.error("HANDLE CHAT MESSAGE RETURNED NO PERSISTED ROW IDS:", { tenantId });
      return NextResponse.json(
        { error: "Message sent, but couldn't confirm it — refresh to see the latest." },
        { status: 500 }
      );
    }

    const { data: rows, error } = await supabase
      .from("owner_chat_messages")
      .select("id, role, content, replied_to_message_id, created_at")
      .in("id", idsToFetch);

    if (error || !rows) {
      console.error("FAILED TO RE-FETCH JUST-SENT CHAT MESSAGES:", { tenantId, error });
      return NextResponse.json(
        { error: "Message sent, but couldn't confirm it — refresh to see the latest." },
        { status: 500 }
      );
    }

    const ownerMessage = rows.find((r) => r.id === result.ownerMessageId) ?? null;

    // Preserve the original creation order from result.messageIds
    // rather than trusting the DB query's row order.
    const agentMessages = result.messageIds
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r));

    return NextResponse.json({ ownerMessage, agentMessages });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 401 }
    );
  }
}
