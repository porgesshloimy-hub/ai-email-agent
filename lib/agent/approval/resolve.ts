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

import { scoreCalendarInstructionExplicitness, scoreEmailInstructionExplicitness } from "@/lib/agent/approval/explicitness-heuristic";

export type ApprovalPath = "execute" | "sync_confirm";

export interface ApprovalResolution {
  path: ApprovalPath;
  explicitnessScore: number;
  reasons: string[];
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
