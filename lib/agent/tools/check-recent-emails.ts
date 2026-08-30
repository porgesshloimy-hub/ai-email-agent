import type { ToolContext, ToolDefinition } from "./types";

/**
 * NEW TOOL — fixes a real reported gap: the owner-chat surface could
 * only ever report on drafts already awaiting approval
 * (ToolChatContext.pendingEmailCount), and would tell the owner "I
 * don't have access to check incoming emails" when asked about the
 * actual inbox — which was true at the time, but not something the
 * product should have been silently stuck with. This exposes real,
 * read-only inbox access: recent messages with sender, subject, date,
 * a short snippet, and unread status.
 *
 * Gated on gmail.read (permissions.gmailReadAllowed) — a real,
 * connection-checked resolver (lib/agent/permissions.ts's
 * canReadGmail()) that didn't exist before this either. Chat-only:
 * this is owner-facing inbox visibility, not something the
 * customer-facing email pipeline has any use for.
 *
 * Read-only by design — this tool can never draft, send, archive, or
 * delete anything. It only looks.
 */
export const checkRecentEmailsTool: ToolDefinition = {
  name: "check_recent_emails",

  description:
    "Check the account holder's actual Gmail inbox for recent or unread messages — not just drafts already awaiting review. Use this whenever asked about incoming email, what's new in the inbox, or a specific sender/subject. Returns sender, subject, date, a short snippet, and whether each message is unread. Read-only: this can never send, draft, archive, or delete anything.",

  parameters: {
    type: "object",
    properties: {
      maxResults: {
        type: "number",
        description: "How many recent messages to return. Defaults to 10 if not specified.",
      },
      query: {
        type: "string",
        description:
          "Optional Gmail search query (e.g. 'is:unread', 'from:john@example.com', 'subject:invoice'). Defaults to the inbox as a whole ('in:inbox') if not specified.",
      },
    },
    required: [],
  },

  surfaces: ["chat"],
  capability: "gmail",

  isAvailable: (context: ToolContext) => context.permissions.gmailReadAllowed,

  terminal: false,

  async execute(args: Record<string, any>, context: ToolContext) {
    const { tenantId, permissions } = context;

    /**
     * Defense in depth, same pattern as every other tool: this should
     * be unreachable given isAvailable() above, but the model is never
     * trusted to have honored that gate itself.
     */
    if (!permissions.gmailReadAllowed) {
      const { SecurityViolationError } = await import("./security");
      throw new SecurityViolationError(
        "Security violation: inbox read attempted without gmail.read permission"
      );
    }

    const maxResults =
      typeof args.maxResults === "number" && args.maxResults > 0
        ? Math.min(args.maxResults, 25)
        : 10;

    const query = typeof args.query === "string" && args.query.trim() ? args.query : "in:inbox";

    const { searchRecentMessages } = await import("@/lib/gmail/client");

    const messages = await searchRecentMessages(tenantId, maxResults, query);

    return {
      success: true,
      action: "recent_emails_checked",
      query,
      count: messages.length,
      messages,
      message:
        messages.length === 0
          ? "No messages matched this query."
          : `Found ${messages.length} message(s) — see \`messages\` for sender, subject, date, snippet, and unread status.`,
    };
  },
};
