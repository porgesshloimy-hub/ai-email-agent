import { runChatCompletion, isProviderConfigured } from "@/lib/agent/llm";
import type { LlmToolDefinition } from "@/lib/agent/llm";
import { MODEL_CATALOG, DEFAULT_AI_MODEL } from "@/lib/agent/models";
import type { AIProvider } from "@/lib/agent/models";

/**
 * ------------------------------------------------------------
 * Grounding guard
 * ------------------------------------------------------------
 *
 * WHY THIS EXISTS (see the incident this was built for): the agent
 * wrote a customer email describing a Zoom meeting as created,
 * confirmed, and booked on the calendar, when none of that had
 * actually happened. A keyword check for "mentions zoom" (an earlier,
 * narrower version of this file) catches that one specific case, but
 * it does not scale: this project's own roadmap
 * (claude/connector-architecture-plan.md) already lists Drive,
 * Dropbox, and WhatsApp as future connectors, and every one of them
 * would need its own hand-written list of "what does a false
 * completion claim about this connector sound like" — that list-per-
 * connector approach gets worse, not better, as tools are added, which
 * is exactly backwards from what's needed here.
 *
 * This module checks something different: not "does the text contain
 * certain words", but "does the text claim a business action is done
 * that isn't backed by an actual tool result from this run". It is
 * handed two plain lists — which capabilities this tenant's account
 * actually has available at all (deriveAvailableCapabilities's output,
 * unrelated to what the router chose to expose for THIS email — this
 * check cares about the account's real capabilities, not the router's
 * cost-optimization narrowing), and which of those capabilities were
 * actually fulfilled with a real backend result during this specific
 * run (lib/agent/run.ts's completedCapabilities ledger, populated only
 * when a tool tagged `marksCapabilityCompleted` — see
 * lib/agent/tools/types.ts — actually succeeds) — and asks a small,
 * cheap model to compare the draft reply text against those two lists.
 * Adding a new connector later requires zero changes here: as long as
 * that connector's real-completion tool sets `marksCapabilityCompleted:
 * true` and its `capability` tag, this check automatically covers it.
 *
 * FAILS CLOSED. This is a safety gate, not a cost-optimization layer
 * like lib/agent/router/classifier.ts (which deliberately fails open,
 * since a missed cost-optimization is not a security problem). If this
 * check cannot run — missing API key, network error, malformed
 * response — the reply is treated as a violation and the calling tool
 * is not executed; see lib/agent/run.ts's handling, which reports the
 * failure back to the model as a normal "this action was not executed,
 * reassess" tool result rather than crashing the whole run.
 */

const GROUNDING_PROVIDER: AIProvider = "openai";

const cheapestOpenAiModel = MODEL_CATALOG.openai.models.find(
  (model) => model.tier === "Cheapest"
);

const GROUNDING_MODEL: string = cheapestOpenAiModel?.id ?? DEFAULT_AI_MODEL;

const REPORT_TOOL_NAME = "report_grounding_violations";

interface GroundingViolation {
  capability: string;
  claim: string;
}

export interface GroundingCheckResult {
  ok: boolean;
  violations: GroundingViolation[];
  source: "classifier" | "classifier_fail_closed" | "skipped";
  error?: string;
}

function buildReportTool(): LlmToolDefinition {
  return {
    name: REPORT_TOOL_NAME,
    description:
      "Report any sentences in the reply that falsely claim a business action was already completed.",
    parameters: {
      type: "object",
      properties: {
        violations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              capability: {
                type: "string",
                description:
                  "Which capability the false claim relates to (e.g. calendar, zoom) — use one of the listed capability names if it matches one, otherwise \"other\".",
              },
              claim: {
                type: "string",
                description:
                  "The specific sentence or phrase in the reply making the unsupported claim.",
              },
            },
            required: ["capability", "claim"],
          },
        },
      },
      required: ["violations"],
    },
  };
}

/**
 * Compare a draft customer-facing reply against what this run actually
 * did, using a single cheap structured-output LLM call.
 *
 * `availableCapabilities` — this account's real, permission-derived
 * capability set (e.g. from lib/agent/router's deriveAvailableCapabilities),
 * independent of what the router chose to route in for this email.
 *
 * `completedCapabilities` — capabilities actually fulfilled with a real
 * tool result during this run (lib/agent/run.ts's ledger).
 */
