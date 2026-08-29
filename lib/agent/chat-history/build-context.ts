import { createServiceSupabase } from "@/lib/supabase/server";
import { isValidTimezone, DEFAULT_TIMEZONE } from "@/lib/timezones";
import type { LlmMessage } from "@/lib/agent/llm";
import type { OwnerChatMessageRow } from "@/lib/agent/chat-history/persist";

/**
 * ------------------------------------------------------------
 * Owner chat history — continuity window
 * ------------------------------------------------------------
 *
 * Before this, lib/agent/chat.ts sent only the current message with no
 * history at all — every message was processed in total isolation, so a
 * follow-up like "actually make it 4pm instead" had nothing to resolve
 * against.
 *
 * The window combines a hard count cap (cost control — every message in
 * a session is re-sent on every subsequent call, so an uncapped history
 * grows the per-message cost roughly linearly, then compounds across a
 * long session) with a time-based cutoff that only applies when the
 * conversation actually looks concluded, not merely quiet:
 *
 *   - If the AGENT sent the last message, there's no time cutoff at all
 *     — an open loop (the agent asked something, or gave an answer that
 *     might get pushback) shouldn't expire just because the owner took
 *     a day to reply.
 *   - If the OWNER sent the last message and it reads as a genuine
 *     closing acknowledgment ("thanks", "sounds good," etc. — see
 *     CLOSING_PHRASE_PATTERN below), the time cutoff applies from that
 *     message's timestamp.
 *   - If the OWNER sent the last message and it does NOT read as a
 *     closing acknowledgment — including something like "I'll think
 *     about it," which defers rather than closes — the conversation is
 *     treated as still open, same as the agent-last case. No attempt is
 *     made to semantically distinguish "I'll think about it" from any
 *     other non-closing message; the only judgment made is "does this
 *     match a recognized closing phrase," deliberately kept as simple,
 *     deterministic pattern matching rather than an LLM self-report.
 *
 * The count cap always applies regardless of which case above is in
 * effect — the time cutoff can only ever narrow the window further, not
 * widen it past the count cap.
 */

const MAX_HISTORY_MESSAGES = 10;
const TIME_CUTOFF_HOURS = 30;

const CLOSING_PHRASE_PATTERN =
  /^(thanks|thank you|thanks a lot|thank you so much|got it|sounds good|perfect|great,? thanks|ok(ay)?,? thanks|no,? that'?s (all|it)|that'?s all( for now)?|nothing (else|more)( for now)?|all set|we'?re good|good for now)\b/i;

function isClosingAcknowledgment(content: string): boolean {
  return CLOSING_PHRASE_PATTERN.test(content.trim());
}

/**
 * Same UTC-midnight-anchor trick used by lib/agent/date-context.ts, so
 * "how many days ago" is computed from calendar dates in the tenant's
 * own timezone rather than raw millisecond differences (which would
 * misclassify a message from late last night as "today" or vice versa
 * depending on the reader's own clock).
 */
function calendarDateAnchor(date: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  return new Date(`${year}-${month}-${day}T00:00:00Z`);
}

function formatRelativeTimestamp(messageDate: Date, now: Date, timezone: string): string {
  const daysAgo = Math.round(
    (calendarDateAnchor(now, timezone).getTime() -
      calendarDateAnchor(messageDate, timezone).getTime()) /
      86_400_000
  );

  const timeLabel = messageDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });

  if (daysAgo <= 0) return `Today, ${timeLabel}`;
  if (daysAgo === 1) return `Yesterday, ${timeLabel}`;

  const dateLabel = messageDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  });

  return `${daysAgo} days ago — ${dateLabel}, ${timeLabel}`;
}

/**
 * Fetches this tenant's recent owner-chat history, applies the
 * count/time window described above, and returns it as real
 * role-tagged conversation turns (not flattened into the system
 * prompt) — each one prefixed with a relative timestamp so the model
 * can reason about recency explicitly ("you said this yesterday," "this
 * was 3 days ago") rather than treating all history as equally current.
 */
export async function fetchChatHistoryTurns(
  tenantId: string,
  tenantTimezone?: string | null
): Promise<LlmMessage[]> {
  const timezone = isValidTimezone(tenantTimezone)
    ? (tenantTimezone as string)
    : DEFAULT_TIMEZONE;

  const supabase = createServiceSupabase();

  // Always fetch up to the count cap first, most recent first — the
  // time cutoff (if it applies at all) is decided AFTER seeing whether
  // the most recent message was a closing acknowledgment, so the count
  // cap can't be pushed down into the query until that's known.
  const { data, error } = await supabase
    .from("owner_chat_messages")
    .select("id, tenant_id, role, content, channel, replied_to_message_id, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY_MESSAGES);

  if (error || !data || data.length === 0) {
    if (error) {
      console.error("FAILED TO FETCH OWNER CHAT HISTORY:", { tenantId, error });
    }
    return [];
  }

  const rows = data as OwnerChatMessageRow[];
  const mostRecent = rows[0]; // rows are DESC, so index 0 is the latest

  const timeCutoffApplies =
    mostRecent.role === "owner" && isClosingAcknowledgment(mostRecent.content);

  const now = new Date();
  const cutoffMs = now.getTime() - TIME_CUTOFF_HOURS * 60 * 60 * 1000;

  const windowed = timeCutoffApplies
    ? rows.filter((row) => new Date(row.created_at).getTime() >= cutoffMs)
    : rows;

  // Back to chronological order (oldest first) for the model, and map
  // each into a real conversation turn — role "owner" -> "user",
  // "agent" -> "assistant" — with the relative timestamp prefixed onto
  // the content so it's visible without needing a separate metadata
  // channel the model would have to correlate itself.
  return windowed
    .slice()
    .reverse()
    .map((row) => ({
      role: row.role === "owner" ? "user" : "assistant",
      content: `[${formatRelativeTimestamp(new Date(row.created_at), now, timezone)}] ${row.content}`,
    }));
}
