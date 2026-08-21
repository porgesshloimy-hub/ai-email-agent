import { notifyApproval } from "@/lib/notify";

import type { ToolContext, ToolDefinition } from "./types";

const proposeZoomMeetingParams = {
  type: "object" as const,

  properties: {
    topic: { type: "string" },

    startTime: {
      type: "string",
      description: "ISO 8601 meeting start time.",
    },

    durationMinutes: {
      type: "number",
      description: "Meeting duration in minutes.",
    },

    timezone: { type: "string" },

    agenda: { type: "string" },

    reasoning: { type: "string" },

    confirmationMessage: {
      type: "string",
      description:
        "The complete customer-facing confirmation email to send automatically if the account holder approves this proposal. Write it now, in the same natural tone as your other replies, as if the meeting is confirmed. Include the exact placeholder {{meeting_link}} on its own wherever the Zoom join link should appear; it will be replaced with the real link before sending.",
    },
  },

  required: [
    "topic",
    "startTime",
    "durationMinutes",
    "reasoning",
    "confirmationMessage",
  ],
};

/**
 * DISCREPANCY (found while diffing run.ts's buildToolDefinitions, not
 * introduced here): exactly like propose_calendar_event, run.ts defines
 * "propose_zoom_meeting" TWICE with identical `parameters` but two
 * different `description` strings, gated on two mutually exclusive
 * permission states (zoomCapability === "write", alongside
 * create_zoom_meeting; vs. zoomCapability === "propose_only", the only
 * Zoom tool offered in that state). Kept as two ToolDefinition exports
 * sharing one execute() so the schema seen by the model in each state
 * stays byte-identical to before.
 */

async function executeProposeZoomMeeting(
  args: Record<string, any>,
  context: ToolContext
) {
  const { supabase, tenantId, email, permissions } = context;

  if (!email) {
    throw new Error("propose_zoom_meeting requires email context");
  }

  if (
    permissions.zoomCapability !== "propose_only" &&
    permissions.zoomCapability !== "write"
  ) {
    const { SecurityViolationError } = await import("./security");
    throw new SecurityViolationError(
      "Security violation: Zoom meeting proposal attempted incorrectly"
    );
  }

  if (
    typeof args.confirmationMessage !== "string" ||
    !args.confirmationMessage.trim()
  ) {
    throw new Error(
      "propose_zoom_meeting requires a non-empty confirmationMessage"
    );
  }

  const { data: zoomAction, error } = await supabase
    .from("calendar_actions")
    .insert({
      tenant_id: tenantId,
      action_type: "create_zoom_meeting",
      status: "pending_approval",
      proposed_summary: args.topic,
      proposed_start: args.startTime,
      proposed_end: new Date(
        new Date(args.startTime).getTime() +
          Number(args.durationMinutes) * 60 * 1000
      ).toISOString(),
      reasoning: args.reasoning ?? null,
      customer_email: email.from,
      gmail_thread_id: email.threadId,
      gmail_message_id: email.messageId,
      gmail_subject: email.subject,
      draft_confirmation_body: args.confirmationMessage,
    })
    .select("id")
    .single();

  if (error || !zoomAction) {
    throw new Error(
      `Failed to create Zoom meeting proposal: ${
        error?.message ?? "unknown error"
      }`
    );
  }

  const { data: approval, error: approvalError } = await supabase
    .from("approvals")
    .insert({
      tenant_id: tenantId,
      action_type: "calendar.meet",
      action_id: zoomAction.id,
      status: "pending",
      description: `Create Zoom meeting "${args.topic}"`,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();

  if (approvalError || !approval) {
    throw new Error(
      `Failed to create Zoom approval: ${
        approvalError?.message ?? "unknown error"
      }`
    );
  }

  await notifyApproval(
    tenantId,
    approval.id,
    `Zoom meeting needs approval.\n\n${args.topic}\n${args.startTime}`
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
    action: "zoom_meeting_pending_approval",
    approvalId: approval.id,
    message:
      "The Zoom meeting was submitted for owner approval, along with the confirmation email that will be sent automatically if approved. No Zoom meeting has been created yet.",
  };
}

/** Variant offered alongside create_zoom_meeting (zoomCapability === "write"). */
export const proposeZoomMeetingWriteTool: ToolDefinition = {
  name: "propose_zoom_meeting",

  description:
    "Propose a Zoom meeting for the account holder's approval, rather than creating it immediately. Use this when the meeting time, date, or purpose is otherwise grounded and reasonable, but confirming it would require the account holder's own personal availability, judgment, or preference — for example, when a customer proposes a specific time and the business's actual availability at that time is not something you can verify or assume. This creates a pending proposal the account holder can approve or reject; a confirmation email is sent automatically to the customer once approved, using the confirmationMessage you provide. It does not create the actual Zoom meeting immediately. Do not send or draft a separate customer-facing reply promising a specific time until this proposal has been approved.",

  parameters: proposeZoomMeetingParams,

  surfaces: ["email"],
  capability: "zoom",

  isAvailable: (context: ToolContext) =>
    context.permissions.zoomCapability === "write",

  terminal: true,
  createsApproval: true,

  execute: executeProposeZoomMeeting,
};

/** Variant offered when zoomCapability === "propose_only" (the only Zoom tool in that state). */
export const proposeZoomMeetingProposeOnlyTool: ToolDefinition = {
  name: "propose_zoom_meeting",

  description:
    "Propose a Zoom meeting for owner approval. Use this when the business should host a Zoom meeting but the calendar.meet permission requires approval. Do not create the Zoom meeting directly. A confirmation email is sent automatically to the customer once approved, using the confirmationMessage you provide. Do not use this to accept or RSVP to a meeting invitation sent personally to the account holder.",

  parameters: proposeZoomMeetingParams,

  surfaces: ["email"],
  capability: "zoom",

  isAvailable: (context: ToolContext) =>
    context.permissions.zoomCapability === "propose_only",

  terminal: true,
  createsApproval: true,

  execute: executeProposeZoomMeeting,
};
