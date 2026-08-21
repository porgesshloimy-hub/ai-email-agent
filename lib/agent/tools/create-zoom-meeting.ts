import { createZoomMeeting } from "@/lib/zoom/client";

import type { ToolContext, ToolDefinition } from "./types";

/**
 * Moved verbatim from run.ts's buildToolDefinitions() (pushed only when
 * flags.zoomCapability === "write") and the
 * `if (toolName === "create_zoom_meeting")` dispatch branch. Email
 * surface only — chat.ts never had a Zoom tool.
 */
export const createZoomMeetingTool: ToolDefinition = {
  name: "create_zoom_meeting",

  description:
    "Create a Zoom meeting for the business to host immediately, with no approval step. Use this ONLY when the date, time, duration, and purpose are fully grounded in the email, business knowledge, business rules, or explicit instructions, AND creating the meeting does not require confirming the account holder's own personal availability. Do not use this to accept, confirm, or RSVP to a Zoom or other meeting invitation that was extended to the account holder personally by someone else. If confirming the meeting depends on whether the account holder personally is free at that time, use propose_zoom_meeting instead so the account holder can approve it themselves. After creating the meeting, reassess whether a Google Calendar event and/or separate customer-facing Gmail reply is also appropriate.",

  parameters: {
    type: "object",

    properties: {
      topic: {
        type: "string",
        description: "Short natural title for the Zoom meeting.",
      },

      startTime: {
        type: "string",
        description:
          "Meeting start time as an ISO 8601 datetime with timezone information.",
      },

      durationMinutes: {
        type: "number",
        description: "Meeting duration in minutes.",
      },

      timezone: {
        type: "string",
        description:
          "IANA timezone for the meeting, such as Europe/London. Use the timezone explicitly stated or clearly implied by the email/business context when available.",
      },

      agenda: {
        type: "string",
        description: "Optional short description or agenda for the meeting.",
      },

      reasoning: {
        type: "string",
        description:
          "Brief internal explanation of why creating this Zoom meeting is authorized and appropriate. Logged internally only.",
      },
    },

    required: ["topic", "startTime", "durationMinutes", "reasoning"],
  },

  surfaces: ["email"],
  capability: "zoom",

  isAvailable: (context: ToolContext) =>
    context.permissions.zoomCapability === "write",

  terminal: false,

  async execute(args: Record<string, any>, context: ToolContext) {
    const { tenantId, permissions } = context;

    if (permissions.zoomCapability !== "write") {
      const { SecurityViolationError } = await import("./security");
      throw new SecurityViolationError(
        "Security violation: Zoom meeting creation attempted without permission"
      );
    }

    if (typeof args.topic !== "string" || !args.topic.trim()) {
      throw new Error("create_zoom_meeting requires a non-empty topic");
    }

    if (typeof args.startTime !== "string" || !args.startTime.trim()) {
      throw new Error("create_zoom_meeting requires startTime");
    }

    if (
      typeof args.durationMinutes !== "number" ||
      args.durationMinutes <= 0
    ) {
      throw new Error(
        "create_zoom_meeting requires a positive durationMinutes"
      );
    }

    const zoomMeeting = await createZoomMeeting(tenantId, {
      topic: args.topic,
      startTime: args.startTime,
      durationMinutes: args.durationMinutes,
      timezone:
        typeof args.timezone === "string" && args.timezone.trim()
          ? args.timezone
          : undefined,
      agenda:
        typeof args.agenda === "string" && args.agenda.trim()
          ? args.agenda
          : undefined,
    });

    return {
      success: true,
      action: "zoom_meeting_created",
      meetingId: String(zoomMeeting.id),
      topic: zoomMeeting.topic,
      startTime: zoomMeeting.start_time,
      duration: zoomMeeting.duration,
      timezone: zoomMeeting.timezone ?? args.timezone ?? null,
      joinUrl: zoomMeeting.join_url,
      message:
        "The Zoom meeting was successfully created. The meeting join URL is available in this result. This does not automatically send a Gmail message to the customer. If the customer needs the link, reassess the task and use send_reply or create_draft according to the available permissions.",
    };
  },
};
