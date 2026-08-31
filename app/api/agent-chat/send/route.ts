import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { persistChatMessage } from "@/lib/agent/chat-history/persist";
import { hasMatchingPendingConfirmation } from "@/lib/agent/approval/pending-confirmation-check";
import { handleChatMessage } from "@/lib/agent/chat";
import { inngest } from "@/lib/inngest/client";

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
 * Persists the owner's own message and returns immediately — no LLM
 * call blocks this response, so "your message was saved" is always a
 * fast, separate signal from "the agent replied."
 *
 * Also decides, right here and just as fast, whether this message will
 * be answered instantly or via the delayed-batch flow (5-12s "thinking"
 * pause, folding in any follow-up sent during that window — see
 * lib/inngest/functions.ts's processDelayedChatReply):
 *
 *   - A reply to a pending confirmation ("yes", "cancel", etc.) is
 *     answered INSTANTLY, synchronously, right in this same request —
 *     a quick acknowledgment shouldn't sit behind an artificial delay
 *     the way a genuine new question should.
 *   - Anything else triggers the Inngest event and returns immediately
 *     with `scheduled: true` — critically, sending that event is a
 *     fast network call to Inngest, NOT a wait on the agent itself, so
 *     "this will be answered and won't get stuck" is confirmed right
 *     away, well before the actual 5-12 second delay even begins.
 *
 * The response shape tells the client which case happened:
 * `{ ownerMessage, immediateReply }` for the instant path (nothing more
 * to poll for), or `{ ownerMessage, scheduled: true }` for the delayed
 * path (the client starts polling GET /api/agent-chat?after=... for
 * the eventual reply).
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

    const isConfirmationReply = await hasMatchingPendingConfirmation(
      tenantId,
      repliedToMessageId
    );

    if (isConfirmationReply) {
      const result = await handleChatMessage(tenantId, message, {
        channel: "web",
        repliedToMessageId,
        alreadyPersistedOwnerMessageId: row.id,
      });

      return NextResponse.json({
        ownerMessage: row,
        immediateReply: { text: result.text, messageIds: result.messageIds },
      });
    }

    await inngest.send({
      name: "chat/owner-message.sent",
      data: {
        tenantId,
        ownerMessageId: row.id,
        ownerMessageCreatedAt: row.created_at,
        channel: "web",
      },
    });

    return NextResponse.json({ ownerMessage: row, scheduled: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 401 }
    );
  }
}
