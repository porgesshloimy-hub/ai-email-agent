/**
 * Provider-agnostic, surface-agnostic tool registry types.
 *
 * Before this file, lib/agent/run.ts (the email pipeline) and
 * lib/agent/chat.ts (the Google Chat handler) each hand-built their own
 * tool-definition arrays and their own if/else dispatch chains. The two
 * had drifted apart before (see the comments in chat.ts). This module
 * is the shared shape both surfaces now build their tool list from and
 * dispatch through, so there is exactly one definition of each tool's
 * schema and behavior instead of two.
 *
 * `parameters` is already in the flat, provider-agnostic shape
 * lib/agent/llm/types.ts's LlmToolDefinition expects (name, description,
 * parameters) — the OpenAI-nested `{ type: "function", function: {...} }`
 * wrapping that run.ts used to build (and then immediately flatten via
 * toLlmToolDefinitions) has been dropped since it was pure ceremony.
 */

import type { createServiceSupabase } from "@/lib/supabase/server";

export type SupabaseServiceClient = ReturnType<typeof createServiceSupabase>;

export type ToolSurface = "email" | "chat";

export interface ToolPermissions {
  /**
   * Whether an immediate customer-facing send is currently authorized.
   * For the email surface this is run.ts's `effectiveSendAllowed`
   * (sendCapability === "send" AND no business rule requires approval
   * for this email's topic). The chat surface never sets this — Google
   * Chat has no send_reply/create_draft tools.
   */
  sendAllowed: boolean;

  calendarReadAllowed: boolean;

  calendarWriteCapability: "write" | "propose_only" | "none";

  zoomCapability: "write" | "propose_only" | "none";
}

/**
 * Everything the running email whose thread a tool call applies to. Only
 * present when the current surface is "email".
 */
export interface ToolEmailContext {
  threadId: string;
  messageId: string;
  from: string;
  subject: string;
  /** The email_actions row id reserved for this incoming email. */
  emailActionId: string;
}

/**
 * Precomputed data check_pending_approvals reports on. chat.ts already
 * fetches this once (it's also used to render the system prompt), so it
 * is threaded through here rather than re-queried inside the tool.
 */
export interface ToolChatContext {
  pendingEmails: { draft_content?: string | null }[] | null;
  pendingEmailCount: number | null;
  /**
   * The owner's raw, unmodified chat message for this turn. Added for
   * lib/agent/approval/resolve.ts's owner-directed approval path
   * resolution — scoring whether an instruction was explicit has to
   * look at what the owner actually typed, not the model's
   * interpretation of it (that self-report is exactly what this check
   * exists to not trust).
   */
  ownerMessageText: string;
}

export interface ToolContext {
  tenantId: string;
  supabase: SupabaseServiceClient;
  permissions: ToolPermissions;
  email?: ToolEmailContext;
  chat?: ToolChatContext;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Provider-agnostic JSON Schema object, as consumed by lib/agent/llm/'s LlmToolDefinition.parameters. */
  parameters: Record<string, any>;
  surfaces: ToolSurface[];
  /** Tag grouping related tools for a future capability router — not consumed by anything yet. */
  capability: string;

  /**
   * Whether this tool should be offered to the model given the current
   * context (permissions, in practice). Mirrors the conditions that used
   * to gate whether buildToolDefinitions()/buildChatToolDefinitions()
   * pushed this tool into the array at all.
   */
  isAvailable(context: ToolContext): boolean;

  /**
   * Execute the tool call and return whatever gets reported back.
   *
   * - Email surface: the JSON-able object that becomes the "tool" role
   *   message content sent back to the model (run.ts JSON.stringify's
   *   whatever this returns).
   * - Chat surface: the plain string returned as the final Google Chat
   *   response (chat.ts never loops the result back through the model —
   *   it answers directly).
   */
  execute(args: Record<string, any>, context: ToolContext): Promise<any>;

  /**
   * Static per-tool metadata used only by the email surface's agent
   * loop to decide whether a successful call ends the run
   * (terminalActionTaken/completedAction) and/or means an approval was
   * queued (approvalCreated) — mirrors the hardcoded flag-setting that
   * used to sit inline in each `if (toolName === "...")` branch in
   * run.ts. Not used by chat.ts, which has no multi-step loop.
   */
  terminal?: boolean;
  createsApproval?: boolean;

  /**
   * True only for tools whose successful execution means the
   * real-world action for this `capability` actually, synchronously
   * happened this run (e.g. create_zoom_meeting, create_calendar_event
   * — a real Zoom meeting or Calendar event now exists). NOT set for
   * propose_* tools (they only queue an approval — nothing has
   * actually happened yet) or for tools with no external side effect
   * (create_draft, send_reply, check_calendar_availability,
   * no_action_required, etc.).
   *
   * Consumed by lib/agent/run.ts to build a per-run
   * `completedCapabilities` ledger, which lib/agent/grounding-guard.ts
   * then checks outgoing reply text against — see that file's module
   * comment for why this is a ledger-driven check rather than a
   * per-connector keyword list. A future connector's real-completion
   * tool (e.g. a Drive "upload_file" tool) picks this up automatically
   * just by setting this flag; nothing else needs to change.
   */
  marksCapabilityCompleted?: boolean;
}
