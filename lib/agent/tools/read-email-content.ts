import type { ToolContext, ToolDefinition } from "./types";

/**
 * NEW TOOL — closes a real, reported gap: check_recent_emails could
 * correctly FIND a specific email (sender/subject/date match), but
 * deliberately only ever fetches Gmail's `format: "metadata"` for its
 * results — real content was never available, only `snippet` (Gmail's
 * own short ~100-character auto-preview). Asked what a found email
 * actually said, the agent genuinely had nothing but that preview to
 * work with.
 *
 * Kept as a separate tool from check_recent_emails rather than always
 * fetching full bodies there: a full-body fetch is heavier, and
 * listing 10-25 inbox messages almost never needs every single one's
 * complete content — the natural flow is find first (lightweight),
 * then read one specific message fully once identified. This is
 * exactly the kind of multi-step exchange chat.ts's bounded tool loop
 * (see lib/agent/chat.ts) now supports in one turn.
 *
 * Read-only, same permission gate as check_recent_emails
 * (gmail.read) — this can never send, draft, archive, or delete
 * anything.
 */
export const readEmailContentTool: ToolDefinition = {
  name: "read_email_content",

  description:
    "Get the REAL, full content of one specific email — not just its subject or snippet. Use this after check_recent_emails has identified which message the owner means (you need its real id from that tool's results), whenever they ask what an email actually says, its details, or anything beyond the subject/sender/date. Never guess or make up email content — always call this to get the real text first.",

  parameters: {
    type: "object",
    properties: {
      messageId: {
        type: "string",
        description: "The real message id from check_recent_emails's results. Never invent this.",
      },
    },
    required: ["messageId"],
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
        "Security violation: email content read attempted without gmail.read permission"
      );
    }

    const { readEmailContent } = await import("@/lib/gmail/client");

    try {
      const email = await readEmailContent(tenantId, args.messageId);

      return {
        success: true,
        action: "email_content_read",
        email,
        message:
          "Real email content retrieved — see `email.body` for the actual text. Use this, not the earlier snippet, when describing what it says.",
      };
    } catch (err) {
      console.error("READ EMAIL CONTENT FAILED:", { tenantId, messageId: args.messageId, error: err });
      return `I couldn't retrieve that email's content — it may not exist anymore, or something went wrong. Could you try again?`;
    }
  },
};
