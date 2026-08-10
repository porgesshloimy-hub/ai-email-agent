import OpenAI from "openai";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  resolveSendCapability,
  resolveCalendarWriteCapability,
  canReadCalendar,
  checkRulesForTopic,
} from "@/lib/agent/permissions";
import { createDraft } from "@/lib/gmail/client";
import { notifyOwner } from "@/lib/notify";
import { recordUsage } from "@/lib/billing/meter";
import { calculateOpenAICost } from "@/lib/billing/pricing";

const OPENAI_MODEL = "gpt-4o";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface IncomingEmail {
  tenantId: string;
  threadId: string;
  messageId: string;
  from: string;
  subject: string;
  bodyText: string;
}

/**
 * Pipeline (matches the product diagram):
 * email arrives -> check permissions -> gather knowledge -> reason with OpenAI
 * -> take only the action the permission layer allows.
 *
 * Key rule: if "send" requires approval, the model is never given a "send"
 * tool at all — only "create_draft". Same pattern for calendar writes: if
 * calendar.write requires approval, the model only gets "propose_calendar_event",
 * which queues a suggestion rather than actually creating anything.
 */
export async function processIncomingEmail(email: IncomingEmail) {
  const supabase = createServiceSupabase();

  const sendCapability = await resolveSendCapability(email.tenantId);
  const calendarWriteCapability = await resolveCalendarWriteCapability(email.tenantId);
  const calendarReadAllowed = await canReadCalendar(email.tenantId);

  const { data: agentConfig } = await supabase
    .from("agent_configs")
    .select("custom_instructions, rules")
    .eq("tenant_id", email.tenantId)
    .single();

  const rules = (agentConfig?.rules ?? []) as { description: string }[];

  // Cheap pre-check: does this email's likely topic match a hard rule
  // (e.g. "refund")? This doesn't replace the model's own judgment, but it
  // guarantees certain topics never reach a "send" tool regardless of the
  // general permission matrix.
  const ruleCheck = checkRulesForTopic(rules, extractTopicTags(email.subject, email.bodyText));

  const relevantKnowledge = await searchKnowledge(email.tenantId, email.bodyText);

  const tools = buildToolDefinitions({
    sendAllowed: sendCapability === "send" && !ruleCheck.requiresApproval,
    calendarReadAllowed,
    calendarWriteCapability,
  });

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content: [
          `You are the email assistant for this business.`,
          agentConfig?.custom_instructions ?? "",
          `Rules you must follow:`,
          ...rules.map((r) => `- ${r.description}`),
          `Relevant business knowledge:`,
          relevantKnowledge.join("\n"),
        ].join("\n"),
      },
      {
        role: "user",
        content: `New email from ${email.from}\nSubject: ${email.subject}\n\n${email.bodyText}`,
      },
    ],
    tools,
    tool_choice: "auto",
  });

  // Meter this call regardless of what the model decided to do — every
  // completion costs tokens whether or not it results in an action.
  await meterOpenAIUsage(email.tenantId, email.threadId, completion);

  const toolCall = completion.choices[0].message.tool_calls?.[0];
  if (!toolCall) return; // model chose to take no action

  const args = JSON.parse(toolCall.function.arguments);

  if (toolCall.function.name === "create_draft") {
    const draft = await createDraft(email.tenantId, email.threadId, email.from, `Re: ${email.subject}`, args.body);

    await supabase.from("email_actions").insert({
      tenant_id: email.tenantId,
      gmail_thread_id: email.threadId,
      gmail_message_id: email.messageId,
      action_type: "draft_reply",
      status: "pending_approval",
      gmail_draft_id: draft.id,
      draft_content: args.body,
      reasoning: args.reasoning ?? null,
    });

    await notifyOwner(email.tenantId, `New draft ready to review: "${email.subject}"`);
  }

  if (toolCall.function.name === "send_reply") {
    // Only reachable when sendCapability === "send" (tool wasn't offered otherwise).
    const draft = await createDraft(email.tenantId, email.threadId, email.from, `Re: ${email.subject}`, args.body);
    const { sendDraft } = await import("@/lib/gmail/client");
    await sendDraft(email.tenantId, draft.id!);

    await supabase.from("email_actions").insert({
      tenant_id: email.tenantId,
      gmail_thread_id: email.threadId,
      gmail_message_id: email.messageId,
      action_type: "draft_reply",
      status: "sent",
      draft_content: args.body,
      reasoning: args.reasoning ?? null,
    });
  }

  if (toolCall.function.name === "create_calendar_event") {
    // Only reachable when calendarWriteCapability === "write".
    const { createEvent } = await import("@/lib/calendar/client");
    const event = await createEvent(email.tenantId, {
      summary: args.summary,
      description: args.description,
      startTime: args.startTime,
      endTime: args.endTime,
      attendeeEmails: args.attendeeEmails,
    });

    await supabase.from("calendar_actions").insert({
      tenant_id: email.tenantId,
      action_type: "create_event",
      status: "sent", // reusing the same enum as email_actions; "sent" here means "already happened, no approval needed"
      proposed_summary: args.summary,
      proposed_start: args.startTime,
      proposed_end: args.endTime,
      google_event_id: event.id,
      reasoning: args.reasoning ?? null,
    });
  }

  if (toolCall.function.name === "propose_calendar_event") {
    // Only reachable when calendarWriteCapability === "propose_only". Does
    // NOT touch Google Calendar — just queues it for the owner to confirm.
    await supabase.from("calendar_actions").insert({
      tenant_id: email.tenantId,
      action_type: "create_event",
      status: "pending_approval",
      proposed_summary: args.summary,
      proposed_start: args.startTime,
      proposed_end: args.endTime,
      reasoning: args.reasoning ?? null,
    });

    await notifyOwner(email.tenantId, `New calendar event proposed: "${args.summary}"`);
  }
}

