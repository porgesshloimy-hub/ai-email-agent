import type { ToolContext, ToolDefinition } from "./types";

/**
 * NEW TOOL (fixes gap #1: the agent had no way to check the account
 * holder's real calendar before creating/proposing a meeting).
 *
 * lib/calendar/client.ts's findAvailability() (a thin wrapper around
 * Google Calendar's freebusy.query) already existed, but nothing ever
 * called it from the agent — create_calendar_event and
 * propose_calendar_event both went straight to "does this time sound
 * reasonable" with no ground truth about what's actually on the
 * calendar. This tool exposes that existing client function to the
 * model as a read-only lookup.
 *
 * Gated on calendar.read (permissions.calendarReadAllowed) rather than
 * calendar.write, since reading availability is not itself an
 * approval-gated action (see lib/agent/permissions.ts's
 * canReadCalendar) and should be usable even for tenants whose
 * calendar.write is set to approval_required or denied — knowing
 * what's busy is useful context even when the agent can only propose,
 * never create.
 *
 * Available on both surfaces: chat.ts already tells the model
 * "You can discuss calendar availability if asked" in its system
 * prompt (see buildChatSystemPrompt) but never actually gave it a tool
 * to check real availability, so that sentence was previously asking
 * the model to answer from nothing. Registering this tool for the
 * "chat" surface as well as "email" fixes that too.
 */
export const checkCalendarAvailabilityTool: ToolDefinition = {
  name: "check_calendar_availability",

  description:
    "Check the account holder's real Google Calendar for existing (busy) events within a time range. Use this before creating or proposing a meeting whenever a specific date/time is involved — for example, before create_calendar_event, propose_calendar_event, create_zoom_meeting, or propose_zoom_meeting — so you don't schedule or confirm something that conflicts with an existing event, and before telling anyone a time is available. This tool ALSO gives you real access to an event's meeting link, if it has one — either from its description text (where a manually-pasted Zoom link commonly lives) or its conferenceLink field (a natively-attached Google Meet/Zoom link). If asked for a meeting link, use this tool and check both fields before answering; if genuinely neither field has one, say so plainly — never invent or guess a link. This tool only reports information; it never creates, modifies, or cancels anything. If the requested time overlaps a busy block, do not create or confirm a meeting at that time — either use propose_calendar_event/propose_zoom_meeting so the account holder can decide, or, if you can suggest a nearby free time you have actually checked, offer that instead. Do not assume a time is free without checking this tool first when the account holder's own availability matters.",

  parameters: {
    type: "object",

    properties: {
      startTime: {
        type: "string",
        description:
          "Start of the time range to check, as an ISO 8601 datetime with timezone information.",
      },

      endTime: {
        type: "string",
        description:
          "End of the time range to check, as an ISO 8601 datetime with timezone information. Use a range that comfortably covers the proposed meeting, not just its exact start/end instant.",
      },
    },

    required: ["startTime", "endTime"],
  },

  surfaces: ["email", "chat"],
  capability: "calendar",

  isAvailable: (context: ToolContext) => context.permissions.calendarReadAllowed,

  terminal: false,

  async execute(args: Record<string, any>, context: ToolContext) {
    const { tenantId, permissions } = context;

    /**
     * Defense in depth, same pattern as every other tool: this should
     * be unreachable given isAvailable() above, but the model is never
     * trusted to have honored that gate itself.
     */
    if (!permissions.calendarReadAllowed) {
      const { SecurityViolationError } = await import("./security");
      throw new SecurityViolationError(
        "Security violation: calendar availability check attempted without permission"
      );
    }

    if (typeof args.startTime !== "string" || !args.startTime.trim()) {
      throw new Error("check_calendar_availability requires startTime");
    }

    if (typeof args.endTime !== "string" || !args.endTime.trim()) {
      throw new Error("check_calendar_availability requires endTime");
    }

    const { findAvailability, listEventsInRange } = await import(
      "@/lib/calendar/client"
    );

    const [busy, events] = await Promise.all([
      findAvailability(tenantId, args.startTime, args.endTime),
      listEventsInRange(tenantId, args.startTime, args.endTime),
    ]);

    return {
      success: true,
      action: "calendar_availability_checked",
      startTime: args.startTime,
      endTime: args.endTime,
      busy,
      /**
       * Bug fix: findAvailability() (freebusy.query) only ever returns
       * busy/free time ranges — Google's API for that endpoint has no
       * concept of a title or description. Without this, the agent
       * could confirm something was blocking a time slot but had no way
       * to say WHAT it was. events comes from a separate events.list
       * call and includes each event's actual summary/description.
       */
      events,
      isFullyFree: busy.length === 0,
      message:
        busy.length === 0
          ? "No existing events overlap this time range — it is currently free on the calendar."
          : "One or more existing events overlap this time range. Do not treat this time as available — see `events` for their titles, descriptions, and conferenceLink (a real meeting link, if the event has one — check both description and conferenceLink before saying no link exists), and `busy` for the exact blocked time ranges.",
    };
  },
};
