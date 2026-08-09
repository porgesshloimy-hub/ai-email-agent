import { createServiceSupabase } from "@/lib/supabase/server";
import type { GmailAction, PermissionLevel } from "@/types";

/**
 * The permission engine is the enforcement point — never the model.
 * The OpenAI call is only ever given tool definitions for actions this
 * function has already cleared. The model cannot request a tool it wasn't
 * offered, and "send" is structurally unavailable whenever it requires
 * approval — the agent's only option in that case is "create draft."
 */
export async function getPermissionLevel(
  tenantId: string,
  action: GmailAction
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
export async function getAutonomousActions(tenantId: string): Promise<GmailAction[]> {
  const supabase = createServiceSupabase();
  const { data } = await supabase
    .from("agent_permissions")
    .select("action, level")
    .eq("tenant_id", tenantId);

  return (data ?? [])
    .filter((row) => row.level === "allowed")
    .map((row) => row.action as GmailAction);
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
