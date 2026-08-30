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
 * scoreEmailInstructionExplicitness(), deliberately more conservative
 * than the calendar heuristic given a sent email can't be undone the
 * way a calendar entry can) checks whether the owner's own message
 * actually supplied a real recipient AND dictated/quoted content.
 * Anything less specific — including a clear intent with composed
 * wording left to the model — is held for an explicit "go ahead?"
 * confirmation in the same chat, exactly like create_calendar_event's
 * sync_confirm path. There is no path in this tool that sends without
 * either the owner's own explicit dictation or an explicit
 * confirmation reply.
 */
export const sendEmailTool: ToolDefinition = {
  name: "send_email",

  description:
    "Send a real email immediately — not a draft. Only use this when the owner has given you a specific recipient and the actual content to send (dictated or quoted). If the owner's request is a general intent without dictated wording (e.g. \"ask John if he's coming\"), use compose_email_draft instead so they can review it first — do not try to make this tool's confirmation step happen by inventing wording yourself.",

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
