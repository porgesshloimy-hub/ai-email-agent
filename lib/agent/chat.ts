import { createServiceSupabase } from "@/lib/supabase/server";
import { resolveCalendarWriteCapability, canReadCalendar } from "@/lib/agent/permissions";
import { recordUsage } from "@/lib/billing/meter";
import { calculateModelCost } from "@/lib/billing/pricing";
import {
  runChatCompletion,
  isProviderConfigured,
  getRequiredEnvVarName,
  type LlmMessage,
  type LlmToolDefinition,
  type LlmUsage,
} from "@/lib/agent/llm";
import {
  resolveModelSelection,
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_MODEL,
  type AIProvider,
} from "@/lib/agent/models";
import { getToolsForSurface, findToolForSurface } from "@/lib/agent/tools";
import type { ToolContext } from "@/lib/agent/tools";

/**
 * Handles a single message from the business owner via Google Chat. This is
 * a direct conversation with the owner (not a customer-facing email reply),
 * so it skips the draft/send machinery entirely — the owner IS the human in
 * the loop here. It can still answer questions, look things up, and take
 * calendar actions under the same permission rules as the email pipeline.
 *
 * Uses the same tenant-selected AI provider/model as the email pipeline
 * (lib/agent/run.ts) — see lib/agent/models.ts. One model selection per
 * tenant covers both surfaces, rather than a second independent setting.
 *
 * Returns the text to send back as the synchronous Chat response.
 */
export async function handleChatMessage(tenantId: string, messageText: string): Promise<string> {
  const supabase = createServiceSupabase();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("business_name, business_description")
    .eq("id", tenantId)
    .single();

  const { data: agentConfig } = await supabase
    .from("agent_configs")
    .select("custom_instructions, rules, ai_provider, ai_model")
    .eq("tenant_id", tenantId)
    .single();

  let { provider: aiProvider, model: aiModel } = resolveModelSelection(
    agentConfig?.ai_provider,
    agentConfig?.ai_model
  );

  /**
   * See lib/agent/run.ts's identical check for why this exists: a
   * saved selection can be a valid catalog entry while the provider's
   * API key is missing from this deployment's environment (removed,
   * or never added in the first place). Degrade to the default
   * provider rather than failing every Google Chat message outright.
   */
  if (!isProviderConfigured(aiProvider)) {
    console.error("AI PROVIDER NOT CONFIGURED, FALLING BACK TO DEFAULT:", {
      tenantId,
      attemptedProvider: aiProvider,
      attemptedModel: aiModel,
      missingEnvVar: getRequiredEnvVarName(aiProvider),
      fallbackProvider: DEFAULT_AI_PROVIDER,
      fallbackModel: DEFAULT_AI_MODEL,
    });

    aiProvider = DEFAULT_AI_PROVIDER;
    aiModel = DEFAULT_AI_MODEL;
  }

  const calendarReadAllowed = await canReadCalendar(tenantId);
  const calendarWriteCapability = await resolveCalendarWriteCapability(tenantId);


  // Pull a quick snapshot of recent activity so "what's pending" type
  // questions can be answered without extra tool round trips.
  const { data: pendingEmails, count: pendingEmailCount } = await supabase
    .from("email_actions")
    .select("*", { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("status", "pending_approval")
    .limit(5);

  const toolContext: ToolContext = {
    tenantId,
    supabase,

    permissions: {
      sendAllowed: false,
      calendarReadAllowed,
      calendarWriteCapability,
      zoomCapability: "none",
    },

    chat: {
      pendingEmails,
      pendingEmailCount,
    },
  };

  const tools: LlmToolDefinition[] = getToolsForSurface(
    "chat",
    toolContext
  ).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  const messages: LlmMessage[] = [
    {
      role: "system",
      content: [
        `You are the AI assistant for ${tenant?.business_name ?? "this business"}, talking directly with the ` +
          `business owner over Google Chat (not a customer). Be concise — this is a chat conversation, not email.`,
        tenant?.business_description ?? "",
        agentConfig?.custom_instructions ?? "",
        `There are currently ${pendingEmailCount ?? 0} email drafts awaiting the owner's review.`,
        calendarReadAllowed ? "You can discuss calendar availability if asked." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { role: "user", content: messageText },
  ];

  const result = await runChatCompletion(aiProvider, {
    model: aiModel,
    messages,
    tools,
  });

  await meterChatUsage(tenantId, aiProvider, aiModel, result.usage);

  const toolCall = result.toolCalls[0];

  if (!toolCall) {
    return result.content ?? "I'm not sure how to respond to that.";
  }

  const args = JSON.parse(toolCall.arguments || "{}");

  const toolDef = findToolForSurface(toolCall.name, "chat", toolContext);

  if (!toolDef) {
    return result.content ?? "Done.";
  }

  return await toolDef.execute(args, toolContext);
}

async function meterChatUsage(
  tenantId: string,
  aiProvider: AIProvider,
  aiModel: string,
  usage: LlmUsage | null
) {
  if (!usage) return;

  const rawCost = calculateModelCost(aiProvider, aiModel, usage.promptTokens, usage.completionTokens);

  await recordUsage({
    tenantId,
    service: aiProvider,
    description: `${aiModel} Google Chat conversation`,
    quantity: usage.totalTokens,
    unit: "tokens",
    rawCostUsd: rawCost,
  });
}
