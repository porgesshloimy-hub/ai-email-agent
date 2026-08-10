import { createServiceSupabase } from "@/lib/supabase/server";
import type { AgentAction, GmailAction, PermissionLevel } from "@/types";

/**
 * The permission engine is the enforcement point — never the model.
 * The OpenAI call is only ever given tool definitions for actions this
 * function has already cleared. The model cannot request a tool it wasn't
 * offered, and "send" is structurally unavailable whenever it requires
 * approval — the agent's only option in that case is "create draft."
 */
export async function getPermissionLevel(
  tenantId: string,
  action: AgentAction
): Promise<PermissionLevel> {
  const supabase = createServiceSupabase();

  const { data } = await supabase
    .from("agent_permissions")
    .select("level")
    .eq("tenant_id", tenantId)
    .eq("action", action)
    .single();

  // Fail closed: an unconfigured permission defaults to requiring approval,
  // never to "allowed".
  return data?.level ?? "approval_required";
}

/**
 * Given the tenant's permissions, returns the set of Gmail actions the
 * agent may take autonomously right now. "approval_required" actions are
 * deliberately excluded — for those, only drafting is ever exposed to the
 * model (see resolveSendCapability below).
 */
export async function getAutonomousActions(tenantId: string): Promise<AgentAction[]> {
  const supabase = createServiceSupabase();
  const { data } = await supabase
    .from("agent_permissions")
    .select("action, level")
    .eq("tenant_id", tenantId);

  return (data ?? [])
    .filter((row) => row.level === "allowed")
    .map((row) => row.action as AgentAction);
}

/**
 * "Send" is a special case per the product rule: if send requires approval,
 * the agent is only ever given a "draft" tool, never a "send" tool — so
 * there's no path where the model can send by mistake or by being talked
 * into it. This function decides which tool to expose.
 */
export async function resolveSendCapability(
  tenantId: string
): Promise<"send" | "draft_only" | "none"> {
  const sendLevel = await getPermissionLevel(tenantId, "gmail.send");
  const draftLevel = await getPermissionLevel(tenantId, "gmail.draft");

  if (sendLevel === "allowed") return "send";
  if (draftLevel === "allowed" || draftLevel === "approval_required") return "draft_only";
  return "none";
}

/**
 * Same pattern as resolveSendCapability, applied to calendar writes: if
 * calendar.write requires approval, the model never gets a "create_event"
 * tool that actually creates anything — it only gets a "propose_event" tool
 * that logs a suggestion for the owner to confirm in-app. There's no Gmail-
 * draft equivalent for calendar (you can't "draft" an event the same way),
 * so approval-required calendar actions become an approval-queue entry
 * instead, resolved by the owner clicking Confirm.
 */
export async function resolveCalendarWriteCapability(
  tenantId: string
): Promise<"write" | "propose_only" | "none"> {
  const writeLevel = await getPermissionLevel(tenantId, "calendar.write");
  if (writeLevel === "allowed") return "write";
  if (writeLevel === "approval_required") return "propose_only";
  return "none";
}

export async function canReadCalendar(tenantId: string): Promise<boolean> {
  const level = await getPermissionLevel(tenantId, "calendar.read");
  return level === "allowed" || level === "approval_required"; // reading is never gated behind approval, only writes are
}

/**
 * Rule check: scans the tenant's plain-language rules for anything that
 * should force approval regardless of the general permission matrix
 * (e.g. "Refund requests always require approval"). This is intentionally
 * simple keyword/topic matching done server-side before the model acts —
 * for v1, treat this as a second gate, not a substitute for the model's
 * own classification of the email.
 */
export interface RuleCheckResult {
  requiresApproval: boolean;
  matchedRule?: string;
}

export function checkRulesForTopic(
  rules: { description: string }[],
  topicTags: string[]
): RuleCheckResult {
  const lowerTags = topicTags.map((t) => t.toLowerCase());
  for (const rule of rules) {
    const lowerRule = rule.description.toLowerCase();
    if (lowerTags.some((tag) => lowerRule.includes(tag))) {
      return { requiresApproval: true, matchedRule: rule.description };
    }
  }
  return { requiresApproval: false };
}
