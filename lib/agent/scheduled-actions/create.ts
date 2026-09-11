import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * createScheduledEmailAction — stores an owner-requested "send this email
 * at a future time" as a pending row for lib/agent/scheduled-actions/
 * dispatch.ts to pick up when it comes due. Mirrors
 * lib/agent/reminders/create.ts's shape and validation (same date-in-the-
 * past sanity check, same "resolve the date upstream via an LLM call,
 * validate/store here" split), but this is a materially different kind
 * of thing from a reminder: nothing external happens when a reminder
 * fires (it's just a notification back to the owner), whereas this
 * actually sends or drafts a real email once it's due — see dispatch.ts
 * for the permission re-check that governs which of those two happens.
 */

export interface CreateScheduledEmailActionInput {
  tenantId: string;
  toEmail: string;
  subject: string;
  body: string;
  /** Absolute trigger time, ISO 8601, already resolved against the tenant's timezone by the caller. */
  triggerAt: string;
  sourceThreadId?: string | null;
}

export interface CreateScheduledEmailActionResult {
  id: string;
  triggerAt: string;
}

export async function createScheduledEmailAction(
  input: CreateScheduledEmailActionInput
): Promise<CreateScheduledEmailActionResult | { error: string }> {
  const toEmail = input.toEmail.trim();
  const subject = input.subject.trim();
  const body = input.body.trim();

  if (!toEmail || !toEmail.includes("@")) {
    return { error: "I need a valid recipient email address to schedule this." };
  }

  if (!subject) {
    return { error: "I need a subject line to schedule this email." };
  }

  if (!body) {
    return { error: "Scheduled email content cannot be empty." };
  }

  const parsedTriggerAt = new Date(input.triggerAt);

  if (Number.isNaN(parsedTriggerAt.getTime())) {
    return { error: `Could not parse "${input.triggerAt}" as a valid date/time.` };
  }

  // Same rationale as createReminder: a few minutes in the past is likely
  // just processing lag, but more than that almost certainly means the
  // upstream date resolution picked the wrong day/time.
  const minutesInPast = (Date.now() - parsedTriggerAt.getTime()) / 60_000;

  if (minutesInPast > 5) {
    console.error(
      "CREATE SCHEDULED EMAIL ACTION: resolved trigger time is in the past — likely a date-resolution error upstream:",
      { tenantId: input.tenantId, triggerAt: input.triggerAt, minutesInPast }
    );

    return {
      error: `That resolved to ${parsedTriggerAt.toISOString()}, which is already in the past — please give a specific future date/time.`,
    };
  }

  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("agent_scheduled_actions")
    .insert({
      tenant_id: input.tenantId,
      tool_name: "send_email",
      to_email: toEmail,
      subject,
      body,
      trigger_at: parsedTriggerAt.toISOString(),
      source_thread_id: input.sourceThreadId ?? null,
      status: "pending",
    })
    .select("id, trigger_at")
    .single();

  if (error || !data) {
    console.error("CREATE SCHEDULED EMAIL ACTION: insert failed:", error);
    return { error: "Something went wrong scheduling that email." };
  }

  return { id: data.id, triggerAt: data.trigger_at };
}
