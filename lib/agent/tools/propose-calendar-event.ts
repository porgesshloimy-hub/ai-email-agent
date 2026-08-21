import { notifyApproval } from "@/lib/notify";

import { calendarEventParams } from "./create-calendar-event";
import type { ToolContext, ToolDefinition } from "./types";

/**
 * Same base shape as create_calendar_event's parameters, plus a required
 * confirmationMessage field — used only by propose_calendar_event, since
 * a proposal (unlike an immediate create) needs a pre-written customer
 * confirmation ready to send automatically on approval.
 */
const proposeCalendarEventParams = {
  type: "object" as const,

  properties: {
    ...calendarEventParams.properties,

    confirmationMessage: {
      type: "string",
      description:
        "The complete customer-facing confirmation email to send automatically if the account holder approves this proposal. Write it now, in the same natural tone as your other replies, as if the meeting time is confirmed. Include the exact placeholder {{meeting_link}} on its own wherever a meeting link should appear, if a link is expected; it will be replaced with the real link before sending.",
    },
  },

  required: [...calendarEventParams.required, "confirmationMessage"],
};

/**
 * DISCREPANCY (found while diffing run.ts's buildToolDefinitions, not
 * introduced here): run.ts defines "propose_calendar_event" TWICE, with
 * identical parameters but two different `description` strings, gated
 * on two different, mutually exclusive permission states:
 *
 *  - when calendarWriteCapability === "write" (alongside
 *    create_calendar_event): a description explaining this tool exists
 *    for the case where confirming the event needs the account holder's
 *    own personal availability, distinct from the always-available
 *    create_calendar_event.
 *  - when calendarWriteCapability === "propose_only" (the only calendar
 *    tool offered in that state): a shorter description that doesn't
 *    contrast against create_calendar_event, since it isn't offered
 *    alongside it in that state.
 *
 * Since calendarWriteCapability can only be one value at a time, at most
 * one of these two is ever actually offered to the model — but which
 * description it sees differs by state, so this is kept as two
 * ToolDefinition exports (sharing the same execute()) rather than
 * collapsed into one, to keep the schema the model sees byte-identical
 * to before in both states.
 */

async function executeProposeCalendarEvent(
  args: Record<string, any>,
  context: ToolContext
) {
  const { supabase, tenantId, email, permissions } = context;

  if (!email) {
    throw new Error("propose_calendar_event requires email context");
  }

  if (
    permissions.calendarWriteCapability !== "propose_only" &&
    permissions.calendarWriteCapability !== "write"
  ) {
    const { SecurityViolationError } = await import("./security");
    throw new SecurityViolationError(
      "Security violation: calendar proposal attempted incorrectly"
    );
  }

  if (
    typeof args.confirmationMessage !== "string" ||
    !args.confirmationMessage.trim()
  ) {
    throw new Error(
      "propose_calendar_event requires a non-empty confirmationMessage"
    );
  }

  const { data: calendarAction, error } = await supabase
    .from("calendar_actions")
    .insert({
      tenant_id: tenantId,
      action_type: "create_event",
      status: "pending_approval",
      proposed_summary: args.summary,
      proposed_start: args.startTime,
      proposed_end: args.endTime,
      reasoning: args.reasoning ?? null,
      customer_email: email.from,
      gmail_thread_id: email.threadId,
      gmail_message_id: email.messageId,
      gmail_subject: email.subject,
      attendee_emails: args.attendeeEmails ?? [],
      draft_confirmation_body: args.confirmationMessage,
    })
    .select("id")
    .single();

  if (error || !calendarAction) {
    throw new Error(
      `Failed to create calendar action: ${error?.message ?? "unknown error"}`
    );
  }

  const { data: approval, error: approvalError } = await supabase
    .from("approvals")
    .insert({
      tenant_id: tenantId,
      action_type: "calendar.create",
      action_id: calendarAction.id,
      status: "pending",
      description: `Create calendar event "${args.summary}"`,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();

  if (approvalError || !approval) {
    throw new Error(
      `Failed to create calendar approval: ${
        approvalError?.message ?? "unknown error"
      }`
    );
  }

  await notifyApproval(
    tenantId,
    approval.id,
    `Calendar event needs approval.\n\n${args.summary}\n${args.startTime}`
  );

  await supabase
    .from("email_actions")
    .update({
      action_type: "calendar_proposal",
      status: "pending_approval",
    })
    .eq("id", email.emailActionId);

  return {
    success: true,
    action: "calendar_pending_approval",
    approvalId: approval.id,
    message:
      "The calendar event was submitted for owner approval, along with the confirmation email that will be sent automatically if approved. No further action is required during this run.",
  };
}

/** Variant offered alongside create_calendar_event (calendarWriteCapability === "write"). */
export const proposeCalendarEventWriteTool: ToolDefinition = {
  name: "propose_calendar_event",

  description:
    "Propose a calendar event for the account holder's approval, rather than creating it immediately. Use this when the event is otherwise grounded and reasonable, but confirming it would require the account holder's own personal availability, judgment, or preference — for example, when a customer proposes a specific time and whether the business is actually free then is not something you can verify or assume. This creates a pending proposal the account holder can approve or reject; a confirmation email is sent automatically to the customer once approved, using the confirmationMessage you provide. Do NOT use this to accept, confirm, or RSVP to a meeting invitation extended to the account holder personally by someone else. Do not send or draft a separate customer-facing reply promising a specific time until this proposal has been approved.",

  parameters: proposeCalendarEventParams,

  surfaces: ["email"],
  capability: "calendar",

  isAvailable: (context: ToolContext) =>
    context.permissions.calendarWriteCapability === "write",

  terminal: true,
  createsApproval: true,

  execute: executeProposeCalendarEvent,
};

/** Variant offered when calendarWriteCapability === "propose_only" (the only calendar tool in that state). */
export const proposeCalendarEventProposeOnlyTool: ToolDefinition = {
  name: "propose_calendar_event",

  description:
    "Propose a calendar event for owner approval, to schedule a meeting between the business and the sender (or another party) that the business is hosting or organizing. Do not create the Google Calendar event directly. A confirmation email is sent automatically to the customer once approved, using the confirmationMessage you provide. Do NOT use this to accept, confirm, or RSVP to a meeting invitation extended to the account holder personally by someone else.",

  parameters: proposeCalendarEventParams,

  surfaces: ["email"],
  capability: "calendar",

  isAvailable: (context: ToolContext) =>
    context.permissions.calendarWriteCapability === "propose_only",

  terminal: true,
  createsApproval: true,

  execute: executeProposeCalendarEvent,
};
