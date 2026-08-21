import { runChatCompletion } from "@/lib/agent/llm";
import type { LlmToolDefinition } from "@/lib/agent/llm";
import { MODEL_CATALOG, DEFAULT_AI_MODEL } from "@/lib/agent/models";
import type { AIProvider } from "@/lib/agent/models";
import { isProviderConfigured } from "@/lib/agent/llm";

import type { CapabilityKey, ClassifierResult } from "./types";

/**
 * Model used for the router's classifier call.
 *
 * Deliberately independent of the tenant's own selected chat model
 * (agent_configs.ai_provider/ai_model, resolved in lib/agent/run.ts) —
 * the whole point of this call is that it must stay cheap regardless of
 * which model a tenant picked for the main agent loop. lib/agent/models.ts
 * already flags one catalog entry per provider with tier "Cheapest";
 * this picks that OpenAI entry (gpt-5-nano at the time of writing) since
 * the OpenAI adapter is the simplest/cheapest of the three to reach for
 * a single small structured-output call. Falls back to the global
 * catalog default if the catalog ever stops flagging a "Cheapest" tier.
 */
const cheapestOpenAiModel = MODEL_CATALOG.openai.models.find(
  (model) => model.tier === "Cheapest"
);

const CLASSIFIER_PROVIDER: AIProvider = "openai";
const CLASSIFIER_MODEL: string = cheapestOpenAiModel?.id ?? DEFAULT_AI_MODEL;

/**
 * Single structured-output-style tool the classifier is forced to
 * "call" to report its answer. lib/agent/llm/'s shared LlmCompletionRequest
 * shape has no separate JSON-mode primitive across all three providers,
 * but tool-calling is supported uniformly by every adapter (see
 * lib/agent/llm/{openai,anthropic,mistral}.ts) — this reuses that
 * exact mechanism rather than inventing a new provider integration.
 */
const CLASSIFY_TOOL_NAME = "classify_capabilities";

function buildClassifyTool(
  ambiguousCapabilities: CapabilityKey[]
): LlmToolDefinition {
  return {
    name: CLASSIFY_TOOL_NAME,
    description:
      "Report which of the listed capabilities this email actually needs.",
    parameters: {
      type: "object",
      properties: {
        relevantCapabilities: {
          type: "array",
          items: {
            type: "string",
            enum: ambiguousCapabilities,
          },
          description:
            "Subset of the candidate capabilities that this email genuinely requires to be handled well. Empty array if none of them are needed.",
        },
      },
      required: ["relevantCapabilities"],
    },
  };
}

/**
 * Classify the capabilities lib/agent/router/heuristics.ts left
 * "ambiguous" for one email, via a single cheap structured-output LLM
 * call.
 *
 * FAILS OPEN: this is purely a cost-optimization layer sitting in front
 * of tools the tenant is already permitted to use. If the call fails
 * for any reason (missing API key, network error, malformed response,
 * provider error) every ambiguous capability is treated as relevant
 * rather than dropped — a classifier outage must never cause the agent
 * to silently lose a capability it's otherwise authorized to use. Every
 * failure is logged loudly (console.error) so this is visible in
 * production rather than a silent, permanent "always ambiguous" no-op.
 */
export async function classifyAmbiguousCapabilities(
  ambiguousCapabilities: CapabilityKey[],
  subject: string,
  bodyText: string
): Promise<ClassifierResult[]> {
  if (ambiguousCapabilities.length === 0) {
    return [];
  }

  const failOpen = (error: string): ClassifierResult[] => {
    console.error("AGENT CAPABILITY CLASSIFIER FAILED — FAILING OPEN:", {
      ambiguousCapabilities,
      classifierProvider: CLASSIFIER_PROVIDER,
      classifierModel: CLASSIFIER_MODEL,
      error,
    });

    return ambiguousCapabilities.map((capability) => ({
      capability,
      relevant: true,
      source: "classifier_fail_open",
      error,
    }));
  };

  if (!isProviderConfigured(CLASSIFIER_PROVIDER)) {
    return failOpen(
      `Classifier provider "${CLASSIFIER_PROVIDER}" is not configured in this environment`
    );
  }

  try {
    const tool = buildClassifyTool(ambiguousCapabilities);

    const result = await runChatCompletion(CLASSIFIER_PROVIDER, {
      model: CLASSIFIER_MODEL,

      messages: [
        {
          role: "system",
          content: [
            "You are a fast pre-filter for an email agent's tool router.",
            "You are given the subject and body of one incoming business email and a short list of candidate capabilities.",
            "Decide which of those candidate capabilities, if any, this email genuinely requires in order for the agent to handle it well — for example, whether it actually needs to schedule/reschedule a meeting or create a video call link.",
            "Do not guess generously — only include a capability if the email content genuinely calls for it. You MUST report your answer using the classify_capabilities tool.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Candidate capabilities: ${ambiguousCapabilities.join(", ")}`,
            `Subject: ${subject}`,
            `Body: ${bodyText}`,
          ].join("\n\n"),
        },
      ],

      tools: [tool],
    });

    const call = result.toolCalls.find(
      (toolCall) => toolCall.name === CLASSIFY_TOOL_NAME
    );

    if (!call) {
      return failOpen(
        "Classifier model did not call classify_capabilities"
      );
    }

    let parsed: { relevantCapabilities?: unknown };

    try {
      parsed = JSON.parse(call.arguments || "{}");
    } catch (parseError) {
      return failOpen(
        `Classifier returned invalid JSON: ${
          parseError instanceof Error ? parseError.message : String(parseError)
        }`
      );
    }

    if (!Array.isArray(parsed.relevantCapabilities)) {
      return failOpen(
        "Classifier response missing a relevantCapabilities array"
      );
    }

    const relevantSet = new Set(
      parsed.relevantCapabilities.filter(
        (value): value is string => typeof value === "string"
      )
    );

    return ambiguousCapabilities.map((capability) => ({
      capability,
      relevant: relevantSet.has(capability),
      source: "classifier",
    }));
  } catch (error) {
    return failOpen(error instanceof Error ? error.message : String(error));
  }
}
