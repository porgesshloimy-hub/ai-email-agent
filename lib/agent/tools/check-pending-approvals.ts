import type { ToolContext, ToolDefinition } from "./types";

/**
 * Moved verbatim from chat.ts's buildChatToolDefinitions() (the
 * unconditional first entry) and the
 * `if (toolCall.name === "check_pending_approvals")` dispatch branch.
 * Chat surface only — run.ts never had this tool.
 */
export const checkPendingApprovalsTool: ToolDefinition = {
  name: "check_pending_approvals",

  description:
    "Look up how many email drafts are currently waiting for the owner's review, and list them.",

  parameters: { type: "object", properties: {} },

  surfaces: ["chat"],
  capability: "approvals",

  isAvailable: () => true,

  async execute(_args: Record<string, any>, context: ToolContext) {
    const pendingEmails = context.chat?.pendingEmails ?? null;
    const pendingEmailCount = context.chat?.pendingEmailCount ?? null;

    if (!pendingEmails || pendingEmails.length === 0) {
      return "Nothing waiting on you right now — you're all caught up.";
    }

    const list = pendingEmails
      .map((a) => `• ${a.draft_content?.slice(0, 60)}...`)
      .join("\n");

    return `You have ${pendingEmailCount} draft(s) waiting:\n${list}\n\nReview them at ${process.env.NEXT_PUBLIC_APP_URL}/dashboard/approvals`;
  },
};
