import OpenAI from "openai";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  resolveSendCapability,
  resolveCalendarWriteCapability,
  canReadCalendar,
  checkRulesForTopic,
} from "@/lib/agent/permissions";
import {
  createDraft,
  sendDraft,
} from "@/lib/gmail/client";
import { notifyApproval } from "@/lib/notify";
import { recordUsage } from "@/lib/billing/meter";
import { calculateOpenAICost } from "@/lib/billing/pricing";

const OPENAI_MODEL = "gpt-5-nano";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface IncomingEmail {
  tenantId: string;
  threadId: string;
  messageId: string;
  from: string;
  subject: string;
  bodyText: string;
}

/**
 * Main email-agent pipeline.
 *
 * Email arrives
 * -> duplicate check
 * -> permissions
 * -> business rules
 * -> knowledge
 * -> OpenAI
 * -> allowed action
 * -> approval queue when necessary
 */
export async function processIncomingEmail(
  email: IncomingEmail
) {
  const supabase = createServiceSupabase();

  /**
   * IMPORTANT:
   *
   * Gmail/Inngest can deliver the same history notification
   * more than once. We must make message processing idempotent.
   *
   * If we already created an email action for this exact
   * Gmail message, do not run the AI again and do not create
   * another draft.
   */
  const { data: existingAction, error: existingActionError } =
    await supabase
      .from("email_actions")
      .select("id, action_type, status, gmail_draft_id")
      .eq("tenant_id", email.tenantId)
      .eq("gmail_message_id", email.messageId)
      .limit(1)
      .maybeSingle();

  if (existingActionError) {
    throw new Error(
      `Failed to check for existing email action: ${existingActionError.message}`
    );
  }

  if (existingAction) {
    console.log("EMAIL ALREADY PROCESSED - SKIPPING:", {
      tenantId: email.tenantId,
      messageId: email.messageId,
      threadId: email.threadId,
      existingActionId: existingAction.id,
      existingActionType: existingAction.action_type,
      existingStatus: existingAction.status,
      existingDraftId: existingAction.gmail_draft_id,
    });

    return {
      action: "already_processed",
      emailActionId: existingAction.id,
    };
  }

  console.log("PROCESSING NEW EMAIL:", {
    tenantId: email.tenantId,
    messageId: email.messageId,
    threadId: email.threadId,
    from: email.from,
    subject: email.subject,
  });

  const sendCapability =
    await resolveSendCapability(email.tenantId);

  const calendarWriteCapability =
    await resolveCalendarWriteCapability(
      email.tenantId
    );

  const calendarReadAllowed =
    await canReadCalendar(email.tenantId);

  const { data: agentConfig } =
    await supabase
      .from("agent_configs")
      .select(
        "custom_instructions, rules"
      )
      .eq("tenant_id", email.tenantId)
      .single();

  const rules =
    (agentConfig?.rules ?? []) as {
      description: string;
    }[];

  const topicTags = extractTopicTags(
    email.subject,
    email.bodyText
  );

  const ruleCheck =
    checkRulesForTopic(
      rules,
      topicTags
    );

  const relevantRules =
    rules.filter((rule) => {
      const description =
        rule.description.toLowerCase();

      return topicTags.some((tag) =>
        description.includes(tag)
      );
    });

  const relevantKnowledge =
    await searchKnowledge(
      email.tenantId,
      email.bodyText
    );

  /**
   * If a rule requires approval, we deliberately
   * do not expose send_reply to OpenAI.
   */
  const effectiveSendAllowed =
    sendCapability === "send" &&
    !ruleCheck.requiresApproval;

  const tools =
    buildToolDefinitions({
      sendAllowed:
        effectiveSendAllowed,
      calendarReadAllowed,
      calendarWriteCapability,
    });

  let completion;

  try {
    completion =
      await openai.chat.completions.create({
        model: OPENAI_MODEL,

        messages: [
          {
            role: "system",
            content: [
              "You are the email assistant for this business.",

              agentConfig?.custom_instructions ??
                "",

              "Rules you must follow:",

              ...relevantRules.map(
                (rule) =>
                  `- ${rule.description}`
              ),

              "Relevant business knowledge:",

              relevantKnowledge.join("\n"),

              "",

              "IMPORTANT:",

              "Never invent business policies, prices, refunds, commitments, or facts.",

              "If you are uncertain, create a draft instead of sending.",

              "Keep replies professional, concise, and useful.",
            ].join("\n"),
          },

          {
            role: "user",
            content:
              `New email from ${email.from}\n` +
              `Subject: ${email.subject}\n\n` +
              email.bodyText,
          },
        ],

        tools,

        tool_choice: "auto",
      });
  } catch (error) {
    console.error(
      "OPENAI ERROR:",
      error
    );

    throw error;
  }

  await meterOpenAIUsage(
    email.tenantId,
    email.threadId,
    completion
  );

  const toolCall =
    completion.choices[0].message.tool_calls?.[0];

  /**
   * The model decided that no action was necessary.
   */
  if (!toolCall) {
    return {
      action: "none",
    };
  }

  const args = JSON.parse(
    toolCall.function.arguments
  );

  /**
   * --------------------------------------------------
   * CREATE DRAFT
   * --------------------------------------------------
   */
  if (
    toolCall.function.name ===
    "create_draft"
  ) {
    const draft =
      await createDraft(
        email.tenantId,
        email.threadId,
        email.from,
        `Re: ${email.subject}`,
        args.body,
        email.messageId
      );

    if (!draft.id) {
      throw new Error(
        "Gmail did not return a draft ID"
      );
    }

    const { data: action, error } =
      await supabase
        .from("email_actions")
        .insert({
          tenant_id:
            email.tenantId,

          gmail_thread_id:
            email.threadId,

          gmail_message_id:
            email.messageId,

          action_type:
            "draft_reply",

          status:
            "pending_approval",

          gmail_draft_id:
            draft.id,

          draft_content:
            args.body,

          reasoning:
            args.reasoning ?? null,
        })
        .select("id")
        .single();

    if (error || !action) {
      throw new Error(
        `Failed to create email action: ${
          error?.message ??
          "unknown error"
        }`
      );
    }

    /**
     * Create the unified approval record.
     */
    const {
      data: approval,
      error: approvalError,
    } =
      await supabase
        .from("approvals")
        .insert({
          tenant_id:
            email.tenantId,

          action_type:
            "gmail.send",

          action_id:
            action.id,

          status:
            "pending",

          description:
            `Reply to ${email.from} regarding "${email.subject}"`,

          expires_at:
            new Date(
              Date.now() +
                24 * 60 * 60 * 1000
            ).toISOString(),
        })
        .select("id")
        .single();

    if (
      approvalError ||
      !approval
    ) {
      throw new Error(
        `Failed to create approval: ${
          approvalError?.message ??
          "unknown error"
        }`
      );
    }

    /**
     * Notify the owner by SMS.
     */
    await notifyApproval(
      email.tenantId,
      approval.id,
      `New email reply ready for approval.\n\nFrom: ${email.from}\nSubject: ${email.subject}`
    );

    console.log(
      "EMAIL DRAFT CREATED:",
      {
        tenantId:
          email.tenantId,
        messageId:
          email.messageId,
        threadId:
          email.threadId,
        draftId:
          draft.id,
        emailActionId:
          action.id,
        approvalId:
          approval.id,
      }
    );

    return {
      action:
        "pending_approval",

      emailActionId:
        action.id,

      approvalId:
        approval.id,
    };
  }

  /**
   * --------------------------------------------------
   * SEND REPLY DIRECTLY
   * --------------------------------------------------
   *
   * This path is only available when the permission
   * engine explicitly allows sending.
   */
  if (
    toolCall.function.name ===
    "send_reply"
  ) {
    if (!effectiveSendAllowed) {
      throw new Error(
        "Security violation: send_reply was attempted without permission"
      );
    }

    const draft =
      await createDraft(
        email.tenantId,
        email.threadId,
        email.from,
        `Re: ${email.subject}`,
        args.body,
        email.messageId
      );

    if (!draft.id) {
      throw new Error(
        "Gmail did not return a draft ID"
      );
    }

    await sendDraft(
      email.tenantId,
      draft.id
    );

    await supabase
      .from("email_actions")
      .insert({
        tenant_id:
          email.tenantId,

        gmail_thread_id:
          email.threadId,

        gmail_message_id:
          email.messageId,

        action_type:
          "draft_reply",

        status:
          "sent",

        gmail_draft_id:
          draft.id,

        draft_content:
          args.body,

        reasoning:
          args.reasoning ?? null,

        resolved_at:
          new Date().toISOString(),
      });

    console.log(
      "EMAIL SENT:",
      {
        tenantId:
          email.tenantId,
        messageId:
          email.messageId,
        threadId:
          email.threadId,
        draftId:
          draft.id,
      }
    );

    return {
      action: "sent",
    };
  }

  /**
   * --------------------------------------------------
   * CALENDAR EVENT
   * --------------------------------------------------
   */
  if (
    toolCall.function.name ===
    "create_calendar_event"
  ) {
    if (
      calendarWriteCapability !==
      "write"
    ) {
      throw new Error(
        "Security violation: calendar write attempted without permission"
      );
    }

    const {
      createEvent,
    } =
      await import(
        "@/lib/calendar/client"
      );

    const event =
      await createEvent(
        email.tenantId,
        {
          summary:
            args.summary,

          description:
            args.description,

          startTime:
            args.startTime,

          endTime:
            args.endTime,

          attendeeEmails:
            args.attendeeEmails,
        }
      );

    await supabase
      .from("calendar_actions")
      .insert({
        tenant_id:
          email.tenantId,

        action_type:
          "create_event",

        status:
          "sent",

        proposed_summary:
          args.summary,

        proposed_start:
          args.startTime,

        proposed_end:
          args.endTime,

        google_event_id:
          event.id,

        reasoning:
          args.reasoning ?? null,
      });

    return {
      action:
        "calendar_created",

      googleEventId:
        event.id,
    };
  }

  /**
   * --------------------------------------------------
   * CALENDAR PROPOSAL
   * --------------------------------------------------
   */
  if (
    toolCall.function.name ===
    "propose_calendar_event"
  ) {
    if (
      calendarWriteCapability !==
      "propose_only"
    ) {
      throw new Error(
        "Security violation: calendar proposal attempted incorrectly"
      );
    }

    const {
      data: calendarAction,
      error,
    } =
      await supabase
        .from("calendar_actions")
        .insert({
          tenant_id:
            email.tenantId,

          action_type:
            "create_event",

          status:
            "pending_approval",

          proposed_summary:
            args.summary,

          proposed_start:
            args.startTime,

          proposed_end:
            args.endTime,

          reasoning:
            args.reasoning ?? null,
        })
        .select("id")
        .single();

    if (
      error ||
      !calendarAction
    ) {
      throw new Error(
        `Failed to create calendar action: ${
          error?.message ??
          "unknown error"
        }`
      );
    }

    const {
      data: approval,
      error: approvalError,
    } =
      await supabase
        .from("approvals")
        .insert({
          tenant_id:
            email.tenantId,

          action_type:
            "calendar.create",

          action_id:
            calendarAction.id,

          status:
            "pending",

          description:
            `Create calendar event "${args.summary}"`,

          expires_at:
            new Date(
              Date.now() +
                24 * 60 * 60 * 1000
            ).toISOString(),
        })
        .select("id")
        .single();

    if (
      approvalError ||
      !approval
    ) {
      throw new Error(
        `Failed to create calendar approval: ${
          approvalError?.message ??
          "unknown error"
        }`
      );
    }

    await notifyApproval(
      email.tenantId,
      approval.id,
      `Calendar event needs approval.\n\n${args.summary}\n${args.startTime}`
    );

    return {
      action:
        "calendar_pending_approval",

      approvalId:
        approval.id,
    };
  }

  return {
    action: "unknown",
  };
}

