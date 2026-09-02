import type { ToolContext, ToolDefinition } from "./types";
import { resolveOwnerApprovalPath, createSyncConfirmHold } from "@/lib/agent/approval/resolve";

/**
 * NEW TOOL — closes a real, confirmed gap: `deleteEvent()` already
 * existed in `lib/calendar/client.ts` (deletes the real Google Calendar
 * event and notifies attendees), but nothing in the agent's tool
 * registry ever called it. Unlike the earlier meeting-link incident,
 * the agent's claim of "I can't delete events" was actually TRUE before
 * this — not a self-confusion bug, a genuine missing capability.
 *
 * Chat-only, gated on real calendar.write access (same capability that
 * already gates creating events — this project's permission schema has
 * no separate calendar.delete level). Deletion requires the event's
 * real Google event ID, which the model gets by calling
 * check_calendar_availability first — that tool's `events` array now
 * includes each event's `googleEventId`.
 *
 * Goes through the same owner-directed approval resolution as
 * create_calendar_event and send_email (see
 * lib/agent/approval/resolve.ts): scoreDeleteInstructionExplicitness()
 * requires BOTH a clear delete/cancel verb AND identifying information
 * (a day/time reference or a quoted event name) before executing
 * directly — deletion is destructive and only trivially correctable by
 * recreating the event from scratch, closer in risk to send_email than
 * to creating a new event. "Delete the duplicate one" (no day/time/name)
 * holds for confirmation; "cancel my 3pm meeting today" executes
 * immediately.
 */
export const deleteCalendarEventTool: ToolDefinition = {
  name: "delete_calendar_event",

  description:
    "Permanently delete/cancel a real event on the account holder's Google Calendar and notify any attendees. You must have the event's real googleEventId first — get it from check_calendar_availability, never invent one. Use this only when the owner has clearly asked to delete or cancel a specific event; if you're not sure which event they mean, use check_calendar_availability to find it and confirm with them rather than guessing.",

  parameters: {
    type: "object",
    properties: {
      googleEventId: {
        type: "string",
        description: "The real event ID from check_calendar_availability's events array. Never invent this.",
      },
      summary: {
        type: "string",
        description: "The event's title, for the confirmation message shown to the owner.",
      },
    },
    required: ["googleEventId", "summary"],
  },

  surfaces: ["chat"],
  capability: "calendar",

  isAvailable: (context: ToolContext) =>
    context.permissions.calendarWriteCapability !== "none",

  terminal: false,

  async execute(args: Record<string, any>, context: ToolContext) {
    const { supabase, tenantId } = context;

    /**
     * Bug fix learned from create_calendar_event and send_email: this
     * function is called twice for a sync_confirm action — once when
     * first proposed, and again after the owner confirms. The
     * confirm-path context has no ownerMessageText, so re-running the
     * approval check there would score as not-explicit and create
     * ANOTHER pending confirmation instead of actually deleting —
     * looping forever. context.preApprovedAction distinguishes the two.
     */
    if (!context.preApprovedAction) {
      const ownerMessageText = context.chat?.ownerMessageText ?? "";
      const resolution = resolveOwnerApprovalPath("delete_calendar_event", ownerMessageText);

      await supabase.from("owner_directed_action_log").insert({
        tenant_id: tenantId,
        tool_name: "delete_calendar_event",
        explicitness_heuristic_score: resolution.explicitnessScore,
        executed_directly: resolution.path === "execute",
        content_snapshot: JSON.stringify(args),
        source_channel: "chat",
      });

      if (resolution.path === "sync_confirm") {
        const confirmationMessage = `Just to confirm before I delete it — "${args.summary}". Go ahead?`;

        const { error: pendingError } = await supabase
          .from("pending_owner_confirmations")
          .insert({
            tenant_id: tenantId,
            tool_name: "delete_calendar_event",
            args,
            confirmation_message: confirmationMessage,
            explicitness_score: resolution.explicitnessScore,
          });

        if (pendingError) {
          /**
           * Fail open toward the SAFER behavior — if we can't record
           * that a confirmation is pending, deleting anyway would
           * defeat the entire point of this check, and a deleted event
           * can't be un-deleted.
           */
          console.error("FAILED TO STORE PENDING DELETE CONFIRMATION:", {
            tenantId,
            error: pendingError,
          });
          return createSyncConfirmHold("I wasn't able to set that up for confirmation — please try again.");
        }

        return createSyncConfirmHold(confirmationMessage);
      }
    }

    /**
     * Bug found in production: this call had NO error handling at
     * all. If Google's Calendar API throws for any reason — a stale or
     * slightly-wrong event ID, the event already gone, a permissions
     * hiccup, a transient network error — the exception propagated
     * uncaught all the way up through this multi-step tool loop, into
     * the Inngest step running the whole reply. Inngest retries a
     * failing step; if the underlying cause is deterministic (a
     * genuinely bad ID), every retry fails the same way and the entire
     * function eventually fails — meaning NO reply gets persisted at
     * all, not even an error message. That's indistinguishable from
     * "the agent silently did nothing," which is exactly what got
     * reported. Now caught and turned into an honest, specific message
     * instead of a total silent failure.
     */
    const { deleteEvent } = await import("@/lib/calendar/client");

    try {
      await deleteEvent(tenantId, args.googleEventId);
    } catch (err) {
      console.error("DELETE CALENDAR EVENT FAILED:", { tenantId, googleEventId: args.googleEventId, error: err });
      return `I tried to delete "${args.summary}" but ran into an error — it may already be gone, or something went wrong on Google's end. Could you check your calendar directly, or ask me to try again?`;
    }

    return `Done — deleted "${args.summary}" from your calendar.`;
  },
};
