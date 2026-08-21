import { CAPABILITY, type CapabilityKey, type HeuristicResult } from "./types";

/**
 * Deterministic, zero-LLM-cost intent signals.
 *
 * INTENTIONALLY SIMPLE. This is a flat list of keyword/phrase patterns
 * per capability, not an NLP model — it exists to resolve the common
 * cases ("clearly about scheduling a call", "clearly a routine product
 * question with zero scheduling intent") without spending a classifier
 * call on every single email. Expect to tune these lists over time as
 * false positives/negatives show up in the router's console logs
 * (search for "AGENT CAPABILITY ROUTER DECISION" in run.ts). Anything
 * these patterns can't confidently call is deliberately left
 * "ambiguous" for lib/agent/router/classifier.ts to resolve instead of
 * guessing here.
 *
 * Each capability has two pattern lists:
 *  - `relevant`: strong positive signal this email needs the
 *    capability's tools.
 *  - `irrelevant`: strong signal this is a routine, unrelated support
 *    topic — used only to positively resolve the common "no scheduling
 *    intent at all" case to "irrelevant" instead of leaving it
 *    "ambiguous" (which would otherwise send nearly every email to the
 *    classifier and defeat the point of this pre-router).
 *
 * A capability with no entry in this table (a future connector whose
 * keywords haven't been written yet) always comes back "ambiguous" —
 * see the fallback at the bottom of this file — so a missing ruleset
 * fails toward "ask the classifier", never toward silently excluding a
 * permitted capability.
 */
const HEURISTIC_PATTERNS: Partial<
  Record<CapabilityKey, { relevant: RegExp[]; irrelevant: RegExp[] }>
> = {
  [CAPABILITY.CALENDAR]: {
    relevant: [
      /\bmeet(?:ing)?s?\b/i,
      /\bcall\b/i,
      /\bschedul(?:e|ing|ed)\b/i,
      /\bresched(?:ule|uling|uled)\b/i,
      /\bappointment\b/i,
      /\bcalendar\b/i,
      /\bavailab(?:le|ility)\b/i,
      /\b(?:free|open) (?:time|slot)s?\b/i,
      /\btime slot\b/i,
      /\binvite\b/i,
      /\bbook(?:ing)?\b/i,
      /\bconsult(?:ation)?\b/i,
      /\bdemo\b/i,
      /\bwalkthrough\b/i,
      /\bcatch up\b/i,
      /\bcheck-?in\b/i,
      /\bsync up\b/i,
      /\bwhen (?:are|is) you (?:free|available)\b/i,
      /\bwhat time works\b/i,
    ],
    irrelevant: [
      /\brefund\b/i,
      /\breturn\b/i,
      /\bshipping\b/i,
      /\btracking\b/i,
      /\border\b/i,
      /\binvoice\b/i,
      /\breceipt\b/i,
      /\bprice\b/i,
      /\bpricing\b/i,
      /\bdiscount\b/i,
      /\bcoupon\b/i,
      /\bcomplaint\b/i,
      /\bwarranty\b/i,
      /\bsubscription\b/i,
      /\bcancel(?:lation)? my (?:order|subscription|account)\b/i,
      /\bpassword\b/i,
      /\blogin\b/i,
      /\baccount access\b/i,
      /\bbug\b/i,
      /\bissue with\b/i,
      /\bnot working\b/i,
      /\bunsubscribe\b/i,
    ],
  },

  [CAPABILITY.ZOOM]: {
    relevant: [
      /\bzoom\b/i,
      /\bvideo call\b/i,
      /\bvideo conference\b/i,
      /\bjoin link\b/i,
      /\bmeeting link\b/i,
      /\bvirtual meeting\b/i,
      /\bgoogle meet\b/i,
      /\bteams meeting\b/i,
      /\bconference call\b/i,
      /\bscreen share\b/i,
      /\bdial[- ]?in\b/i,
    ],
    irrelevant: [
      /\brefund\b/i,
      /\breturn\b/i,
      /\bshipping\b/i,
      /\btracking\b/i,
      /\border\b/i,
      /\binvoice\b/i,
      /\breceipt\b/i,
      /\bprice\b/i,
      /\bpricing\b/i,
      /\bdiscount\b/i,
      /\bcoupon\b/i,
      /\bcomplaint\b/i,
      /\bwarranty\b/i,
      /\bsubscription\b/i,
      /\bpassword\b/i,
      /\blogin\b/i,
      /\baccount access\b/i,
      /\bbug\b/i,
      /\bissue with\b/i,
      /\bnot working\b/i,
      /\bunsubscribe\b/i,
    ],
  },
};

/**
 * Run the heuristic pass for each of the given capabilities against one
 * email's subject + body. Only ever called with the tenant's already
 * permission-available *optional* capabilities (baseline capabilities
 * like "gmail" never go through this — see BASELINE_CAPABILITIES in
 * lib/agent/router/types.ts).
 */
export function runHeuristics(
  capabilities: CapabilityKey[],
  subject: string,
  bodyText: string
): HeuristicResult[] {
  const text = `${subject}\n${bodyText}`;

  return capabilities.map((capability) => {
    const patterns = HEURISTIC_PATTERNS[capability];

    if (!patterns) {
      return {
        capability,
        verdict: "ambiguous",
        matched: [],
        note: "no heuristic rules defined for this capability yet — deferring to the classifier",
      };
    }

    const matchedRelevant = patterns.relevant
      .filter((pattern) => pattern.test(text))
      .map((pattern) => pattern.source);

    if (matchedRelevant.length > 0) {
      return {
        capability,
        verdict: "relevant",
        matched: matchedRelevant,
      };
    }

    const matchedIrrelevant = patterns.irrelevant
      .filter((pattern) => pattern.test(text))
      .map((pattern) => pattern.source);

    if (matchedIrrelevant.length > 0) {
      return {
        capability,
        verdict: "irrelevant",
        matched: matchedIrrelevant,
      };
    }

    return {
      capability,
      verdict: "ambiguous",
      matched: [],
      note: "no keyword pattern matched either way",
    };
  });
}
