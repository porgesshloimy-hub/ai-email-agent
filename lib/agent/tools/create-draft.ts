import { createDraft } from "@/lib/gmail/client";
import { notifyApproval } from "@/lib/notify";

import type { ToolContext, ToolDefinition } from "./types";

/**
 * Moved verbatim from lib/agent/run.ts's buildToolDefinitions() (the
 * unconditional first entry in the `tools` array) and the
 * `if (toolName === "create_draft")` branch of the dispatch chain.
 * Email surface only — chat.ts never had this tool.
 */
export const createDraftTool: ToolDefinition = {
  name: "create_draft",

  description:
    "Create a Gmail draft reply for human approval. Use this whenever the requested response requires information, judgment, authorization, or a business decision that is not explicitly supported by the configured business rules or knowledge. Also use this for sensitive topics such as refunds, complaints, pricing exceptions, legal matters, cancellations, commitments, or exceptions.",

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
          "Brief internal explanation (1-2 sentences) of why this response is appropriate and why it required approval rather than being sent directly. Logged internally only — never shown to the customer or referenced in the email body.",
      },
    },

    required: ["body", "reasoning"],
  },

  surfaces: ["email"],
  capability: "gmail",

  // create_draft was pushed into buildToolDefinitions() unconditionally.
  isAvailable: () => true,

  terminal: true,
  createsApproval: true,

  async execute(args: Record<string, any>, context: ToolContext) {
    const { supabase, tenantId, email } = context;

    if (!email) {
      throw new Error("create_draft requires email context");
    }

    if (typeof args.body !== "string" || !args.body.trim()) {
      throw new Error("create_draft requires a non-empty body");
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

    const { error: actionUpdateError } = await supabase
      .from("email_actions")
      .update({
        action_type: "draft_reply",
        status: "pending_approval",
        gmail_draft_id: draft.id,
        gmail_draft_message_id: draft.message?.id ?? null,
        draft_content: args.body,
        reasoning: args.reasoning ?? null,
      })
      .eq("id", email.emailActionId);

    if (actionUpdateError) {
      throw new Error(
        `Failed to update email action: ${actionUpdateError.message}`
      );
    }

    const { data: approval, error: approvalError } = await supabase
      .from("approvals")
      .insert({
        tenant_id: tenantId,
        action_type: "gmail.send",
        action_id: email.emailActionId,
        status: "pending",
        description: `Reply to ${email.from} regarding "${email.subject}"`,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select("id")
      .single();

    if (approvalError || !approval) {
      throw new Error(
        `Failed to create approval: ${approvalError?.message ?? "unknown error"}`
      );
    }

    await notifyApproval(
      tenantId,
      approval.id,
      `New email reply ready for approval.\n\nFrom: ${email.from}\nSubject: ${email.subject}`
    );

    return {
      success: true,
      action: "draft_created",
      draftId: draft.id,
      approvalId: approval.id,
      message:
        "The reply draft was created and submitted for owner approval. No further Gmail action is required unless the owner later approves it.",
    };
  },
};
