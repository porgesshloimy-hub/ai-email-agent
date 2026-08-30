import type { ToolContext, ToolDefinition } from "./types";
import { resolveOwnerApprovalPath } from "@/lib/agent/approval/resolve";

/**
 * NEW TOOL — real email sending, deliberately scoped narrower than
 * compose_email_draft. Built after explicit discussion: the owner
 * wanted the agent able to send when they request it, but NOT to
 * decide on its own that sending seems appropriate. That second case —
 * autonomous, unprompted outbound contact — was deliberately rejected
 * and is NOT what this tool does; it is only ever reachable in response
 * to an owner's own chat message, the same way every other
 * owner-directed tool in this codebase already works.
 *
 * Gated on emailDraftCapability === "send" specifically (not
 * "draft_only") — a tenant without real gmail.send access never sees
 * this tool at all, regardless of how the owner phrases a request.
 *
 * Even when available, this NEVER sends purely because the model
 * decided to call it — resolveOwnerApprovalPath() (using
 * scoreEmailInstructionExplicitness()) checks whether the owner
 * actually gave a clear, direct instruction to send. That check was
 * originally stricter — requiring dictated/quoted wording on top of a
 * real recipient — but that meant even an unambiguous "send it" still
 * got held for a second confirmation purely because the wording wasn't
 * dictated verbatim. Loosened after explicit feedback: the actual thing
 * worth protecting against is the model sending with no real owner
 * request behind it at all, which can't happen here regardless, since
 * this tool is only ever reached in response to the owner's own
 * message. A clear send directive is now sufficient on its own —
 * composing the wording is fine as long as sending was actually
 * requested, not just discussed.
 */
export const sendEmailTool: ToolDefinition = {
  name: "send_email",

  description:
    "Send a real email immediately — not a draft. Use this whenever the owner has given you a clear, direct instruction to send (e.g. \"send it\", \"go ahead and send\") — composing the wording yourself is fine as long as sending was actually requested. Use compose_email_draft instead only when the owner has expressed general intent without actually telling you to send (e.g. mentioning someone should be emailed, without asking you to do it).",

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
        description: "The full email body text, using the owner's own dictated/quoted wording where given.",
      },
    },
    required: ["to", "subject", "body"],
  },

  surfaces: ["chat"],
  capability: "gmail",

  isAvailable: (context: ToolContext) =>
    context.permissions.emailDraftCapability === "send",

  terminal: false,

  async execute(args: Record<string, any>, context: ToolContext) {
    const { supabase, tenantId, permissions } = context;

    /**
     * Defense in depth, same pattern as every other tool: this should
     * be unreachable given isAvailable() above, but the model is never
     * trusted to have honored that gate itself.
     */
    if (permissions.emailDraftCapability !== "send") {
      const { SecurityViolationError } = await import("./security");
      throw new SecurityViolationError(
        "Security violation: direct email send attempted without gmail.send permission"
      );
    }

    /**
     * Bug fix, same as create_calendar_event: this function is called
     * twice for a sync_confirm action — once when first proposed, and
     * again after the owner confirms. The confirm-path context has no
     * ownerMessageText, so re-running the approval check there would
     * score as not-explicit and create ANOTHER pending confirmation
     * instead of actually sending — looping forever. Especially
     * important to get right here, since this tool sends real,
     * irreversible email.
     */
    if (!context.preApprovedAction) {
      const ownerMessageText = context.chat?.ownerMessageText ?? "";
      const resolution = resolveOwnerApprovalPath("send_email", ownerMessageText);

      await supabase.from("owner_directed_action_log").insert({
        tenant_id: tenantId,
        tool_name: "send_email",
        explicitness_heuristic_score: resolution.explicitnessScore,
        executed_directly: resolution.path === "execute",
        content_snapshot: JSON.stringify(args),
        source_channel: "chat",
      });

      if (resolution.path === "sync_confirm") {
        const confirmationMessage =
          `Just to confirm before I send it — to ${args.to}, subject "${args.subject}": ` +
          `"${args.body}". Go ahead and send it?`;

        const { error: pendingError } = await supabase
          .from("pending_owner_confirmations")
          .insert({
            tenant_id: tenantId,
            tool_name: "send_email",
            args,
            confirmation_message: confirmationMessage,
            explicitness_score: resolution.explicitnessScore,
          });

        if (pendingError) {
          /**
           * Fail open toward the SAFER behavior here — if we can't even
           * record that a confirmation is pending, sending anyway would
           * defeat the entire point of this check. This is even more
           * important here than for a calendar entry, since a sent
           * email can't be recalled.
           */
          console.error("FAILED TO STORE PENDING EMAIL CONFIRMATION:", {
            tenantId,
            error: pendingError,
          });
          return "I wasn't able to set that up for confirmation — please try again.";
        }

        return confirmationMessage;
      }
    }

    const { sendNewMessage } = await import("@/lib/gmail/client");
    await sendNewMessage(tenantId, args.to, args.subject, args.body);

    return `Sent — emailed ${args.to} with the subject "${args.subject}".`;
  },
};
