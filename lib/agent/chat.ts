import { createServiceSupabase } from "@/lib/supabase/server";
import { resolveCalendarWriteCapability, canReadCalendar } from "@/lib/agent/permissions";
import { recordUsage } from "@/lib/billing/meter";
import { calculateModelCost } from "@/lib/billing/pricing";
import { runChatCompletion, type LlmMessage, type LlmToolDefinition, type LlmUsage } from "@/lib/agent/llm";
import { resolveModelSelection, type AIProvider } from "@/lib/agent/models";

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

  const { provider: aiProvider, model: aiModel } = resolveModelSelection(
    agentConfig?.ai_provider,
    agentConfig?.ai_model
  );

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

  const tools = buildChatToolDefinitions(calendarWriteCapability);

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

  if (toolCall.name === "create_calendar_event") {
    const { createEvent } = await import("@/lib/calendar/client");
    const event = await createEvent(tenantId, {
      summary: args.summary,
      startTime: args.startTime,
      endTime: args.endTime,
    });
    await supabase.from("calendar_actions").insert({
      tenant_id: tenantId,
      action_type: "create_event",
      status: "sent",
      proposed_summary: args.summary,
      proposed_start: args.startTime,
      proposed_end: args.endTime,
      google_event_id: event.id,
      reasoning: "Requested directly via Google Chat",
    });
    return `Done — booked "${args.summary}" on your calendar.`;
  }

  if (toolCall.name === "check_pending_approvals") {
    if (!pendingEmails || pendingEmails.length === 0) {
      return "Nothing waiting on you right now — you're all caught up.";
    }
    const list = pendingEmails.map((a) => `• ${a.draft_content?.slice(0, 60)}...`).join("\n");
    return `You have ${pendingEmailCount} draft(s) waiting:\n${list}\n\nReview them at ${process.env.NEXT_PUBLIC_APP_URL}/dashboard/approvals`;
  }

  return result.content ?? "Done.";
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

function buildChatToolDefinitions(
  calendarWriteCapability: "write" | "propose_only" | "none"
): LlmToolDefinition[] {
  const tools: LlmToolDefinition[] = [
    {
      name: "check_pending_approvals",
      description: "Look up how many email drafts are currently waiting for the owner's review, and list them.",
      parameters: { type: "object", properties: {} },
    },
  ];

  // Chatting directly with the owner counts as the owner's own instruction —
  // "write" capability is offered even when calendar.write is set to
  // approval_required for the email pipeline, since here the owner IS the
  // approver, in real time, by virtue of typing the request themselves.
  if (calendarWriteCapability !== "none") {
    tools.push({
      name: "create_calendar_event",
      description: "Book a calendar event as requested by the owner in this chat.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          startTime: { type: "string", description: "ISO 8601 start datetime." },
          endTime: { type: "string", description: "ISO 8601 end datetime." },
        },
        required: ["summary", "startTime", "endTime"],
      },
    });
  }

  return tools;
}
