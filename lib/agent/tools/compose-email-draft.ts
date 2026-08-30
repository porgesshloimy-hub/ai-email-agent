import type { ToolContext, ToolDefinition } from "./types";

/**
 * NEW TOOL — closes a real false-claim gap found in production: asked
 * to email someone, the model told the owner "I can draft one for you
 * to review and send" — but no tool on the chat surface could actually
 * do that. create_draft/send_reply are both surfaces: ["email"] only,
 * and even if they were exposed to chat, createDraft() requires an
 * existing thread to reply within, which doesn't exist for a
 * brand-new, owner-initiated email.
 *
 * This composes a genuinely new outbound draft (lib/gmail/client.ts's
 * createNewDraft(), distinct from createDraft()) and creates it
 * directly in the tenant's Gmail drafts folder for them to review and
 * send themselves — mirroring the honest boundary already established
 * elsewhere in this codebase (the model drafts, a human sends).
 *
 * Never sends directly, even when emailDraftCapability is "send" —
 * composing via a casual chat request is exactly the kind of
 * model-inferred content (recipient/subject/body all synthesized by
 * the model from a vague instruction) that belongs in a human-reviewed
 * draft, not an owner-directed-explicit auto-send. See
 * lib/agent/approval/resolve.ts's explicitness reasoning — an
 * eventual "send this exact email to this exact address" instruction
 * could justify a more direct path later, but composing from scratch
 * should not skip review by default.
 */
export const composeEmailDraftTool: ToolDefinition = {
  name: "compose_email_draft",

  description:
    "Compose a brand-new outbound email (not a reply to an existing thread) and save it as a draft in the account holder's Gmail for them to review and send. Use this whenever the owner asks you to email, message, or write to someone. This never sends anything directly — it only creates a draft.",

  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient email address.",
      },
      subject: {
        type: "string",
      },
      body: {
        type: "string",
        description: "The full email body text.",
      },
    },
    required: ["to", "subject", "body"],
  },

  surfaces: ["chat"],
  capability: "gmail",

  isAvailable: (context: ToolContext) =>
    context.permissions.emailDraftCapability !== "none",

  terminal: false,

  async execute(args: Record<string, any>, context: ToolContext) {
    const { tenantId, permissions } = context;

    if (permissions.emailDraftCapability === "none") {
      const { SecurityViolationError } = await import("./security");
      throw new SecurityViolationError(
        "Security violation: email draft attempted without gmail.draft/gmail.send permission"
      );
    }

    const { createNewDraft } = await import("@/lib/gmail/client");

    const draft = await createNewDraft(tenantId, args.to, args.subject, args.body);

    return `Done — saved a draft to ${args.to} with the subject "${args.subject}". You'll find it in your Gmail drafts to review and send whenever you're ready.`;
  },
};
