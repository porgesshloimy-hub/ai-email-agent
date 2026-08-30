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
 * persisted row and the agent's reply row, so the client has real
 * database ids to hang a future "reply to this" action off of —
 * handleChatMessage() itself only returns the reply's plain text (its
 * signature is shared with the Google Chat webhook, which has no use
 * for anything richer), so this route re-fetches the two most recently
 * created rows for this tenant immediately after the call completes.
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

    await handleChatMessage(tenantId, message, {
      channel: "web",
      repliedToMessageId,
    });

    const supabase = createServiceSupabase();

    const { data: recent, error } = await supabase
      .from("owner_chat_messages")
      .select("id, role, content, replied_to_message_id, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(2);

    if (error || !recent || recent.length < 2) {
      console.error("FAILED TO RE-FETCH JUST-SENT CHAT MESSAGES:", { tenantId, error });
      return NextResponse.json(
        { error: "Message sent, but couldn't confirm it — refresh to see the latest." },
        { status: 500 }
      );
    }

    // recent[0] is the agent's reply (most recent), recent[1] is the
    // owner's own message that triggered it.
    const [agentMessage, ownerMessage] = recent;

    return NextResponse.json({ ownerMessage, agentMessage });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 401 }
    );
  }
}
