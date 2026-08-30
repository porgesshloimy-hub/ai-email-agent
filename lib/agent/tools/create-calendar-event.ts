import type { ToolContext, ToolDefinition } from "./types";
import { resolveOwnerApprovalPath } from "@/lib/agent/approval/resolve";

/**
 * DISCREPANCY BETWEEN SURFACES (found while diffing, not introduced
 * here): lib/agent/run.ts's buildToolDefinitions() and lib/agent/chat.ts's
 * buildChatToolDefinitions() both defined a tool named "create_calendar_event",
 * but with materially different schemas and dispatch behavior:
 *
 *  - run.ts's version: rich description covering when to use it vs.
 *    propose_calendar_event, a `description` field, `attendeeEmails`
 *    (used to invite the customer), a required `reasoning` field, and a
 *    dispatch that inserts a calendar_actions row, updates email_actions,
 *    and returns a large structured result (including a Google Meet
 *    link) intended to be read by the model on the next step.
 *  - chat.ts's version: a two-sentence description, only
 *    summary/startTime/endTime (no description, no attendeeEmails, no
 *    reasoning), and a dispatch that inserts a calendar_actions row with
 *    a hardcoded reasoning string and returns a final plain-text chat
 *    reply directly (no model round trip).
 *
 * Per the refactor instructions, this is NOT collapsed into one shared
 * schema — doing so would change what each surface actually asks the
 * model for (e.g. suddenly requiring "reasoning" and "attendeeEmails"
 * in Google Chat, which never asked for them). Instead both are kept
 * as separate ToolDefinition exports, both named "create_calendar_event",
 * disambiguated purely by `surfaces` (["email"] vs ["chat"]) so the
 * registry serves the right one to the right surface with byte-identical
 * schemas and behavior to before.
 */

const calendarEventParams = {
  type: "object" as const,

  properties: {
    summary: {
      type: "string",
      description: "Short event title.",
    },

    description: {
      type: "string",
      description: "Optional event description.",
    },

    startTime: {
      type: "string",
      description:
        "ISO 8601 start datetime, WITH a UTC offset included (e.g. 2026-08-26T15:00:00-07:00), not a bare local time — Google Calendar interprets a datetime with no offset as UTC, which silently creates the event at the wrong moment. Use the customer's timezone if one is stated or clearly implied in the conversation; otherwise use the business's own timezone given in the current date/time context above.",
    },

    endTime: {
      type: "string",
      description:
        "ISO 8601 end datetime, WITH a UTC offset included, same rule as startTime.",
    },

    attendeeEmails: {
      type: "array",
      items: { type: "string" },
      description: "Optional attendee email addresses.",
    },

    requestGoogleMeet: {
      type: "boolean",
      description:
        "Whether to attach a real Google Meet video-conference link to this event. Set true only when a video meeting is actually wanted (e.g. the category guidance in your system prompt resolved to Google Meet, or the customer specifically asked for one) — do not attach a Meet link to a plain in-person appointment or a call that doesn't need video. See the video meeting options described in your system prompt for when to prefer this over Zoom, and vice versa.",
    },

    reasoning: {
      type: "string",
      description:
        "Brief internal explanation (1-2 sentences) of why the event should be created. Logged internally only.",
    },
  },

  required: ["summary", "startTime", "endTime", "reasoning"],
};

/** Exported so propose-calendar-event.ts can build on the identical base shape. */
export { calendarEventParams };

/**
 * Email surface. Moved verbatim from run.ts's buildToolDefinitions()
 * (pushed only when flags.calendarWriteCapability === "write") and the
 * `if (toolName === "create_calendar_event")` dispatch branch.
 */
