import { createDraft, sendDraft } from "@/lib/gmail/client";

import { SecurityViolationError } from "./security";
import type { ToolContext, ToolDefinition } from "./types";

/**
 * Moved verbatim from lib/agent/run.ts's buildToolDefinitions() (pushed
 * only when flags.sendAllowed) and the `if (toolName === "send_reply")`
 * dispatch branch. Email surface only.
 */
export const sendReplyTool: ToolDefinition = {
  name: "send_reply",

  description:
    "Send a reply immediately. Only use this when the exact response is clearly supported by the configured business rules or business knowledge AND the business owner's permission settings explicitly allow sending. Never use this to make a new business decision, invent a policy, or assume authorization.",

  parameters: {
    type: "object",

    properties: {
      body: {
        type: "string",
        description: "The complete reply body.",
      },

      reasoning: {
        type: "string",
        description:
          "Brief internal explanation (1-2 sentences) of why this reply is authorized and appropriate. Logged internally only — never shown to the customer or referenced in the email body.",
      },
    },

    required: ["body", "reasoning"],
  },

  surfaces: ["email"],
  capability: "gmail",

  isAvailable: (context: ToolContext) => context.permissions.sendAllowed,

  terminal: true,

  async execute(args: Record<string, any>, context: ToolContext) {
    const { supabase, tenantId, email, permissions } = context;

    if (!email) {
      throw new Error("send_reply requires email context");
    }

    /**
     * Defense in depth: the tool is only ever offered when sendAllowed
     * is true (see isAvailable above), so this should be unreachable.
     * Kept as an explicit re-check exactly as it existed inline in
     * run.ts, because a model should structurally never be able to
     * reach this branch — if it does, that's a bug in tool exposure,
     * not an ordinary failure.
     */
    if (!permissions.sendAllowed) {
      throw new SecurityViolationError(
        "Security violation: send_reply was attempted without permission"
      );
    }

    if (typeof args.body !== "string" || !args.body.trim()) {
      throw new Error("send_reply requires a non-empty body");
    }

    const draft = await createDraft(
      tenantId,
      email.threadId,
      email.from,
      `Re: ${email.subject}`,
      args.body,
      email.messageId
    );

    if (!draft.id) {
      throw new Error("Gmail did not return a draft ID");
    }

    await sendDraft(tenantId, draft.id);

    const { error: sentUpdateError } = await supabase
      .from("email_actions")
      .update({
        action_type: "draft_reply",
        status: "sent",
        gmail_draft_id: draft.id,
        gmail_draft_message_id: draft.message?.id ?? null,
        draft_content: args.body,
        reasoning: args.reasoning ?? null,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", email.emailActionId);

    if (sentUpdateError) {
      throw new Error(
        `Failed to update sent email action: ${sentUpdateError.message}`
      );
    }

    return {
      success: true,
      action: "sent",
      draftId: draft.id,
      message: "The reply was successfully sent to the customer.",
    };
  },
};