export async function checkReplyIsGrounded(input: {
  replyText: string;
  availableCapabilities: string[];
  completedCapabilities: string[];
}): Promise<GroundingCheckResult> {
  const { replyText, availableCapabilities, completedCapabilities } = input;

  if (!replyText.trim()) {
    return { ok: true, violations: [], source: "skipped" };
  }

  /**
   * "gmail" (create_draft/send_reply) is always available and is the
   * thing actually being executed right now — it isn't a connector
   * that can be falsely claimed as "done" independent of itself. If
   * nothing beyond that baseline is available for this account at all,
   * there is no connector-backed claim to fabricate, so skip the extra
   * LLM call entirely rather than spending it on every routine support
   * reply.
   */
  const connectorCapabilities = availableCapabilities.filter(
    (capability) => capability !== "gmail"
  );

  if (connectorCapabilities.length === 0) {
    return { ok: true, violations: [], source: "skipped" };
  }

  const failClosed = (error: string): GroundingCheckResult => {
    console.error("AGENT GROUNDING CHECK FAILED — FAILING CLOSED:", {
      availableCapabilities,
      completedCapabilities,
      error,
    });

    return {
      ok: false,
      violations: [
        {
          capability: "unknown",
          claim: "The grounding check could not be completed for this reply.",
        },
      ],
      source: "classifier_fail_closed",
      error,
    };
  };

  if (!isProviderConfigured(GROUNDING_PROVIDER)) {
    return failClosed(
      `Grounding check provider "${GROUNDING_PROVIDER}" is not configured in this environment`
    );
  }

  try {
    const tool = buildReportTool();

    const result = await runChatCompletion(GROUNDING_PROVIDER, {
      model: GROUNDING_MODEL,

      messages: [
        {
          role: "system",
          content: [
            "You are a fact-checking pass on an email agent's outgoing customer reply, run just before it is sent.",
            "You are given: (1) which capabilities this business account has available at all, (2) which of those capabilities were ACTUALLY fulfilled with a real backend result during this run, and (3) the draft reply text about to be sent.",
            "A capability being merely 'available' is not enough to justify a completion claim — only capabilities listed as actually fulfilled may be described in the reply as already done.",
            "Find any sentence that describes a business action as already done, confirmed, booked, created, scheduled, sent, or arranged, where that action depends on a capability that is not listed as fulfilled. This includes claims that don't name the capability outright but clearly describe its effect (e.g. 'you're all set for the call' when no meeting was actually created; 'this is on your calendar now' when no calendar event was actually created).",
            "Do not flag ordinary conversational language, plans, offers to help, or descriptions of what the business generally does. Only flag claims that assert a specific action already happened in this exchange.",
            "You MUST report your answer using the report_grounding_violations tool. Report an empty violations array if nothing is wrong.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Capabilities available on this account: ${
              availableCapabilities.join(", ") || "none"
            }`,
            `Capabilities actually fulfilled with a real result during this run: ${
              completedCapabilities.join(", ") || "none"
            }`,
            `Draft reply text:\n${replyText}`,
          ].join("\n\n"),
        },
      ],

      tools: [tool],
    });

    const call = result.toolCalls.find(
      (toolCall) => toolCall.name === REPORT_TOOL_NAME
    );

    if (!call) {
      return failClosed(
        "Grounding check model did not call report_grounding_violations"
      );
    }

    let parsed: { violations?: unknown };

    try {
      parsed = JSON.parse(call.arguments || "{}");
    } catch (parseError) {
      return failClosed(
        `Grounding check returned invalid JSON: ${
          parseError instanceof Error ? parseError.message : String(parseError)
        }`
      );
    }

    const violations: GroundingViolation[] = Array.isArray(parsed.violations)
      ? parsed.violations.filter(
          (value): value is GroundingViolation =>
            !!value &&
            typeof value === "object" &&
            typeof (value as any).claim === "string"
        )
      : [];

    return {
      ok: violations.length === 0,
      violations,
      source: "classifier",
    };
  } catch (error) {
    return failClosed(error instanceof Error ? error.message : String(error));
  }
}