export const createCalendarEventEmailTool: ToolDefinition = {
  name: "create_calendar_event",

  description:
    "Create a calendar event directly, with no approval step, to schedule a meeting between the business and the sender (or another party) — for example, booking a consultation, appointment, or call that the business is hosting or organizing. Use this ONLY when the date, time, and purpose are fully grounded AND creating the event does not require confirming the account holder's own personal availability. Do NOT use this to accept, confirm, or RSVP to a meeting invitation that was extended to the account holder personally by someone else — that is outside your authority regardless of calendar permissions. If confirming the event depends on the account holder's personal availability, use propose_calendar_event instead. Include the customer's email in attendeeEmails when the customer should receive a calendar invitation. The Calendar API will send the calendar invitation automatically using sendUpdates=all. A calendar invitation is separate from a Gmail confirmation reply. After creating the event, reassess whether a separate customer-facing Gmail reply is also appropriate.",

  parameters: calendarEventParams,

  surfaces: ["email"],
  capability: "calendar",

  isAvailable: (context: ToolContext) =>
    context.permissions.calendarWriteCapability === "write",

  terminal: false,

  // A successful call means a real Calendar event now exists — see the
  // field's doc comment in lib/agent/tools/types.ts.
  marksCapabilityCompleted: true,

  async execute(args: Record<string, any>, context: ToolContext) {
    const { supabase, tenantId, email } = context;

    if (!email) {
      throw new Error("create_calendar_event requires email context");
    }

    if (context.permissions.calendarWriteCapability !== "write") {
      const { SecurityViolationError } = await import("./security");
      throw new SecurityViolationError(
        "Security violation: calendar write attempted without permission"
      );
    }

    const { createEvent } = await import("@/lib/calendar/client");

    /**
     * BUG FIX (found while building the alternatives/categories
     * framework — see lib/agent/tools/categories.ts): this previously
     * hardcoded createGoogleMeet: true unconditionally, attaching a
     * Meet link to every single calendar event regardless of whether a
     * video meeting was ever wanted. requestGoogleMeet is now the
     * model's own explicit decision, informed by the video-meeting
     * category guidance in the system prompt.
     */
    const event = await createEvent(tenantId, {
      summary: args.summary,
      description: args.description,
      startTime: args.startTime,
      endTime: args.endTime,
      attendeeEmails: args.attendeeEmails,
      createGoogleMeet: args.requestGoogleMeet === true,
    });

    await supabase.from("calendar_actions").insert({
      tenant_id: tenantId,
      action_type: "create_event",
      status: "sent",
      proposed_summary: args.summary,
      proposed_start: args.startTime,
      proposed_end: args.endTime,
      google_event_id: event.id,
      reasoning: args.reasoning ?? null,
    });

    await supabase
      .from("email_actions")
      .update({
        action_type: "calendar_event",
        status: "processing",
      })
      .eq("id", email.emailActionId);

    return {
      success: true,
      action: "calendar_created",
      googleEventId: event.id,
      summary: args.summary,
      startTime: args.startTime,
      endTime: args.endTime,

      attendeeEmails: args.attendeeEmails ?? [],

      invitation: {
        requested: true,
        method: "google_calendar",
        sendUpdates: "all",
      },

      googleMeetUrl:
        event.hangoutLink ??
        event.conferenceData?.entryPoints?.find(
          (entryPoint: any) => entryPoint.entryPointType === "video"
        )?.uri ??
        null,

      message:
        "The calendar event was successfully created with the customer as an attendee. Google Calendar was instructed to send the calendar invitation email to the attendee. This calendar invitation is separate from any Gmail reply to the customer. If a separate confirmation email is appropriate, use send_reply or create_draft according to the available permissions.",
    };
  },
};

/**
 * Chat surface. Moved verbatim from chat.ts's buildChatToolDefinitions()
 * (pushed whenever calendarWriteCapability !== "none") and its
 * `if (toolCall.name === "create_calendar_event")` dispatch branch.
 *
 * Chatting directly with the owner counts as the owner's own
 * instruction — "write" capability is offered even when calendar.write
 * is set to approval_required for the email pipeline, since here the
 * owner IS the approver, in real time, by virtue of typing the request
 * themselves.
 */
