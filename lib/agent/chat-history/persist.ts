import { createServiceSupabase } from "@/lib/supabase/server";

export type OwnerChatRole = "owner" | "agent";

export interface OwnerChatMessageRow {
  id: string;
  tenant_id: string;
  role: OwnerChatRole;
  content: string;
  channel: string;
  replied_to_message_id: string | null;
  created_at: string;
}

/**
 * Persists one turn of the owner-facing chat (migration 013). Called
 * once for the incoming owner message and once for the agent's eventual
 * reply, so the full transcript is always in order regardless of which
 * channel it came through.
 */
export async function persistChatMessage(
  tenantId: string,
  role: OwnerChatRole,
  content: string,
  channel: string,
  repliedToMessageId?: string | null
): Promise<OwnerChatMessageRow | null> {
  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("owner_chat_messages")
    .insert({
      tenant_id: tenantId,
      role,
      content,
      channel,
      replied_to_message_id: repliedToMessageId ?? null,
    })
    .select("id, tenant_id, role, content, channel, replied_to_message_id, created_at")
    .single();

  if (error) {
    /**
     * Fails open, deliberately: losing one turn of chat history is a
     * degraded-continuity problem, not a safety problem — it should
     * never block the owner from getting a response. The next message
     * will simply have one gap in its history window.
     */
    console.error("FAILED TO PERSIST OWNER CHAT MESSAGE:", { tenantId, role, error });
    return null;
  }

  return data as OwnerChatMessageRow;
}

/**
 * Attaches the most recently created, not-yet-linked pending
 * confirmation for this tenant to the agent message that just announced
 * it. Called right after persisting an agent reply — a no-op (affects
 * zero rows) unless a tool execution during this turn actually created a
 * new pending_owner_confirmations row moments earlier. See
 * lib/agent/tools/create-calendar-event.ts's sync_confirm path, which
 * creates the row before the confirmation text is even returned, and
 * chat.ts, which calls this immediately after persisting that returned
 * text as an owner_chat_messages row.
 */
export async function linkPendingConfirmationToMessage(
  tenantId: string,
  messageId: string
): Promise<void> {
  const supabase = createServiceSupabase();

  const { data: unlinked } = await supabase
    .from("pending_owner_confirmations")
    .select("id")
    .eq("tenant_id", tenantId)
    .is("confirmation_message_id", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!unlinked) return;

  const { error } = await supabase
    .from("pending_owner_confirmations")
    .update({ confirmation_message_id: messageId })
    .eq("id", unlinked.id);

  if (error) {
    console.error("FAILED TO LINK PENDING CONFIRMATION TO MESSAGE:", {
      tenantId,
      messageId,
      error,
    });
  }
}
