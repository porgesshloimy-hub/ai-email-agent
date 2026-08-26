import type { ToolPermissions } from "@/lib/agent/tools/types";

import { runHeuristics } from "./heuristics";
import { classifyAmbiguousCapabilities } from "./classifier";
import {
  BASELINE_CAPABILITIES,
  CAPABILITY,
  type CapabilityKey,
  type SelectRelevantCapabilitiesResult,
} from "./types";

export * from "./types";

/**
 * Capability pre-router (Part 3 of the tool refactor).
 *
 * Pipeline for one incoming email:
 *
 *   permission-derived available capabilities (deriveAvailableCapabilities)
 *     -> split into baseline (never routed) + optional
 *     -> heuristics.ts (zero-cost keyword pass) on the optional set
 *     -> classifier.ts (one cheap LLM call) on whatever heuristics left "ambiguous"
 *     -> final set = baseline ∪ (heuristic "relevant") ∪ (classifier "relevant")
 *
 * HARD INVARIANT — read this before changing anything in this file:
 * the result of selectRelevantCapabilities() is ALWAYS a subset of the
 * `availableCapabilities` it was given. Nothing in this module (or
 * heuristics.ts/classifier.ts) may ever *add* a capability beyond what
 * was already permission-available — this file only removes entries
 * from that set, never appends new ones. The union at the bottom of
 * selectRelevantCapabilities() is explicitly re-intersected with
 * availableCapabilities to make that structurally true even if a future
 * edit here gets sloppy about it.
 *
 * lib/agent/permissions.ts's resolveSendCapability/
 * resolveCalendarWriteCapability/resolveZoomCapability/canReadCalendar
 * and each ToolDefinition's own isAvailable() remain the only authority
 * on what's *allowed*. This module is never called to answer that
 * question — only "given what's already allowed, what's worth showing
 * the model for this particular email".
 */
export async function selectRelevantCapabilities(input: {
  tenantId: string;
  subject: string;
  bodyText: string;
  availableCapabilities: CapabilityKey[];
}): Promise<SelectRelevantCapabilitiesResult> {
  const { subject, bodyText, availableCapabilities } = input;

  const baseline = BASELINE_CAPABILITIES.filter((capability) =>
    availableCapabilities.includes(capability)
  );

  const optionalCapabilities = availableCapabilities.filter(
    (capability) => !BASELINE_CAPABILITIES.includes(capability)
  );

  const heuristics = runHeuristics(optionalCapabilities, subject, bodyText);

  const relevantFromHeuristics = heuristics
    .filter((result) => result.verdict === "relevant")
    .map((result) => result.capability);

  const ambiguousCapabilities = heuristics
    .filter((result) => result.verdict === "ambiguous")
    .map((result) => result.capability);

  const classifier = await classifyAmbiguousCapabilities(
    ambiguousCapabilities,
    subject,
    bodyText
  );

  const relevantFromClassifier = classifier
    .filter((result) => result.relevant)
    .map((result) => result.capability);

  const routedIn = new Set<CapabilityKey>([
    ...baseline,
    ...relevantFromHeuristics,
    ...relevantFromClassifier,
  ]);

  // Re-intersect with availableCapabilities: see the HARD INVARIANT
  // comment above — this is the structural guarantee, not just the
  // logical one from how routedIn was built.
  const capabilities = availableCapabilities.filter((capability) =>
    routedIn.has(capability)
  );

  return {
    capabilities,
    reasoning: {
      baseline,
      availableCapabilities,
      optionalCapabilities,
      heuristics,
      classifier,
    },
  };
}

/**
 * ------------------------------------------------------------
 * Deriving the available capability set from resolved permissions
 * ------------------------------------------------------------
 *
 * This does NOT call lib/agent/permissions.ts itself — it consumes the
 * already-resolved ToolPermissions object lib/agent/run.ts builds from
 * those functions (leaving that permission-resolution block untouched,
 * per the refactor plan). The conditions below are exactly the same
 * conditions each ToolDefinition's own isAvailable() already checks
 * (see lib/agent/tools/*.ts) — this just aggregates them per capability
 * tag instead of per tool, so this is a read of the existing
 * isAvailable() conditions, not a second implementation of the
 * permission logic itself.
 *
 * gmail: create_draft's isAvailable() is unconditionally true, so
 * "gmail" is always available — which is also exactly why it's in
 * BASELINE_CAPABILITIES and never subject to routing regardless.
 */
