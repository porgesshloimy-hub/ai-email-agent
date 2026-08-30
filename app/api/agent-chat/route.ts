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
 * Returns recent owner chat history for the widget's initial render.
 * Sourced directly from owner_chat_messages (migration 013) rather than
 * lib/agent/chat-history's fetchChatHistoryTurns(), which is a
 * different, narrower thing — that function builds the trimmed,
 * cutoff-applied window handed to the MODEL as prompt context; this
 * route returns a plain, fuller transcript for a human to actually read
 * in the UI, with real row ids so the "reply to this message" action
 * has something to attach to.
 */
export async function GET() {
  try {
    const tenantId = await getAuthenticatedTenantId();
    const supabase = createServiceSupabase();

    const { data, error } = await supabase
      .from("owner_chat_messages")
      .select("id, role, content, replied_to_message_id, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("FAILED TO FETCH CHAT WIDGET HISTORY:", error);
      return NextResponse.json({ error: "Failed to load chat history" }, { status: 500 });
    }

    return NextResponse.json({ messages: (data ?? []).slice().reverse() });
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
 */
export async function POST(request: NextRequest) {
  try {
    const tenantId = await getAuthenticatedTenantId();

    const body = await request.json();
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const repliedToMessageId =
      typeof body?.repliedToMessageId === "string" ? body.repliedToMessageId : null;

    if (!message) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    const result = await handleChatMessage(tenantId, message, {
      channel: "web",
      repliedToMessageId,
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
