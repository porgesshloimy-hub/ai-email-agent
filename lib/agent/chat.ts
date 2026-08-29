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
import { buildCurrentDateContext } from "@/lib/agent/date-context";
import { resolveCategory, describeResolvedCategory } from "@/lib/agent/tools/categories";
import { resolvePersona } from "@/lib/agent/personas/resolve";
import {
  narrowWriteCapability,
  narrowReadCapability,
} from "@/lib/agent/personas/apply-overrides";

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

  /**
   * --------------------------------------------------------
   * PENDING OWNER CONFIRMATION CHECK
   * --------------------------------------------------------
   *
   * lib/agent/approval/resolve.ts (Phase 5): if the owner's PREVIOUS
   * message resulted in a held-for-confirmation action (an ambiguous
   * calendar request, for instance), this message is very likely their
   * reply to it, not a new request. Checked before anything else so a
   * quick "yes"/"go ahead"/"cancel" doesn't get run through the normal
   * model pipeline at all — it's resolved deterministically here.
   *
   * Only one pending confirmation can exist per tenant at a time
   * (migration 012's unique constraint) — see that migration's comment
   * for why multi-item disambiguation isn't attempted yet.
   */
  const { data: pending } = await supabase
    .from("pending_owner_confirmations")
    .select("id, tool_name, args, confirmation_message, expires_at")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (pending) {
    if (new Date(pending.expires_at) < new Date()) {
      // Stale — clear it and fall through to normal processing, since
      // this incoming message is very unlikely to still be a reply to a
      // confirmation prompt sent over 30 minutes ago.
      await supabase.from("pending_owner_confirmations").delete().eq("id", pending.id);
    } else {
      const normalized = messageText.trim().toLowerCase();

      const isAffirmative = /^(yes|yep|yeah|yup|confirm|confirmed|go ahead|do it|sounds good|ok|okay|sure)\b/.test(
        normalized
      );
      const isNegative = /^(no|nope|cancel|don'?t|nevermind|never mind|stop)\b/.test(normalized);

      if (isAffirmative) {
        await supabase.from("pending_owner_confirmations").delete().eq("id", pending.id);

        const toolContext: ToolContext = {
          tenantId,
          supabase,
          permissions: {
            sendAllowed: false,
            calendarReadAllowed: true,
            calendarWriteCapability: "write",
            zoomCapability: "none",
          },
        };

        const toolDef = findToolForSurface(pending.tool_name, "chat", toolContext);

        if (!toolDef) {
          return "Sorry, I couldn't find how to complete that action anymore — could you ask again?";
        }

        // Confirmed execution — log it distinctly from the original
        // "held for confirmation" log entry so the audit trail shows
        // both the hold and the eventual confirmed execution.
        await supabase.from("owner_directed_action_log").insert({
          tenant_id: tenantId,
          tool_name: pending.tool_name,
          explicitness_heuristic_score: null,
          executed_directly: true,
          content_snapshot: JSON.stringify({ ...pending.args, confirmedByOwner: true }),
          source_channel: "chat",
        });

        return await toolDef.execute(pending.args as Record<string, any>, toolContext);
      }

      if (isNegative) {
        await supabase.from("pending_owner_confirmations").delete().eq("id", pending.id);
        return "No problem — I won't book that.";
      }

      // Ambiguous reply to a pending confirmation: re-ask rather than
      // guessing, and rather than silently falling through to the
      // normal pipeline (which could misinterpret this as an unrelated
      // new request while a real action is still sitting unconfirmed).
      return `Sorry, just to confirm: ${pending.confirmation_message}`;
    }
  }

  const { data: tenant } = await supabase
    .from("tenants")
    .select("business_name, business_description, timezone")
    .eq("id", tenantId)
    .single();

  const { data: agentConfig } = await supabase
    .from("agent_configs")
    .select("custom_instructions, rules, ai_provider, ai_model, tool_preferences")
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

  const calendarReadAllowedReal = await canReadCalendar(tenantId);
  const calendarWriteCapabilityReal = await resolveCalendarWriteCapability(tenantId);

  /**
   * Google Chat is already, by this file's own design (see the module
   * docstring above), a conversation with the OWNER — not a customer.
   * So this resolves the tenant's "owner" persona, not "customer" as
   * lib/agent/run.ts does. Every tenant is currently seeded (migration
   * 010) with only a "customer" persona, so resolvePersona() falls back
   * to its synthetic default here (empty overrides) until an owner
   * persona actually exists for a tenant — a safe no-op, not a bug.
   */
  const persona = await resolvePersona(tenantId, "owner");

  const calendarReadAllowed = narrowReadCapability(
    calendarReadAllowedReal,
    persona,
    "calendar.read"
  );
  const calendarWriteCapability = narrowWriteCapability(
    calendarWriteCapabilityReal,
    persona,
    "calendar.write"
  );

  /**
   * See lib/agent/tools/categories.ts. Chat has no Zoom tool at all
   * (zoomCapability is always "none" for this surface, below), so this
   * only ever resolves to Google Meet-or-nothing today — but it's
   * computed the same way as the email pipeline so it stays correct
   * automatically if a Zoom chat tool is ever added.
   */
  const videoMeetingCategory = resolveCategory(
    "video_meeting",
    {
      zoom: false,
      calendar: calendarWriteCapability !== "none",
    },
    (agentConfig?.tool_preferences ?? {}) as Record<string, string>
  );

  const videoMeetingGuidance = videoMeetingCategory
    ? describeResolvedCategory(videoMeetingCategory)
    : "";


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
      ownerMessageText: messageText,
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
        buildCurrentDateContext(tenant?.timezone),
        tenant?.business_description ?? "",
        agentConfig?.custom_instructions ?? "",
        `There are currently ${pendingEmailCount ?? 0} email drafts awaiting the owner's review.`,
        calendarReadAllowed ? "You can discuss calendar availability if asked." : "",
        videoMeetingGuidance,
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
