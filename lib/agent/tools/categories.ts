/**
 * ------------------------------------------------------------
 * Tool categories ("alternatives")
 * ------------------------------------------------------------
 *
 * Some things the agent can offer a customer have more than one way to
 * actually be fulfilled. A video meeting link can come from a real Zoom
 * meeting OR from a Google Calendar event with a Meet conference
 * attached — different tools/code paths, same thing from the
 * customer's point of view. As more connectors get added (see
 * claude/connector-architecture-plan.md's Drive/Dropbox plans), this
 * will keep happening: multiple providers for the same functional
 * category, only some of which may be connected for a given tenant.
 *
 * Built in response to a real incident: a customer asked for a Zoom
 * meeting on an account with no Zoom connection. The agent correctly
 * refused to fabricate a Zoom meeting, but had no framework for
 * offering the alternative it actually had (Google Meet) — it just
 * created a plain calendar event referencing "Zoom" with no real video
 * link at all. The fix isn't just "don't do the thing you can't do,"
 * it's "know what you CAN do instead, and know which one this business
 * prefers when the customer didn't specify."
 *
 * This module is the data-driven core of that: a small static registry
 * of categories and their possible providers, plus a runtime function
 * that resolves — for a specific tenant, right now — which providers
 * are actually available, and which one is preferred.
 */

export type ToolCategoryId = "video_meeting";

export interface ToolCategoryProvider {
  /** Stable id, also the value stored in agent_configs.tool_preferences. */
  id: string;
  /** Human-readable name, used in the Agent settings UI. */
  label: string;
  /**
   * Which capability tag (see lib/agent/tools/types.ts's ToolDefinition)
   * gates this provider's availability. Resolution below checks the
   * tenant's actual, connection-checked permissions for this capability
   * (lib/agent/permissions.ts) — never just "is this provider known
   * about," always "is it really usable right now."
   */
  capability: string;
  /**
   * A short instruction fragment describing how the model actually
   * requests this provider, injected into the system prompt so the
   * model doesn't have to guess which tool/parameter to use.
   */
  howToUse: string;
}

export interface ToolCategoryDefinition {
  id: ToolCategoryId;
  /** Human-readable name, used in the Agent settings UI and prompts. */
  label: string;
  /**
   * What the customer is actually asking for, described generically —
   * used in the system prompt so the framing isn't tied to any one
   * provider's name.
   */
  customerFacingDescription: string;
  providers: ToolCategoryProvider[];
  /**
   * Provider id to fall back to when more than one provider is
   * available and the tenant hasn't set an explicit preference. Should
   * be whichever option needs the least extra setup/config to work
   * well by default.
   */
  defaultProvider: string;
}

export const TOOL_CATEGORIES: ToolCategoryDefinition[] = [
  {
    id: "video_meeting",
    label: "Video meeting link",
    customerFacingDescription:
      "a video call / video meeting link for a scheduled meeting",
    providers: [
      {
        id: "zoom",
        label: "Zoom",
        capability: "zoom",
        howToUse:
          "create_zoom_meeting or propose_zoom_meeting produces a real Zoom join link.",
      },
      {
        id: "google_meet",
        label: "Google Meet",
        capability: "calendar",
        howToUse:
          "create_calendar_event / propose_calendar_event with requestGoogleMeet set to true attaches a real Google Meet link to the calendar event.",
      },
    ],
    defaultProvider: "google_meet",
  },
];

export function getToolCategory(
  id: ToolCategoryId
): ToolCategoryDefinition | undefined {
  return TOOL_CATEGORIES.find((category) => category.id === id);
}

/**
 * Minimal shape this module needs out of the tenant's real permission
 * state — kept as a plain capability -> available boolean map so this
 * file doesn't need to import lib/agent/permissions.ts's full
 * ToolPermissions type (which has surface-specific shape differences
 * between run.ts and chat.ts) and stays trivially testable.
 */
export type CapabilityAvailability = Record<string, boolean>;

export interface ResolvedCategory {
  category: ToolCategoryDefinition;
  /** Providers actually usable right now for this tenant, in a stable order. */
  available: ToolCategoryProvider[];
  /**
   * The provider to use when the customer didn't specify one:
   * the tenant's saved preference if it's actually available, else
   * the category's documented default if THAT's available, else
   * whichever available provider comes first, else null if nothing
   * in the category is available at all.
   */
  effectiveDefault: ToolCategoryProvider | null;
}

/**
 * Resolve one category against a tenant's real capability availability
 * and saved preference. Pure function — no I/O — so callers (run.ts,
 * chat.ts) fetch the tenant's tool_preferences and capability state
 * once and pass them in, rather than this module reaching into the
 * database itself.
 */
export function resolveCategory(
  categoryId: ToolCategoryId,
  capabilityAvailability: CapabilityAvailability,
  preferences: Record<string, string> | null | undefined
): ResolvedCategory | null {
  const category = getToolCategory(categoryId);
  if (!category) return null;

  const available = category.providers.filter(
    (provider) => capabilityAvailability[provider.capability] === true
  );

  const preferredId = preferences?.[categoryId];

  const preferredProvider =
    preferredId != null
      ? available.find((provider) => provider.id === preferredId)
      : undefined;

  const defaultProvider = available.find(
    (provider) => provider.id === category.defaultProvider
  );

  const effectiveDefault =
    preferredProvider ?? defaultProvider ?? available[0] ?? null;

  return { category, available, effectiveDefault };
}

/**
 * Render a resolved category as a system-prompt block. Deliberately
 * explicit and deterministic — the model is told exactly what's
 * available and what to default to, rather than left to infer either
 * from which tools happen to be present (see lib/agent/date-context.ts
 * and the Permission Engine section of the README for the same
 * "explicit ground truth beats inference" principle applied to
 * timezones and Zoom/Calendar connection status).
 */
export function describeResolvedCategory(resolved: ResolvedCategory): string {
  const { category, available, effectiveDefault } = resolved;

  if (available.length === 0) {
    const allNames = category.providers.map((p) => p.label).join(" or ");
    return (
      `For ${category.customerFacingDescription}: none of this business's options (${allNames}) ` +
      "are currently connected. Do not offer, promise, or reference any of them. If a video meeting " +
      "is requested, say so honestly and, if appropriate, ask the customer for their availability so " +
      "the business owner can follow up directly."
    );
  }

  if (available.length === 1) {
    const only = available[0];
    return (
      `For ${category.customerFacingDescription}: ${only.label} is the only connected option (${only.howToUse}). ` +
      `Use it whenever a video meeting is wanted, unless the customer specifically asks for a different platform this business doesn't have — ` +
      `in that case, explain honestly that platform isn't set up and offer ${only.label} instead of creating a meeting with no real link.`
    );
  }

  const optionLines = available
    .map((provider) => `  - ${provider.label}: ${provider.howToUse}`)
    .join("\n");

  const defaultLine = effectiveDefault
    ? `When the customer doesn't specify a platform, use ${effectiveDefault.label} by default.`
    : "";

  return [
    `For ${category.customerFacingDescription}, more than one option is connected:`,
    optionLines,
    "If the customer states or clearly implies a preference, honor it.",
    defaultLine,
  ]
    .filter(Boolean)
    .join("\n");
}
