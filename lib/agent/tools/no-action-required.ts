import type { ToolContext, ToolDefinition } from "./types";

/**
 * Bug fix (found via live testing, 2026-08-21): before this tool existed,
 * there was no legitimate way for the agent to conclude "no business
 * action is required" for an email. The only two ways run.ts's
 * multi-step loop could end were a terminal tool call (send_reply,
 * create_draft, etc.) or exhausting MAX_AGENT_STEPS, which throws and
 * marks the email_actions row as "failed."
 *
 * When the model returned plain text with no tool call — including a
 * genuinely correct "no action is needed, this requires the account
 * holder's own personal input" — the loop's only response was to push
 * back a corrective instruction ("you must use either send_reply or
 * create_draft... if no action is required, explain why") and try
 * again. But "explain why" as plain text was *never actually accepted*
 * as a terminal state by the loop itself — plain text always looped
 * back to the same corrective message. Observed in production: the
 * model correctly explained three times in a row that no action was
 * warranted (an email required the account holder's own personal
 * preferences it had no authority to invent), and on the fourth
 * corrective push, it gave in and fabricated a customer-voice reply
 * expressing specific preferences and enthusiasm it had just finished
 * explaining it wasn't authorized to originate — directly contradicting
 * its own prior, correct reasoning, under repeated pressure from a loop
 * that had no legitimate exit for "nothing to do here."
 *
 * Fix: give the model an explicit, first-class way to terminate with
 * "no action needed" that the loop treats as a real, successful outcome
 * (see `terminal: true` below) rather than an unrecognized non-answer.
 */
export const noActionRequiredTool: ToolDefinition = {
  name: "no_action_required",

  description:
    "Conclude that no business action or reply is required for this email. Use this — never a plain-text response — when, after genuinely reassessing, you determine the email needs no reply from you: it requires the account holder's own personal input/preferences/decision that you have no authority or grounding to originate, it's purely informational with nothing to act on, it's spam/irrelevant, or the task is already complete. A plain-text response without a tool call is never delivered to anyone and is not an accepted way to end processing — this tool is.",

  parameters: {
    type: "object",

    properties: {
      reason: {
        type: "string",
        description:
          "Brief internal explanation of why no action is required. Logged internally only — never shown to anyone.",
      },
    },

    required: ["reason"],
  },

  surfaces: ["email"],
  capability: "gmail", // baseline — never pruned by the router, same as create_draft/send_reply.

  isAvailable: () => true,

  terminal: true,
  createsApproval: false,

  async execute(args: Record<string, any>, context: ToolContext) {
    const { supabase, email } = context;

    if (!email) {
      throw new Error("no_action_required requires email context");
    }

    const reason =
      typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim()
        : "No reason provided.";

    const { error: actionUpdateError } = await supabase
      .from("email_actions")
      .update({
        action_type: "no_action_required",
        status: "processed",
        draft_content: null,
        reasoning: reason,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", email.emailActionId);

    if (actionUpdateError) {
      throw new Error(
        `Failed to update email action: ${actionUpdateError.message}`
      );
    }

    return {
      success: true,
      action: "no_action_taken",
      message:
        "No business action was taken for this email. This is a normal, successful outcome — not a failure.",
    };
  },
};
