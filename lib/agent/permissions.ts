import { createServiceSupabase } from "@/lib/supabase/server";
import { tenantHasCalendarAccess } from "@/lib/google/authClient";
import type {
  AgentAction,
  GmailAction,
  PermissionLevel,
} from "@/types";

/**
 * The permission engine is the enforcement point — never the model.
 * The OpenAI call is only ever given tool definitions for actions this
 * function has already cleared.
 *
 * The model cannot request a tool it wasn't offered.
 *
 * All permissions fail closed.
 */

/**
 * Get the configured permission level for an action.
 */
export async function getPermissionLevel(
  tenantId: string,
  action: AgentAction
): Promise<PermissionLevel> {
  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("agent_permissions")
    .select("level")
    .eq("tenant_id", tenantId)
    .eq("action", action)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("PERMISSION LOOKUP FAILED:", {
      tenantId,
      action,
      error,
    });
  }

  // Fail closed.
  return data?.level ?? "approval_required";
}

/**
 * Return all actions the tenant may perform autonomously.
 */
export async function getAutonomousActions(
  tenantId: string
): Promise<AgentAction[]> {
  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("agent_permissions")
    .select("action, level")
    .eq("tenant_id", tenantId);

  if (error) {
    console.error("AUTONOMOUS ACTION LOOKUP FAILED:", {
      tenantId,
      error,
    });

    return [];
  }

  return (data ?? [])
    .filter((row) => row.level === "allowed")
    .map((row) => row.action as AgentAction);
}

/**
 * Resolve Gmail sending capability.
 *
 * If sending is allowed, the send_reply tool may be exposed.
 *
 * If sending requires approval, the model only gets create_draft.
 */
export async function resolveSendCapability(
  tenantId: string
): Promise<"send" | "draft_only" | "none"> {
  const sendLevel = await getPermissionLevel(
    tenantId,
    "gmail.send"
  );

  const draftLevel = await getPermissionLevel(
    tenantId,
    "gmail.draft"
  );

  if (sendLevel === "allowed") {
    return "send";
  }

  if (
    draftLevel === "allowed" ||
    draftLevel === "approval_required"
  ) {
    return "draft_only";
  }

  return "none";
}

/**
 * Resolve calendar write capability.
 *
 * allowed            -> agent may create events directly
 * approval_required  -> agent may propose an event for approval
 * none               -> no calendar-writing tool is exposed
 *
 * BUG FIX: this previously only checked the configured permission
 * level, unlike resolveZoomCapability just below, which correctly
 * requires an actual connection before honoring the permission level
 * at all ("A Zoom permission by itself is not enough"). The same is
 * true here — a tenant could have calendar.write set to "allowed" in
 * Settings while never having connected Google Calendar at all (or
 * having granted Gmail but declined the Calendar scope specifically —
 * see calendar_scope_granted), and this function would still report
 * "write", so create_calendar_event/propose_calendar_event would be
 * offered to the model with no real Calendar access behind them —
 * exactly the kind of "tool offered but not actually usable" gap that
 * makes hallucinated-completion claims more likely and wastes a full
 * agent step when the underlying API call then fails.
 * tenantHasCalendarAccess() (lib/google/authClient.ts) already existed
 * for exactly this check but was never actually called anywhere in the
 * app — this wires it in, mirroring resolveZoomCapability's pattern.
 */
export async function resolveCalendarWriteCapability(
  tenantId: string
): Promise<"write" | "propose_only" | "none"> {
  const hasCalendarAccess = await tenantHasCalendarAccess(tenantId);

  if (!hasCalendarAccess) {
    return "none";
  }

  const writeLevel = await getPermissionLevel(
    tenantId,
    "calendar.write"
  );

  if (writeLevel === "allowed") {
    return "write";
  }

  if (writeLevel === "approval_required") {
    return "propose_only";
  }

  return "none";
}

/**
 * Resolve Zoom capability.
 *
 * IMPORTANT:
 * A Zoom permission by itself is not enough.
 *
 * The tenant must ALSO have an actual connected Zoom account
 * in zoom_connections.
 *
 * Therefore:
 *
 * no Zoom connection -> none
 * Zoom connection + permission allowed -> write
 * Zoom connection + approval required -> propose_only
 *
 * This prevents the model from ever being told it can create
 * Zoom meetings when the business has no connected Zoom account.
 *
 * NOTE: this previously read the permission key "calendar.zoom",
 * which nothing in the app ever wrote to — the settings UI writes
 * "zoom.meet". That meant getPermissionLevel always fell through to
 * its fail-closed default ("approval_required"), so this function
 * always returned "propose_only" no matter what was configured.
 * Fixed by reading the same key the settings page actually saves.
 */
export async function resolveZoomCapability(
  tenantId: string
): Promise<"write" | "propose_only" | "none"> {
  const supabase = createServiceSupabase();

  const { data: connection, error } = await supabase
    .from("zoom_connections")
    .select("id")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    console.error("ZOOM CONNECTION CHECK FAILED:", {
      tenantId,
      error,
    });

    // Fail closed.
    return "none";
  }

  if (!connection) {
    console.log("ZOOM NOT CONNECTED:", {
      tenantId,
    });

    return "none";
  }

  const permissionLevel =
    await getPermissionLevel(
      tenantId,
      "zoom.meet"
    );

  if (permissionLevel === "allowed") {
    return "write";
  }

  if (permissionLevel === "approval_required") {
    return "propose_only";
  }

  return "none";
}

/**
 * Calendar read access.
 *
 * Reading calendar information is not itself an approval-gated
 * action. Only calendar writes are.
 *
 * Same connection-check fix as resolveCalendarWriteCapability just
 * above, for the same reason: a configured permission level with no
 * actual Calendar connection behind it is not real access.
 */
export async function canReadCalendar(
  tenantId: string
): Promise<boolean> {
  const hasCalendarAccess = await tenantHasCalendarAccess(tenantId);

  if (!hasCalendarAccess) {
    return false;
  }

  const level = await getPermissionLevel(
    tenantId,
    "calendar.read"
  );

  return (
    level === "allowed" ||
    level === "approval_required"
  );
}

/**
 * Rule check.
 *
 * Scans the tenant's plain-language rules for anything that
 * should force approval regardless of the general permission
 * matrix.
 *
 * Example:
 *
 * "Refund requests always require approval."
 *
 * If the email receives the "refund" topic tag, the rule matches.
 */
export interface RuleCheckResult {
  requiresApproval: boolean;
  matchedRule?: string;
}

export function checkRulesForTopic(
  rules: { description: string }[],
  topicTags: string[]
): RuleCheckResult {
  const lowerTags =
    topicTags.map((tag) =>
      tag.toLowerCase()
    );

  for (const rule of rules) {
    const lowerRule =
      rule.description.toLowerCase();

    if (
      lowerTags.some((tag) =>
        lowerRule.includes(tag)
      )
    ) {
      return {
        requiresApproval: true,
        matchedRule:
          rule.description,
      };
    }
  }

  return {
    requiresApproval: false,
  };
}