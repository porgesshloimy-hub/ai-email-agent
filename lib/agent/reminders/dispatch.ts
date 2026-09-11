import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Phase 3.2 — the "queue" half of reminder delivery. Called by the
 * scheduled Inngest function (lib/inngest/functions.ts's
 * dispatchPendingOutreach) on every run, across all tenants. Decides
 * WHICH reminders are due for an attempt right now and enqueues them
 * into agent_outreach_queue; the actual send happens in
 * lib/agent/outreach/dispatcher.ts, which is deliberately a separate
 * step so the send path (SMS today, other channels later) has one
 * shared entry point regardless of what queued it (a reminder here, a
 * watch or suggestion once those phases exist).
 *
 * Three cases enqueue a reminder:
 * 1. status 'pending' and trigger_at has passed — first attempt.
 * 2. status 'awaiting_ack' (already delivered once), unacknowledged for
 *    longer than RETRY_SPACING_MS, and under the retry cap — a re-
 *    attempt, per the plan's "unack'd = re-attempt" lifecycle.
 * 3. status 'awaiting_ack', at or over the retry cap — NOT re-enqueued;
 *    flipped to 'passive_queue' instead (removed from active retry,
 *    matching the plan's "falls back to passive queue" — actually
 *    delivering passive_queue items via a future piggyback path is
 *    Phase 5.2's fuller scope and isn't wired up yet; for now this just
 *    stops the retry cycle rather than retrying forever).
 *
 * NOTE on retry spacing: the original plan called for "base ~2-3 hours
 * + jitter, snapped to tenant working hours." This v1 uses a fixed
 * spacing with no jitter or working-hours snapping — quiet hours ARE
 * respected, but only at actual send time (see dispatcher.ts), not by
 * shifting when a retry gets queued. Refining the queueing side to match
 * the fuller design is a reasonable next increment, not done here.
 */

const RETRY_SPACING_MS = 3 * 60 * 60 * 1000; // 3 hours
const MAX_ATTEMPTS = 2;

/** Priority for reminder items in agent_outreach_queue. Higher = sent sooner when multiple items compete for the same contact opportunity (see dispatcher.ts). Kept in the middle of a 1-10 scale so a future watch/suggestion priority scheme has room on both sides. */
const REMINDER_PRIORITY = 5;

export interface EnqueueResult {
  firstAttemptsQueued: number;
  retriesQueued: number;
  movedToPassiveQueue: number;
}

export async function enqueueDueReminders(): Promise<EnqueueResult> {
  const supabase = createServiceSupabase();
  const now = new Date();
  const nowIso = now.toISOString();

  const result: EnqueueResult = {
    firstAttemptsQueued: 0,
    retriesQueued: 0,
    movedToPassiveQueue: 0,
  };

  // --- Case 1: first attempt ---
  const { data: firstAttempts, error: firstAttemptsError } = await supabase
    .from("agent_reminders")
    .select("id, tenant_id")
    .eq("status", "pending")
    .lte("trigger_at", nowIso);

  if (firstAttemptsError) {
    console.error("ENQUEUE DUE REMINDERS: first-attempt lookup failed:", firstAttemptsError);
  }

  for (const reminder of firstAttempts ?? []) {
    const queued = await enqueueOutreachItem(supabase, reminder.tenant_id, reminder.id);
    if (queued) result.firstAttemptsQueued++;
  }

  // --- Cases 2 & 3: already delivered, awaiting acknowledgment ---
  const { data: awaitingAck, error: awaitingAckError } = await supabase
    .from("agent_reminders")
    .select("id, tenant_id, attempt_count, last_attempted_at")
    .eq("status", "awaiting_ack");

  if (awaitingAckError) {
    console.error("ENQUEUE DUE REMINDERS: awaiting_ack lookup failed:", awaitingAckError);
  }

  for (const reminder of awaitingAck ?? []) {
    const attemptCount = reminder.attempt_count ?? 0;

    if (attemptCount >= MAX_ATTEMPTS) {
      const { error: passiveError } = await supabase
        .from("agent_reminders")
        .update({ status: "passive_queue" })
        .eq("id", reminder.id)
        .eq("status", "awaiting_ack");

      if (passiveError) {
        console.error("ENQUEUE DUE REMINDERS: failed to move to passive_queue:", passiveError);
      } else {
        result.movedToPassiveQueue++;
      }

      continue;
    }

    const lastAttemptedAt = reminder.last_attempted_at
      ? new Date(reminder.last_attempted_at).getTime()
      : 0;

    if (now.getTime() - lastAttemptedAt < RETRY_SPACING_MS) {
      continue; // not due for a retry yet
    }

    const queued = await enqueueOutreachItem(supabase, reminder.tenant_id, reminder.id);
    if (queued) result.retriesQueued++;
  }

  console.log("ENQUEUE DUE REMINDERS complete:", result);

  return result;
}

/**
 * Inserts one outreach_queue row for a reminder, unless one already
 * exists (a reminder can only ever have at most one outstanding queue
 * entry at a time — this guards against a reminder being enqueued twice
 * if this function runs again before the dispatcher has processed the
 * first entry).
 */
async function enqueueOutreachItem(
  supabase: ReturnType<typeof createServiceSupabase>,
  tenantId: string,
  reminderId: string
): Promise<boolean> {
  const { data: existing, error: existingError } = await supabase
    .from("agent_outreach_queue")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("item_type", "reminder")
    .eq("item_id", reminderId)
    .maybeSingle();

  if (existingError) {
    console.error("ENQUEUE OUTREACH ITEM: existence check failed:", existingError);
    return false;
  }

  if (existing) {
    return false; // already queued, nothing to do
  }

  const { error: insertError } = await supabase.from("agent_outreach_queue").insert({
    tenant_id: tenantId,
    item_type: "reminder",
    item_id: reminderId,
    priority: REMINDER_PRIORITY,
    ready_at: new Date().toISOString(),
  });

  if (insertError) {
    console.error("ENQUEUE OUTREACH ITEM: insert failed:", insertError);
    return false;
  }

  return true;
}