export const createCalendarEventChatTool: ToolDefinition = {
  name: "create_calendar_event",

  description: "Book a calendar event as requested by the owner in this chat.",

  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" },
      startTime: {
        type: "string",
        description:
          "ISO 8601 start datetime, WITH a UTC offset included (e.g. 2026-08-26T15:00:00-07:00) — a bare datetime with no offset is interpreted as UTC by Google Calendar, silently creating the event at the wrong moment. Use the business's own timezone given in the current date/time context above unless the owner states a different one.",
      },
      endTime: {
        type: "string",
        description:
          "ISO 8601 end datetime, WITH a UTC offset included, same rule as startTime.",
      },
    },
    required: ["summary", "startTime", "endTime"],
  },

  surfaces: ["chat"],
  capability: "calendar",

  isAvailable: (context: ToolContext) =>
    context.permissions.calendarWriteCapability !== "none",

  /**
   * Owner-directed approval resolution (lib/agent/approval/resolve.ts):
   * previously this executed unconditionally for every request, whether
   * the owner said "book Johnson tomorrow at 3pm" (fully explicit) or
   * "block off some time tomorrow" (the model would have to invent the
   * actual time/summary). Now the owner's own message is scored, and a
   * request that required the model to fill in gaps is held for
   * confirmation instead of silently executed. Every path — executed
   * directly or held for confirmation — is logged to
   * owner_directed_action_log (migration 010) so nothing here is a
   * silent, unauditable decision.
   */
  async execute(args: Record<string, any>, context: ToolContext) {
    const { supabase, tenantId } = context;

    /**
     * Bug fix: this function is called twice for a sync_confirm action
     * — once when the model first proposes it (needs the approval
     * check), and again after the owner replies "yes" (already
     * resolved, must NOT re-check, since the confirm-path context has
     * no ownerMessageText and would score as not-explicit, creating
     * another pending confirmation instead of actually booking it).
     * context.preApprovedAction distinguishes the two.
     */
    if (!context.preApprovedAction) {
      const ownerMessageText = context.chat?.ownerMessageText ?? "";
      const resolution = resolveOwnerApprovalPath("create_calendar_event", ownerMessageText);

      await supabase.from("owner_directed_action_log").insert({
        tenant_id: tenantId,
        tool_name: "create_calendar_event",
        explicitness_heuristic_score: resolution.explicitnessScore,
        executed_directly: resolution.path === "execute",
        content_snapshot: JSON.stringify(args),
        source_channel: "chat",
      });

      if (resolution.path === "sync_confirm") {
        const confirmationMessage =
          `Just to confirm before I book it — "${args.summary}" from ${args.startTime} to ${args.endTime}. ` +
          `Go ahead?`;

        const { error: pendingError } = await supabase
          .from("pending_owner_confirmations")
          .insert({
            tenant_id: tenantId,
            tool_name: "create_calendar_event",
            args,
            confirmation_message: confirmationMessage,
            explicitness_score: resolution.explicitnessScore,
          });

        if (pendingError) {
          /**
           * Fail open toward the SAFER behavior here — if we can't even
           * record that a confirmation is pending, executing anyway would
           * defeat the entire point of this check. Report the failure
           * back to the owner rather than silently booking the event.
           */
          console.error("FAILED TO STORE PENDING OWNER CONFIRMATION:", {
            tenantId,
            error: pendingError,
          });
          return "I wasn't able to set that up for confirmation — please try again.";
        }

        return confirmationMessage;
      }
    }

    const { createEvent } = await import("@/lib/calendar/client");
    const event = await createEvent(tenantId, {
      summary: args.summary,
      startTime: args.startTime,
      endTime: args.endTime,
    });

    await supabase.from("calendar_actions").insert({
      tenant_id: tenantId,
      action_type: "create_event",
      status: "sent",
      proposed_summary: args.summary,
      proposed_start: args.startTime,
      proposed_end: args.endTime,
      google_event_id: event.id,
      reasoning: "Requested directly via Google Chat — resolved as an explicit owner instruction",
    });

    return `Done — booked "${args.summary}" on your calendar.`;
  },
};