/**
 * OpenAI tool definitions.
 *
 * The permission engine controls which dangerous
 * tools exist. The model cannot call a tool that
 * wasn't provided here.
 */
interface ToolFlags {
  sendAllowed: boolean;
  calendarReadAllowed: boolean;
  calendarWriteCapability:
    | "write"
    | "propose_only"
    | "none";
}

function buildToolDefinitions(
  flags: ToolFlags
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] =
    [
      {
        type: "function",

        function: {
          name: "create_draft",

          description:
            "Create a Gmail draft reply for human approval. Use this when sending requires approval, when uncertain, or for sensitive topics such as refunds, complaints, pricing exceptions, legal matters, or cancellations.",

          parameters: {
            type: "object",

            properties: {
              body: {
                type: "string",
                description:
                  "The complete reply body.",
              },

              reasoning: {
                type: "string",
                description:
                  "Brief explanation of why this response is appropriate.",
              },
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

        description:
          "Send a reply immediately. Only use this for simple cases that are explicitly allowed by the business owner's permission settings.",

        parameters: {
          type: "object",

          properties: {
            body: {
              type: "string",
              description:
                "The complete reply body.",
            },

            reasoning: {
              type: "string",
            },
          },

          required: ["body"],
        },
      },
    });
  }

  const calendarEventParams = {
    type: "object" as const,

    properties: {
      summary: {
        type: "string",
        description:
          "Short event title.",
      },

      description: {
        type: "string",
        description:
          "Optional event description.",
      },

      startTime: {
        type: "string",
        description:
          "ISO 8601 start datetime.",
      },

      endTime: {
        type: "string",
        description:
          "ISO 8601 end datetime.",
      },

      attendeeEmails: {
        type: "array",

        items: {
          type: "string",
        },

        description:
          "Optional attendee email addresses.",
      },

      reasoning: {
        type: "string",
      },
    },

    required: [
      "summary",
      "startTime",
      "endTime",
    ],
  };

  if (
    flags.calendarWriteCapability ===
    "write"
  ) {
    tools.push({
      type: "function",

      function: {
        name:
          "create_calendar_event",

        description:
          "Create a calendar event directly. Only use when calendar writing is explicitly allowed.",

        parameters:
          calendarEventParams,
      },
    });
  }

  if (
    flags.calendarWriteCapability ===
    "propose_only"
  ) {
    tools.push({
      type: "function",

      function: {
        name:
          "propose_calendar_event",

        description:
          "Propose a calendar event for owner approval. Do not create the Google Calendar event directly.",

        parameters:
          calendarEventParams,
      },
    });
  }

  return tools;
}