export function deriveAvailableCapabilities(
  permissions: ToolPermissions
): CapabilityKey[] {
  const capabilities: CapabilityKey[] = [CAPABILITY.GMAIL];

  /**
   * "calendar" covers both the write tools (create/propose_calendar_event)
   * and the read-only check_calendar_availability tool. Previously this
   * only checked calendarWriteCapability, which meant a tenant with
   * calendar.read allowed but calendar.write denied/approval-only-without-write
   * would never even have "calendar" in the available set — so
   * check_calendar_availability (gated on calendarReadAllowed, not
   * calendarWriteCapability) could never be routed in for them even
   * though they're independently permitted to use it.
   */
  if (
    permissions.calendarWriteCapability !== "none" ||
    permissions.calendarReadAllowed
  ) {
    capabilities.push(CAPABILITY.CALENDAR);
  }

  if (permissions.zoomCapability !== "none") {
    capabilities.push(CAPABILITY.ZOOM);
  }

  return capabilities;
}

/**
 * ------------------------------------------------------------
 * Available-capability-set cache
 * ------------------------------------------------------------
 *
 * Small in-memory Map keyed by tenantId, TTL 60s, holding only the
 * *permission-derived available capability set* (deriveAvailableCapabilities'
 * output) — never the classifier's per-email output, which has a low
 * hit rate (different email content every time) and isn't worth
 * caching per the plan.
 *
 * DEPLOYMENT CAVEAT (read before relying on this for anything beyond a
 * micro-optimization): this repo's README documents production
 * deployment as Next.js on Vercel (see README.md's "Production
 * Deployment" section), which is a serverless/multi-instance model —
 * concurrent requests can land on different function instances, and any
 * instance can be recycled between invocations. A plain in-memory Map
 * like this one is per-process: it is NOT shared across instances, does
 * NOT survive a cold start, and provides no cross-request consistency
 * guarantee. On Vercel this cache will frequently miss (each cold
 * invocation starts empty) and, more importantly, must never be treated
 * as a source of truth — it is purely a best-effort micro-optimization
 * to skip re-deriving the same tenant's capability set within a warm
 * instance for ~60 seconds. If this app is ever deployed as a single
 * long-running process instead, this cache becomes fully effective
 * process-wide; either way, correctness never depends on a cache hit —
 * a miss just falls through to deriveAvailableCapabilities() again,
 * which is cheap, synchronous, and makes no network/DB call itself
 * (see its comment above — it only reads an already-resolved
 * ToolPermissions object).
 */
const AVAILABLE_CAPABILITIES_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  capabilities: CapabilityKey[];
  expiresAt: number;
}

const availableCapabilitiesCache = new Map<string, CacheEntry>();

/**
 * Cached wrapper around deriveAvailableCapabilities(). Same semantics
 * and same result as calling deriveAvailableCapabilities(permissions)
 * directly — this only exists to avoid recomputing it repeatedly for
 * the same tenant within the TTL window (e.g. a burst of emails
 * arriving in the same minute).
 */
export function getAvailableCapabilitiesCached(
  tenantId: string,
  permissions: ToolPermissions
): CapabilityKey[] {
  const now = Date.now();
  const cached = availableCapabilitiesCache.get(tenantId);

  if (cached && cached.expiresAt > now) {
    return cached.capabilities;
  }

  const capabilities = deriveAvailableCapabilities(permissions);

  availableCapabilitiesCache.set(tenantId, {
    capabilities,
    expiresAt: now + AVAILABLE_CAPABILITIES_CACHE_TTL_MS,
  });

  return capabilities;
}
