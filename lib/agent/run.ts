import OpenAI from "openai";
import { createServiceSupabase } from "@/lib/supabase/server";
import { resolveSendCapability, checkRulesForTopic } from "@/lib/agent/permissions";
import { createDraft } from "@/lib/gmail/client";
import { notifyOwner } from "@/lib/notify";

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
 * tool at all — only "create_draft" — so there is no way for it to send
 * without the enforcement layer's separate confirmation step.
 */
export async function processIncomingEmail(email: IncomingEmail) {
  const supabase = createServiceSupabase();

  const sendCapability = await resolveSendCapability(email.tenantId);

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

  const tools = buildToolDefinitions(sendCapability === "send" && !ruleCheck.requiresApproval);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
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
}

function buildToolDefinitions(sendAllowed: boolean): OpenAI.Chat.Completions.ChatCompletionTool[] {
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

  if (sendAllowed) {
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