function extractTopicTags(
  subject: string,
  body: string
): string[] {
  const text =
    `${subject} ${body}`.toLowerCase();

  const candidates = [
    "refund",
    "complaint",
    "cancel",
    "cancellation",
    "legal",
    "chargeback",
    "pricing",
    "discount",
    "contract",
  ];

  return candidates.filter(
    (candidate) =>
      text.includes(candidate)
  );
}

/**
 * Knowledge search.
 *
 * Converts the incoming email into an embedding, then searches
 * this tenant's knowledge base using pgvector.
 */
async function searchKnowledge(
  tenantId: string,
  queryText: string
): Promise<string[]> {
  if (!queryText.trim()) {
    return [];
  }

  try {
    const embeddingResponse =
      await openai.embeddings.create({
        model:
          "text-embedding-3-small",

        input: queryText,
      });

    const queryEmbedding =
      embeddingResponse.data[0]
        ?.embedding;

    if (!queryEmbedding) {
      console.error(
        "OpenAI returned no embedding"
      );

      return [];
    }

    const supabase =
      createServiceSupabase();

    const {
      data,
      error,
    } = await supabase.rpc(
      "match_knowledge_chunks",
      {
        query_embedding:
          queryEmbedding,

        match_tenant_id:
          tenantId,

        match_count: 5,
      }
    );

    if (error) {
      console.error(
        "Knowledge search failed:",
        error
      );

      return [];
    }

    return (data ?? [])
      .filter(
        (chunk: {
          content?:
            string | null;

          similarity?:
            number | null;
        }) =>
          typeof chunk.content ===
            "string" &&
          chunk.content.trim()
            .length > 0 &&
          typeof chunk.similarity ===
            "number" &&
          chunk.similarity >= 0.65
      )
      .map(
        (chunk: {
          content: string;
          similarity: number;
        }) =>
          chunk.content
      );
  } catch (error) {
    console.error(
      "Knowledge search error:",
      error
    );

    return [];
  }
}

async function supabaseMatchKnowledge(
  tenantId: string,
  queryEmbedding: number[]
) {
  const supabase =
    createServiceSupabase();

  return supabase.rpc(
    "match_knowledge_chunks",
    {
      query_embedding:
        queryEmbedding,

      match_tenant_id:
        tenantId,

      match_count: 5,
    }
  );
}

async function meterOpenAIUsage(
  tenantId: string,
  threadId: string,
  completion:
    OpenAI.Chat.Completions.ChatCompletion
) {
  const usage =
    completion.usage;

  if (!usage) {
    return;
  }

  const rawCost =
    calculateOpenAICost(
      OPENAI_MODEL,
      usage.prompt_tokens,
      usage.completion_tokens
    );

  await recordUsage({
    tenantId,

    service: "openai",

    description:
      `${OPENAI_MODEL} completion, thread ${threadId}`,

    quantity:
      usage.total_tokens,

    unit: "tokens",

    rawCostUsd:
      rawCost,
  });
}