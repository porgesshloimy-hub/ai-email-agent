/**
 * Shared types for the capability pre-router (Part 3 of the tool
 * refactor).
 *
 * The router sits between the existing permission resolution in
 * lib/agent/run.ts and the point where the tool list is handed to the
 * main LLM call. It NEVER decides what a tenant is allowed to do —
 * lib/agent/permissions.ts and each ToolDefinition's own isAvailable()
 * (see lib/agent/tools/types.ts) remain the only authority on that. All
 * this module does is narrow, for a single incoming email, which of the
 * already-permitted "domain" capabilities (calendar, zoom, future
 * connectors) are worth exposing to the model at all, so a routine
 * support email doesn't get handed a calendar+Zoom toolset it has no
 * use for.
 *
 * See lib/agent/router/index.ts's module comment for the full pipeline
 * and the specific invariant ("router only narrows, never grants").
 */

/**
 * Capability tag, matching the `capability` field already present on
 * every ToolDefinition (lib/agent/tools/types.ts). Intentionally a
 * plain `string` rather than a closed union — adding a new connector's
 * capability tag (e.g. "sms", "slack") must not require touching this
 * type. The constants below just centralize the tags this codebase
 * currently knows about so call sites don't hand-type string literals.
 */
export type CapabilityKey = string;

export const CAPABILITY = {
  GMAIL: "gmail",
  CALENDAR: "calendar",
  ZOOM: "zoom",
} as const;

/**
 * Capabilities that are never subject to routing — always exposed
 * whenever they're permission-available, regardless of what the
 * heuristics/classifier stages decide. create_draft/send_reply (the
 * "gmail" capability) are the core of the email pipeline: every run
 * needs the ability to at least draft or send a reply, and pruning that
 * would mean an email that "needs no reply" also can't be routed to a
 * human via create_draft.
 */
export const BASELINE_CAPABILITIES: CapabilityKey[] = [CAPABILITY.GMAIL];

export type HeuristicVerdict = "relevant" | "irrelevant" | "ambiguous";

export interface HeuristicResult {
  capability: CapabilityKey;
  verdict: HeuristicVerdict;
  /** Which keyword/phrase patterns fired, for debugging/tuning. Empty when verdict is "ambiguous" via no-rules-defined. */
  matched: string[];
  /** Short human-readable note, e.g. "no heuristic rules defined for this capability yet". */
  note?: string;
}

export type ClassifierSource = "classifier" | "classifier_fail_open";

export interface ClassifierResult {
  capability: CapabilityKey;
  relevant: boolean;
  source: ClassifierSource;
  /** Present only when source is "classifier_fail_open". */
  error?: string;
}

export interface RouterEmailInput {
  tenantId: string;
  subject: string;
  bodyText: string;
}

export interface SelectRelevantCapabilitiesInput extends RouterEmailInput {
  /**
   * The tenant's already-computed, permission-derived available
   * capability set (see deriveAvailableCapabilities in
   * lib/agent/router/index.ts). The router only ever narrows within
   * this set — it never adds a capability that isn't already in it.
   */
  availableCapabilities: CapabilityKey[];
}

export interface RouterReasoning {
  baseline: CapabilityKey[];
  availableCapabilities: CapabilityKey[];
  optionalCapabilities: CapabilityKey[];
  heuristics: HeuristicResult[];
  classifier: ClassifierResult[];
}

export interface SelectRelevantCapabilitiesResult {
  /** Final capability set to expose for this email: baseline ∪ routed-in optional capabilities, always a subset of availableCapabilities. */
  capabilities: CapabilityKey[];
  reasoning: RouterReasoning;
}