async function meterOpenAIUsage(
  tenantId: string,
  threadId: string,
  completion: OpenAI.Chat.Completions.ChatCompletion
) {
  const usage = completion.usage;
  if (!usage) return;

  const rawCost = calculateOpenAICost(OPENAI_MODEL, usage.prompt_tokens, usage.completion_tokens);

  await recordUsage({
    tenantId,
    service: "openai",
    description: `${OPENAI_MODEL} completion, thread ${threadId}`,
    quantity: usage.total_tokens,
    unit: "tokens",
    rawCostUsd: rawCost,
  });
}

interface ToolFlags {
  sendAllowed: boolean;
  calendarReadAllowed: boolean;
  calendarWriteCapability: "write" | "propose_only" | "none";
}

function buildToolDefinitions(flags: ToolFlags): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "create_draft",
        description:
          "Create a Gmail draft reply for a human to review and send. Use this whenever a reply " +
          "needs approval, is uncertain, or touches anything sensitive (refunds, complaints, pricing exceptions).",
        parameters: {
          type: "object",
          properties: {
            body: { type: "string", description: "The draft reply body." },
            reasoning: { type: "string", description: "Brief note on why this draft was written this way." },
          },
          required: ["body"],
        },
      },
    },
  ];

  if (flags.sendAllowed) {
    tools.push({
      type: "function",
      function: {
        name: "send_reply",
        description: "Send a reply immediately without human review. Only for simple, pre-approved cases.",
        parameters: {
          type: "object",
          properties: {
            body: { type: "string", description: "The reply body to send." },
            reasoning: { type: "string" },
          },
          required: ["body"],
        },
      },
    });
  }

  const calendarEventParams = {
    type: "object" as const,
    properties: {
      summary: { type: "string", description: "Short event title." },
      description: { type: "string", description: "Optional longer description." },
      startTime: { type: "string", description: "ISO 8601 start datetime." },
      endTime: { type: "string", description: "ISO 8601 end datetime." },
      attendeeEmails: { type: "array", items: { type: "string" }, description: "Optional attendee email addresses." },
      reasoning: { type: "string" },
    },
    required: ["summary", "startTime", "endTime"],
  };

  if (flags.calendarWriteCapability === "write") {
    tools.push({
      type: "function",
      function: {
        name: "create_calendar_event",
        description: "Create a calendar event directly. Only for cases pre-approved for autonomous scheduling.",
        parameters: calendarEventParams,
      },
    });
  } else if (flags.calendarWriteCapability === "propose_only") {
    tools.push({
      type: "function",
      function: {
        name: "propose_calendar_event",
        description:
          "Propose a calendar event for the business owner to confirm. Use this whenever an email implies " +
          "scheduling something (a meeting, an appointment, a callback) but you don't have permission to book it directly.",
        parameters: calendarEventParams,
      },
    });
  }

  return tools;
}

function extractTopicTags(subject: string, body: string): string[] {
  // v1: naive keyword extraction. Swap for a small classification call if
  // the rule-matching needs to get smarter than substring matching.
  const text = `${subject} ${body}`.toLowerCase();
  const candidates = ["refund", "complaint", "cancel", "cancellation", "legal", "chargeback"];
  return candidates.filter((c) => text.includes(c));
}

async function searchKnowledge(tenantId: string, queryText: string): Promise<string[]> {
  // Embeds queryText and does a pgvector similarity search scoped to tenantId.
  // Stubbed here — wire up an embeddings call + supabase.rpc('match_knowledge_chunks', ...).
  return [];
}
