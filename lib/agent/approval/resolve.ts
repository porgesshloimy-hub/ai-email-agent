/**
 * ------------------------------------------------------------
 * Owner-directed approval path resolution
 * ------------------------------------------------------------
 *
 * `approval_required` was, until now, a single static gate applied
 * identically regardless of who's directing an action. That's correct
 * for the customer-facing email pipeline (the model inferring on its
 * own that a reply is appropriate genuinely needs a human check), but
 * wrong for an owner sitting in a live chat conversation directing the
 * action themselves — the owner isn't approving the agent's judgment
 * after the fact, they ARE the judgment, in the moment, provided they
 * actually specified the substance rather than delegating a judgment
 * call to the model.
 *
 * This resolves which of two paths an owner-directed tool call should
 * take:
 *
 *   'execute'      — the owner's own message supplied the specifics
 *                     (see lib/agent/approval/explicitness-heuristic.ts)
 *                     — run the tool immediately, no confirmation needed
 *   'sync_confirm' — the model had to invent or infer some of the
 *                     substance — hold the action and ask the owner to
 *                     confirm it, in the same conversation, rather than
 *                     silently acting or routing to the async dashboard
 *                     approval queue (the owner is right here; a queue
 *                     they'd see later is the wrong mechanism)
 *
 * Customer-triggered actions (the email pipeline) are entirely
 * untouched by this — this module is only ever consulted from the
 * owner-facing chat surface.
 */

import { scoreCalendarInstructionExplicitness, scoreEmailInstructionExplicitness, scoreDeleteInstructionExplicitness } from "@/lib/agent/approval/explicitness-heuristic";

export type ApprovalPath = "execute" | "sync_confirm";

export interface ApprovalResolution {
  path: ApprovalPath;
  explicitnessScore: number;
  reasons: string[];
}

/**
 * A distinguishable return shape for a tool's `sync_confirm` branch,
 * added when chat.ts gained a real multi-step tool-calling loop (see
 * that file's comment on `runChatToolLoop` for the full story — this
 * exists to fix a genuine bug where deleting two calendar events in one
 * turn was structurally impossible with the old single-tool-call
 * dispatch, and the model narrated "deleting both now" as plain text
 * instead, since it had no real way to make a second call).
 *
 * Previously, every tool's sync_confirm branch just returned a bare
 * string, identical in shape to a normal completed-action result
 * (e.g. "Done — booked X"). Once the loop needed to decide "should I
 * feed this result back to the model for a possible next tool call, or
 * stop entirely and wait for the owner's next message," a bare string
 * couldn't answer that question — a "Done — X" string SHOULD loop back
 * (the model might have another action queued, like deleting a second
 * event), but a "just to confirm — X, go ahead?" string must NOT loop
 * back, since there's nothing productive left to do until the owner
 * actually replies. This sentinel makes that distinction explicit and
 * type-checked instead of string-sniffing tool output.
 */
export interface SyncConfirmHold {
  __syncConfirmHold: true;
  message: string;
}

export function createSyncConfirmHold(message: string): SyncConfirmHold {
  return { __syncConfirmHold: true, message };
}

export function isSyncConfirmHold(value: unknown): value is SyncConfirmHold {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__syncConfirmHold === true
  );
}

/**
 * Only calendar-style owner actions are resolved here today, since
 * create_calendar_event (chat surface) is the only owner-directed tool
 * with a real external side effect that currently exists. Adding a
 * second owner-directed action later (e.g. an eventual owner-directed
 * send tool) means adding a case here, not restructuring this function.
 */
export function resolveOwnerApprovalPath(
  toolName: string,
  ownerMessageText: string
): ApprovalResolution {
  if (toolName === "create_calendar_event") {
    const result = scoreCalendarInstructionExplicitness(ownerMessageText);
    return {
      path: result.isExplicit ? "execute" : "sync_confirm",
      explicitnessScore: result.score,
      reasons: result.reasons,
    };
  }

  if (toolName === "send_email") {
    const result = scoreEmailInstructionExplicitness(ownerMessageText);
    return {
      path: result.isExplicit ? "execute" : "sync_confirm",
      explicitnessScore: result.score,
      reasons: result.reasons,
    };
  }

  if (toolName === "delete_calendar_event") {
    const result = scoreDeleteInstructionExplicitness(ownerMessageText);
    return {
      path: result.isExplicit ? "execute" : "sync_confirm",
      explicitnessScore: result.score,
      reasons: result.reasons,
    };
  }

  /**
   * Unknown/future owner-directed tool with no scoring logic yet: fail
   * toward the safer path (confirm) rather than assuming explicitness
   * for a tool this module has no actual basis to judge.
   */
  return {
    path: "sync_confirm",
    explicitnessScore: 0,
    reasons: ["no explicitness heuristic defined for this tool — defaulting to confirm"],
  };
}
