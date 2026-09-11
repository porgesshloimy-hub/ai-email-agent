import { createServiceSupabase } from "@/lib/supabase/server";
import { runChatCompletion, isProviderConfigured } from "@/lib/agent/llm";
import type { LlmToolDefinition } from "@/lib/agent/llm";
import { MODEL_CATALOG, DEFAULT_AI_MODEL } from "@/lib/agent/models";
import type { AIProvider } from "@/lib/agent/models";

/**
 * Phase 3.3 — detects whether an owner's reply acknowledges a reminder
 * that was already delivered (status: 'awaiting_ack'). Heuristic
 * fixed-phrase match first (free); a cheap-model fallback only for
 * replies that don't match any fixed phrase.
 *
 * DELIBERATELY FAILS CLOSED, unlike lib/agent/router/classifier.ts and
 * lib/agent/memory/extractor.ts (both fail OPEN on error). Those two are
 * cost/convenience layers where failing open just means "don't skip
 * something you're otherwise allowed to do." Here, a false positive
 * deletes a reminder the owner never actually acknowledged — a real,
 * irreversible loss — so any failure (missing key, bad response, network
 * error) resolves to "not acknowledged" rather than "acknowledged."
 *
 * Disambiguation: if more than one reminder is currently awaiting_ack
 * for this tenant, this deliberately does NOT guess which one a plain
 * "thanks" refers to — it returns unacknowledged for all of them rather
 * than resolving the wrong one. (The original plan's fuller design
 * — "requiring the delivery message itself to name the specific item"
 * — needs the dispatcher to compose reminder-specific delivery text the
 * ack step can then match back against; this v1 dispatcher doesn't do
 * that yet, so multiple simultaneous awaiting_ack reminders is a known,
 * accepted gap for now rather than a silently wrong resolution.)
 */

const ACK_PHRASES = [
  "thanks",
  "thank you",
  "thanks!",
  "thank you!",
  "ok",
  "okay",
  "ok!",
  "okay!",
  "got it",
  "got it!",
  "noted",
  "noted!",
  "sounds good",
  "perfect",
  "great",
  "great!",
  "👍",
  "🙏",
  "cool",
  "cool!",
  "will do",
  "on it",
];

function heuristicAcknowledgment(replyText: string): boolean {
  const normalized = replyText.trim().toLowerCase().replace(/[.!,]+$/g, "");
  return ACK_PHRASES.some((phrase) => normalized === phrase.replace(/[.!,]+$/g, ""));
}

const CHEAP_PROVIDER: AIProvider = "openai";
const cheapestOpenAiModel = MODEL_CATALOG.openai.models.find(
  (model) => model.tier === "Cheapest"
);
const CHEAP_MODEL: string = cheapestOpenAiModel?.id ?? DEFAULT_AI_MODEL;

const ACK_TOOL_NAME = "report_acknowledgment";

function buildAckTool(): LlmToolDefinition {
  return {
    name: ACK_TOOL_NAME,
    description: "Report whether this message acknowledges having seen/received something (as opposed to asking a new question or giving a new instruction).",
    parameters: {
      type: "object",
      properties: {
        acknowledged: {
          type: "boolean",
          description: "True only if the message is purely an acknowledgment (thanks, ok, got it, etc.) with no new question, instruction, or request in it.",
        },
      },
      required: ["acknowledged"],
    },
  };
}

async function classifyAcknowledgment(replyText: string): Promise<boolean> {
  if (!isProviderConfigured(CHEAP_PROVIDER)) {
    console.error("ACK DETECTION: classifier provider not configured, failing closed");
    return false;
  }

  try {
    const result = await runChatCompletion(CHEAP_PROVIDER, {
      model: CHEAP_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a fast classifier. You MUST report your answer using the report_acknowledgment tool.",
        },
        {
          role: "user",
          content: `Message: "${replyText}"`,
        },
      ],
      tools: [buildAckTool()],
    });

    const call = result.toolCalls.find((toolCall) => toolCall.name === ACK_TOOL_NAME);

    if (!call) return false;

    const parsed = JSON.parse(call.arguments || "{}");
    return parsed.acknowledged === true;
  } catch (error) {
    console.error("ACK DETECTION: classifier failed, failing closed:", error);
    return false;
  }
}

export interface AwaitingAckReminder {
  id: string;
  content: string;
  related_customer_email: string | null;
}

/**
 * Checks this tenant's awaiting_ack reminders against a reply and, if
 * exactly one exists and the reply acknowledges it, marks it done and
 * deletes it — matching the plan's "delivered -> ack'd = deleted"
 * lifecycle. Returns the reminder that was resolved, if any, so the
 * caller can compose a natural confirmation ("Got it — cleared that
 * reminder.").
 */
export async function checkAndResolveAcknowledgment(
  tenantId: string,
  replyText: string
): Promise<AwaitingAckReminder | null> {
  const supabase = createServiceSupabase();

  const { data: awaiting, error } = await supabase
    .from("agent_reminders")
    .select("id, content, related_customer_email")
    .eq("tenant_id", tenantId)
    .eq("status", "awaiting_ack");

  if (error) {
    console.error("ACK DETECTION: lookup failed:", error);
    return null;
  }

  if (!awaiting || awaiting.length !== 1) {
    // Zero: nothing to acknowledge. More than one: deliberately not
    // guessing — see module comment.
    return null;
  }

  const reminder = awaiting[0];

  const acknowledged =
    heuristicAcknowledgment(replyText) || (await classifyAcknowledgment(replyText));

  if (!acknowledged) {
    return null;
  }

  const { error: deleteError } = await supabase
    .from("agent_reminders")
    .delete()
    .eq("id", reminder.id)
    .eq("status", "awaiting_ack"); // guard against a race with the passive-queue fallback

  if (deleteError) {
    console.error("ACK DETECTION: failed to clear acknowledged reminder:", deleteError);
    return null;
  }

  return reminder;
}
