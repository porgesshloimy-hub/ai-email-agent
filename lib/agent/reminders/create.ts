import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * createReminder — Phase 3.1. Time resolution ("next Monday", "in an
 * hour") happens upstream, in the caller's own LLM call (see
 * lib/agent/memory/owner-intent.ts, which includes
 * lib/agent/date-context.ts's buildCurrentDateContext() in its prompt so
 * the model resolves relative phrases against the tenant's own
 * timezone) — this function only validates and stores an already-
 * resolved absolute timestamp. It does not itself do any NLU/date-math,
 * so it stays reusable from anywhere a reminder needs creating (a future
 * dashboard "create reminder" form, for instance) without dragging an
 * LLM call along with it.
 */

export interface CreateReminderInput {
  tenantId: string;
  content: string;
  /** Absolute trigger time, ISO 8601, already resolved against the tenant's timezone by the caller. */
  triggerAt: string;
  relatedCustomerEmail?: string | null;
  sourceThreadId?: string | null;
}

export interface CreateReminderResult {
  id: string;
  triggerAt: string;
}

export async function createReminder(
  input: CreateReminderInput
): Promise<CreateReminderResult | { error: string }> {
  const content = input.content.trim();

  if (!content) {
    return { error: "Reminder content cannot be empty." };
  }

  const parsedTriggerAt = new Date(input.triggerAt);

  if (Number.isNaN(parsedTriggerAt.getTime())) {
    return { error: `Could not parse "${input.triggerAt}" as a valid date/time.` };
  }

  // A reminder in the past isn't necessarily wrong (the owner might say
  // "remind me" about something whose exact time already slipped by a
  // few seconds during processing), but more than a few minutes in the
  // past almost certainly means the date resolution went wrong upstream
  // (e.g. resolved "Thursday" to a Thursday that already passed this
  // week instead of next week) — worth surfacing rather than silently
  // creating a reminder that fires immediately on the next dispatch
  // cycle with no warning.
  const minutesInPast = (Date.now() - parsedTriggerAt.getTime()) / 60_000;

  if (minutesInPast > 5) {
    console.error("CREATE REMINDER: resolved trigger time is in the past — likely a date-resolution error upstream:", {
      tenantId: input.tenantId,
      triggerAt: input.triggerAt,
      minutesInPast,
    });

    return {
      error: `That resolved to ${parsedTriggerAt.toISOString()}, which is already in the past — please give a specific future date/time.`,
    };
  }

  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("agent_reminders")
    .insert({
      tenant_id: input.tenantId,
      content,
      related_customer_email: input.relatedCustomerEmail ?? null,
      trigger_at: parsedTriggerAt.toISOString(),
      source_thread_id: input.sourceThreadId ?? null,
      status: "pending",
    })
    .select("id, trigger_at")
    .single();

  if (error || !data) {
    console.error("CREATE REMINDER: insert failed:", error);
    return { error: "Something went wrong saving that reminder." };
  }

  return { id: data.id, triggerAt: data.trigger_at };
}
