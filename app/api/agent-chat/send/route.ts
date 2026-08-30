import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { persistChatMessage } from "@/lib/agent/chat-history/persist";

/**
 * Same pattern as the main route's copy — duplicated per this
 * codebase's existing convention rather than extracted into a shared
 * helper.
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
 * Persists ONLY the owner's own message and returns immediately — no
 * LLM call, no tool execution, nothing that waits on the agent's full
 * turn. Added to answer a real question: previously there was no way
 * to know a message was reliably saved separate from knowing the agent
 * had finished replying, since a single request did both. The widget
 * calls this first, marks the owner's bubble as confirmed the moment
 * this responds, then calls the main POST /api/agent-chat route
 * (passing the returned id via alreadyPersistedOwnerMessageId) to
 * actually get the agent's reply — so "sent reliably" and "agent
 * replied" are now two distinct, independently-observable events.
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

    const row = await persistChatMessage(tenantId, "owner", message, "web", repliedToMessageId);

    if (!row) {
      return NextResponse.json(
        { error: "Couldn't save that message — please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({ ownerMessage: row });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 401 }
    );
  }
}
