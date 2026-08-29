import type { AgentPersona } from "@/lib/agent/personas/types";

/**
 * ------------------------------------------------------------
 * Persona permission-override narrowing
 * ------------------------------------------------------------
 *
 * A persona's permission_overrides can only make a capability MORE
 * restrictive than what the tenant's real, connection-checked resolvers
 * (lib/agent/permissions.ts) already returned — never less. A persona
 * override of "allowed" never grants access the tenant doesn't actually
 * have; it just means "don't narrow this one."
 *
 * Each capability has its own tier ordering, since the concrete return
 * types differ (resolveSendCapability returns "send"|"draft_only"|"none",
 * resolveCalendarWriteCapability/resolveZoomCapability return
 * "write"|"propose_only"|"none", canReadCalendar returns a plain
 * boolean). These helpers translate the persona's generic
 * "denied"|"approval_required"|"allowed" override into whichever
 * capability-specific tier that maps to, and take the more restrictive
 * of the two — the real resolver's result, and the override.
 */

type SendTier = "send" | "draft_only" | "none";
type WriteTier = "write" | "propose_only" | "none";

const SEND_RANK: Record<SendTier, number> = {
  send: 2,
  draft_only: 1,
  none: 0,
};

const WRITE_RANK: Record<WriteTier, number> = {
  write: 2,
  propose_only: 1,
  none: 0,
};

function overrideToSendTier(
  override: "denied" | "approval_required" | "allowed" | undefined
): SendTier | null {
  switch (override) {
    case "denied":
      return "none";
    case "approval_required":
      return "draft_only";
    case "allowed":
      return null; // no narrowing — defer entirely to the real resolved tier
    default:
      return null;
  }
}

function overrideToWriteTier(
  override: "denied" | "approval_required" | "allowed" | undefined
): WriteTier | null {
  switch (override) {
    case "denied":
      return "none";
    case "approval_required":
      return "propose_only";
    case "allowed":
      return null;
    default:
      return null;
  }
}

/**
 * Narrows a "send"|"draft_only"|"none" capability using the persona's
 * "gmail.send" override, if present. Returns whichever tier is MORE
 * restrictive between the real resolved value and the override.
 */
export function narrowSendCapability(
  resolved: SendTier,
  persona: AgentPersona
): SendTier {
  const overrideTier = overrideToSendTier(persona.permissionOverrides["gmail.send"]);
  if (overrideTier === null) return resolved;
  return SEND_RANK[overrideTier] < SEND_RANK[resolved] ? overrideTier : resolved;
}

/**
 * Narrows a "write"|"propose_only"|"none" capability (calendar.write or
 * zoom.meet) using the given override key.
 */
export function narrowWriteCapability(
  resolved: WriteTier,
  persona: AgentPersona,
  overrideKey: "calendar.write" | "zoom.meet"
): WriteTier {
  const overrideTier = overrideToWriteTier(persona.permissionOverrides[overrideKey]);
  if (overrideTier === null) return resolved;
  return WRITE_RANK[overrideTier] < WRITE_RANK[resolved] ? overrideTier : resolved;
}

/**
 * Narrows a boolean read-capability (calendar.read) using the persona's
 * override. "denied" forces false; "approval_required" has no meaningful
 * distinct tier for a read-only capability, so it's treated the same as
 * "denied" here — reading isn't something that's sensibly "proposed."
 */
export function narrowReadCapability(
  resolved: boolean,
  persona: AgentPersona,
  overrideKey: string
): boolean {
  const override = persona.permissionOverrides[overrideKey];
  if (override === "denied" || override === "approval_required") return false;
  return resolved;
}
