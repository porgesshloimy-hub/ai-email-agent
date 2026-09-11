import { createServiceSupabase } from "@/lib/supabase/server";
import { resolveSendCapability } from "@/lib/agent/permissions";
import { createNewDraft, sendNewMessage } from "@/lib/gmail/client";
import { notifyTenant, type TenantOutreachSettings } from "@/lib/agent/outreach/dispatcher";

/**
 * Phase 6.2 — scheduled tool execution ("send an email tomorrow
 * morning"). Called by the same scheduled Inngest function as reminders
 * (lib/inngest/functions.ts's dispatchPendingOutreach), as its own step,
 * since a scheduled action isn't an outreach-queue item — it's not a
 * notification, it's a real action that must fire on its own.
 *
 * THE CORE DESIGN DECISION (explicitly chosen by the owner): at fire
 * time, actually SEND for real if gmail.send is already 'allowed' with
 * no approval-required rule in the way — exactly the same
 * resolveSendCapability() check lib/agent/tools/send-reply.ts's
 * isAvailable gate and run.ts's immediate-reply branching already use,
 * so a scheduled email is held to the identical bar as an immediate one.
 * If sending isn't currently authorized, this creates a Gmail draft
 * instead (mirroring compose_email_draft's "the model drafts, a human
 * sends" boundary) rather than either blocking the whole feature on
 * send permission or silently doing nothing.
 *
 * Permission is re-checked HERE, at fire time, not at creation time —
 * an owner could grant/revoke gmail.send between "send an email
 * tomorrow morning" and tomorrow morning, and the fire-time state is
 * what should govern.
 *
 * Retry: unlike reminders (which retry with multi-hour spacing because
 * an unacknowledged notification is only mildly time-sensitive), a
 * failed scheduled action just retries on the next 15-minute dispatch
 * cycle (trigger_at stays in the past, status stays 'pending') up to
 * MAX_ATTEMPTS, since "the email that was supposed to go out this
 * morning" is worth retrying quickly rather than waiting hours. After
 * MAX_ATTEMPTS it's marked 'failed' and the owner is notified via the
 * same channel-selection logic reminders use, rather than a scheduled
 * action ever silently vanishing.
 */

const MAX_ATTEMPTS = 3;

export interface RunScheduledActionsResult {
  sentDirectly: number;
  draftedForApproval: number;
  failed: number;
  skipped: number;
}

export async function runDueScheduledActions(): Promise<RunScheduledActionsResult> {
  const supabase = createServiceSupabase();
  const nowIso = new Date().toISOString();

  const result: RunScheduledActionsResult = {
    sentDirectly: 0,
    draftedForApproval: 0,
    failed: 0,
    skipped: 0,
  };

  const { data: due, error } = await supabase
    .from("agent_scheduled_actions")
    .select("id, tenant_id, tool_name, to_email, subject, body, attempt_count")
    .eq("status", "pending")
    .lte("trigger_at", nowIso);

  if (error) {
    console.error("RUN DUE SCHEDULED ACTIONS: lookup failed:", error);
    return result;
  }

  for (const action of due ?? []) {
    if (action.tool_name !== "send_email") {
      // Only send_email exists today (see migration 020's check
      // constraint, which would prevent this anyway) — logged loudly in
      // case a future tool_name is added to the constraint before a
      // handler exists here.
      console.error("RUN DUE SCHEDULED ACTIONS: no handler for tool_name, skipping:", {
        id: action.id,
        toolName: action.tool_name,
      });
      result.skipped++;
      continue;
    }

    const outcome = await executeScheduledEmailAction(supabase, action);
    result[outcome]++;
  }

  console.log("RUN DUE SCHEDULED ACTIONS complete:", result);

  return result;
}

type ExecuteOutcome = "sentDirectly" | "draftedForApproval" | "failed" | "skipped";

async function executeScheduledEmailAction(
  supabase: ReturnType<typeof createServiceSupabase>,
  action: {
    id: string;
    tenant_id: string;
    to_email: string;
    subject: string;
    body: string;
    attempt_count: number;
  }
): Promise<ExecuteOutcome> {
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("timezone, quiet_hours_start, quiet_hours_end, proactive_contact_channel, phone_number")
    .eq("id", action.tenant_id)
    .single();

  if (tenantError || !tenant) {
    console.error("EXECUTE SCHEDULED EMAIL ACTION: tenant lookup failed:", tenantError, {
      actionId: action.id,
    });
    return "failed";
  }

  const capability = await resolveSendCapability(action.tenant_id);

  try {
    if (capability === "send") {
      await sendNewMessage(action.tenant_id, action.to_email, action.subject, action.body);

      await supabase
        .from("agent_scheduled_actions")
        .update({
          status: "executed_sent",
          executed_at: new Date().toISOString(),
          result_summary: `Sent to ${action.to_email}.`,
        })
        .eq("id", action.id);

      await notifyTenant(
        action.tenant_id,
        tenant as TenantOutreachSettings,
        `Sent your scheduled email to ${action.to_email} (subject: "${action.subject}").`
      );

      return "sentDirectly";
    }

    // capability is "draft_only" or "none" — don't block the feature on
    // send authorization; create a real Gmail draft instead, same
    // boundary compose_email_draft already establishes for chat-composed
    // email.
    const draft = await createNewDraft(action.tenant_id, action.to_email, action.subject, action.body);

    if (!draft?.id) {
      throw new Error("Gmail did not return a draft ID");
    }

    await supabase
      .from("agent_scheduled_actions")
      .update({
        status: "executed_draft",
        executed_at: new Date().toISOString(),
        result_summary: `Sending wasn't enabled, so a draft to ${action.to_email} was created instead.`,
      })
      .eq("id", action.id);

    await notifyTenant(
      action.tenant_id,
      tenant as TenantOutreachSettings,
      `Your scheduled email to ${action.to_email} (subject: "${action.subject}") wasn't auto-sent because sending isn't currently enabled — I saved it as a draft in Gmail for you to review and send.`
    );

    return "draftedForApproval";
  } catch (err) {
    console.error("EXECUTE SCHEDULED EMAIL ACTION: attempt failed:", err, { actionId: action.id });

    const nextAttemptCount = (action.attempt_count ?? 0) + 1;

    if (nextAttemptCount >= MAX_ATTEMPTS) {
      await supabase
        .from("agent_scheduled_actions")
        .update({
          status: "failed",
          attempt_count: nextAttemptCount,
          last_attempted_at: new Date().toISOString(),
          result_summary: "Failed after repeated attempts — see server logs.",
        })
        .eq("id", action.id);

      await notifyTenant(
        action.tenant_id,
        tenant as TenantOutreachSettings,
        `I wasn't able to send or draft your scheduled email to ${action.to_email} after several attempts — you may need to send it yourself.`
      );

      return "failed";
    }

    await supabase
      .from("agent_scheduled_actions")
      .update({
        attempt_count: nextAttemptCount,
        last_attempted_at: new Date().toISOString(),
      })
      .eq("id", action.id);

    // Left as 'pending' — trigger_at is still in the past, so the next
    // 15-minute dispatch cycle retries it automatically.
    return "failed";
  }
}
