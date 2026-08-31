import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * A cheap existence check, deliberately kept separate from the full
 * resolution logic already inside lib/agent/chat.ts's computeResponse()
 * — that function still does the real (repeated) check when it
 * actually processes a message. This is only used by
 * app/api/agent-chat/send/route.ts to decide, at send time, whether an
 * incoming message should be answered INSTANTLY (it's very likely a
 * reply to a pending confirmation — "yes", "cancel", etc. — which
 * shouldn't be held behind an artificial delay the way a genuine new
 * question should) or handed off to the delayed-batch flow instead.
 *
 * Same reply-to-first, fall-back-to-most-recent logic as the real
 * check, kept in sync deliberately since both need to agree on what
 * counts as "answering a pending confirmation."
 *
 * Bug fix: the fallback path (no explicit reply-to) used to match ANY
 * existing pending confirmation regardless of the message's own
 * content — meaning an unrelated new message sent while a stale
 * confirmation happened to exist (up to 30 minutes old) got routed
 * into the slow, synchronous "instant" path and then, inside
 * chat.ts, swallowed into re-asking the OLD confirmation question
 * instead of ever being answered. Now requires the message to
 * actually look like a yes/no response before the fallback match
 * counts at all — matching the same fix applied in chat.ts.
 */
export async function hasMatchingPendingConfirmation(
  tenantId: string,
  repliedToMessageId: string | null,
  messageText: string
): Promise<boolean> {
  const supabase = createServiceSupabase();

  const query = supabase
    .from("pending_owner_confirmations")
    .select("id, expires_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  const { data } = repliedToMessageId
    ? await query.eq("confirmation_message_id", repliedToMessageId).limit(1)
    : await query.limit(1);

  const pending = data?.[0] ?? null;

  if (!pending) return false;
  if (new Date(pending.expires_at) < new Date()) return false;

  if (repliedToMessageId) return true; // an explicit reply-to match is always honored

  // Fallback (no explicit reply-to): only counts if the message itself
  // actually looks like a yes/no answer — see the bug-fix note above.
  const normalized = messageText.trim().toLowerCase();
  const looksLikeConfirmationReply =
    /^(yes|yep|yeah|yup|confirm|confirmed|go ahead|do it|sounds good|ok|okay|sure|no|nope|cancel|don'?t|nevermind|never mind|stop)\b/.test(
      normalized
    );

  return looksLikeConfirmationReply;
}
