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
import { notifyOwner } from "@/lib/notify";
import { recordUsage } from "@/lib/billing/meter";
import { calculateOpenAICost } from "@/lib/billing/pricing";

const OPENAI_MODEL = "gpt-4o";

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

interface ToolFlags {
  sendAllowed: boolean;
  draftAllowed: boolean;
  calendarReadAllowed: boolean;
  calendarWriteCapability:
    | "write"
    | "propose_only"
    | "none";
}

/**
 * Main AI email-agent pipeline.
 *
 * Flow:
 *
 * incoming email
 *   ↓
 * permissions
 *   ↓
 * business rules
 *   ↓
 * business knowledge
 *   ↓
 * OpenAI
 *   ↓
 * tools allowed by permission engine
 *   ↓
 * Gmail / Calendar
 *
 * IMPORTANT:
 *
 * The model never decides whether it is allowed to perform an action.
 * The permission engine decides which tools the model receives.
 */
export async function processIncomingEmail(
  email: IncomingEmail
) {
  const supabase = createServiceSupabase();

  /**
   * ---------------------------------------------------------
   * 1. Resolve permissions
   * ---------------------------------------------------------
   */

  const sendCapability =
    await resolveSendCapability(
      email.tenantId
    );

  const calendarWriteCapability =
    await resolveCalendarWriteCapability(
      email.tenantId
    );

  const calendarReadAllowed =
    await canReadCalendar(
      email.tenantId
    );

  const sendAllowed =
    sendCapability === "send";

  const draftAllowed =
    sendCapability === "send" ||
    sendCapability === "draft_only";

  /**
   * ---------------------------------------------------------
   * 2. Load tenant agent configuration
   * ---------------------------------------------------------
   */

  const { data: agentConfig } =
    await supabase
      .from("agent_configs")
      .select(
        "custom_instructions, rules"
      )
      .eq(
        "tenant_id",
        email.tenantId
      )
      .single();

  const rules =
    (agentConfig?.rules ?? []) as {
      description: string;
    }[];

  /**
   * ---------------------------------------------------------
   * 3. Hard business-rule check
   * ---------------------------------------------------------
   *
   * These rules can force approval even if general
   * permission settings allow automatic sending.
   */

  const ruleCheck =
    checkRulesForTopic(
      rules,
      extractTopicTags(
        email.subject,
        email.bodyText
      )
    );

  /**
   * If a hard rule matched, remove send capability.
   *
   * The model will still be able to create a draft,
   * assuming drafts are permitted.
   */

  const effectiveSendAllowed =
    sendAllowed &&
    !ruleCheck.requiresApproval;

  /**
   * ---------------------------------------------------------
   * 4. Gather business knowledge
   * ---------------------------------------------------------
   */

  const relevantKnowledge =
    await searchKnowledge(
      email.tenantId,
      email.bodyText
    );

  /**
   * ---------------------------------------------------------
   * 5. Build only the tools the permission system allows
   * ---------------------------------------------------------
   */

  const tools =
    buildToolDefinitions({
      sendAllowed:
        effectiveSendAllowed,
      draftAllowed,
      calendarReadAllowed,
      calendarWriteCapability,
    });

  /**
   * ---------------------------------------------------------
   * 6. Build initial OpenAI conversation
   * ---------------------------------------------------------
   */

  const messages:
    OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    [
      {
        role: "system",
        content: [
          "You are the email assistant for this business.",
          "",
          agentConfig?.custom_instructions ??
            "",
          "",
          "Rules you must follow:",
          ...rules.map(
            (rule) =>
              `- ${rule.description}`
          ),
          "",
          "Relevant business knowledge:",
          relevantKnowledge.length
            ? relevantKnowledge.join("\n")
            : "No additional business knowledge was found.",
          "",
          "Important operating instructions:",
          "- Follow the available tools exactly.",
          "- Never claim that an action was completed unless the corresponding tool actually succeeded.",
          "- If a tool is unavailable, do not attempt to perform that action another way.",
          "- If a reply requires approval, create a draft rather than sending it.",
          "- Be concise and professional when replying to customers.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `New email from: ${email.from}`,
          `Subject: ${email.subject}`,
          "",
          email.bodyText,
        ].join("\n"),
      },
    ];

  /**
   * ---------------------------------------------------------
   * 7. OpenAI tool loop
   * ---------------------------------------------------------
   *
   * The previous implementation only processed the first
   * tool call.
   *
   * This version allows the model to perform multiple actions
   * while still keeping every action behind the permission
   * layer.
   *
   * We intentionally disable parallel tool calls because
   * these tools have real-world side effects.
   */

  const MAX_TOOL_ROUNDS = 5;

  for (
    let round = 0;
    round < MAX_TOOL_ROUNDS;
    round++
  ) {
    const completion =
      await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages,
        tools:
          tools.length > 0
            ? tools
            : undefined,
        tool_choice:
          tools.length > 0
            ? "auto"
            : undefined,
        parallel_tool_calls: false,
      });

    /**
     * Meter every OpenAI completion.
     */
    await meterOpenAIUsage(
      email.tenantId,
      email.threadId,
      completion
    );

    const assistantMessage =
      completion.choices[0]?.message;

    if (!assistantMessage) {
      return {
        status: "completed",
        reason: "no_assistant_message",
      };
    }

    /**
     * Add the assistant's response to the
     * conversation before processing tools.
     */
    messages.push(assistantMessage);

    const toolCalls =
      assistantMessage.tool_calls ?? [];

    /**
     * No tools means the model has finished.
     */
    if (toolCalls.length === 0) {
      return {
        status: "completed",
        rounds: round + 1,
      };
    }

    /**
     * Execute every tool call sequentially.
     */
    for (const toolCall of toolCalls) {
      const result =
        await executeToolCall({
          toolCall,
          email,
          supabase,
        });

      /**
       * Feed the tool result back to OpenAI.
       *
       * This allows the model to understand what actually
       * happened and decide whether another permitted action
       * is necessary.
       */
      messages.push({
        role: "tool",
        tool_call_id:
          toolCall.id,
        content:
          JSON.stringify(result),
      });
    }
  }

  /**
   * Safety stop.
   *
   * Prevents an unexpected model/tool loop from running
   * indefinitely.
   */

  console.warn(
    `AI tool loop reached maximum rounds for thread ${email.threadId}`
  );

  return {
    status: "stopped",
    reason: "max_tool_rounds_reached",
  };
}

/**
 * -----------------------------------------------------------
 * Tool execution
 * -----------------------------------------------------------
 */

async function executeToolCall({
  toolCall,
  email,
  supabase,
}: {
  toolCall:
    OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
  email: IncomingEmail;
  supabase: ReturnType<
    typeof createServiceSupabase
  >;
}) {
  const toolName =
    toolCall.function.name;

  let args: Record<
    string,
    any
  >;

  try {
    args = JSON.parse(
      toolCall.function.arguments || "{}"
    );
  } catch {
    return {
      success: false,
      error:
        "The tool arguments were invalid JSON.",
    };
  }

  /**
   * ---------------------------------------------------------
   * CREATE DRAFT
   * ---------------------------------------------------------
   */

  if (
    toolName === "create_draft"
  ) {
    try {
      const draft = await createDraft(
  email.tenantId,
  email.threadId,
  email.from,
  `Re: ${email.subject}`,
  args.body,
  email.messageId
);

      const {
        error: insertError,
      } = await supabase
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
            args.reasoning ??
            null,
        });

      if (insertError) {
        console.error(
          "Failed to record draft action:",
          insertError
        );
      }

      await notifyOwner(
        email.tenantId,
        `New draft ready to review: "${email.subject}"`
      );

      return {
        success: true,
        action: "draft_created",
        draftId: draft.id,
        requiresApproval: true,
        message:
          "The reply was saved as a Gmail draft and queued for owner approval.",
      };
    } catch (error) {
      console.error(
        "Failed to create Gmail draft:",
        error
      );

      return {
        success: false,
        action: "draft_created",
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  /**
   * ---------------------------------------------------------
   * SEND REPLY
   * ---------------------------------------------------------
   */

  if (
    toolName === "send_reply"
  ) {
    try {
      /**
       * IMPORTANT:
       *
       * This is an additional server-side safety check.
       * Even though the tool should only be exposed when
       * permitted, we check the permission again here.
       */

      const sendCapability =
        await resolveSendCapability(
          email.tenantId
        );

      if (
        sendCapability !== "send"
      ) {
        return {
          success: false,
          action: "send_reply",
          error:
            "Sending is not currently permitted for this tenant.",
        };
      }

      /**
       * Re-run hard topic rules.
       *
       * This protects against future changes where the
       * tool might accidentally be exposed.
       */

      const {
        data: agentConfig,
      } = await supabase
        .from("agent_configs")
        .select("rules")
        .eq(
          "tenant_id",
          email.tenantId
        )
        .single();

      const rules =
        (agentConfig?.rules ??
          []) as {
          description: string;
        }[];

      const ruleCheck =
        checkRulesForTopic(
          rules,
          extractTopicTags(
            email.subject,
            email.bodyText
          )
        );

      if (
        ruleCheck.requiresApproval
      ) {
        /**
         * Fall back to a draft instead of sending.
         */

        const draft = await createDraft(
  email.tenantId,
  email.threadId,
  email.from,
  `Re: ${email.subject}`,
  args.body,
  email.messageId
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
              "pending_approval",
            gmail_draft_id:
              draft.id,
            draft_content:
              args.body,
            reasoning:
              args.reasoning ??
              `Approval required by rule: ${ruleCheck.matchedRule ?? "business rule"}`,
          });

        await notifyOwner(
          email.tenantId,
          `Reply requires approval: "${email.subject}"`
        );

        return {
          success: true,
          action:
            "draft_created_instead_of_send",
          requiresApproval: true,
          reason:
            ruleCheck.matchedRule ??
            "Business rule requires approval.",
        };
      }

      /**
       * Create the Gmail draft first.
       *
       * We intentionally use the same draft/send mechanism
       * for autonomous sending.
       */
    const draft = await createDraft(
  email.tenantId,
  email.threadId,
  email.from,
  `Re: ${email.subject}`,
  args.body,
  email.messageId
);

      if (!draft.id) {
        return {
          success: false,
          action: "send_reply",
          error:
            "Gmail did not return a draft ID.",
        };
      }

      const sent =
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
          status: "sent",
          gmail_draft_id:
            draft.id,
          draft_content:
            args.body,
          reasoning:
            args.reasoning ??
            null,
        });

      return {
        success: true,
        action: "reply_sent",
        messageId: sent.id,
        message:
          "The reply was sent successfully.",
      };
    } catch (error) {
      console.error(
        "Failed to send Gmail reply:",
        error
      );

      return {
        success: false,
        action: "send_reply",
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  /**
   * ---------------------------------------------------------
   * CREATE CALENDAR EVENT
   * ---------------------------------------------------------
   */

  if (
    toolName ===
    "create_calendar_event"
  ) {
    try {
      const capability =
        await resolveCalendarWriteCapability(
          email.tenantId
        );

      if (
        capability !== "write"
      ) {
        return {
          success: false,
          action:
            "create_calendar_event",
          error:
            "Calendar event creation is not currently permitted.",
        };
      }

      const {
        createEvent,
      } = await import(
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
          status: "sent",
          proposed_summary:
            args.summary,
          proposed_start:
            args.startTime,
          proposed_end:
            args.endTime,
          google_event_id:
            event.id,
          reasoning:
            args.reasoning ??
            null,
        });

      return {
        success: true,
        action:
          "calendar_event_created",
        eventId: event.id,
        message:
          "The calendar event was created successfully.",
      };
    } catch (error) {
      console.error(
        "Failed to create calendar event:",
        error
      );

      return {
        success: false,
        action:
          "create_calendar_event",
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  /**
   * ---------------------------------------------------------
   * PROPOSE CALENDAR EVENT
   * ---------------------------------------------------------
   */

  if (
    toolName ===
    "propose_calendar_event"
  ) {
    try {
      const capability =
        await resolveCalendarWriteCapability(
          email.tenantId
        );

      if (
        capability === "none"
      ) {
        return {
          success: false,
          action:
            "propose_calendar_event",
          error:
            "Calendar writes are disabled for this tenant.",
        };
      }

      /**
       * If the tenant has since changed permissions to
       * full write access, create the event directly.
       */
      if (
        capability === "write"
      ) {
        const {
          createEvent,
        } = await import(
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
            status: "sent",
            proposed_summary:
              args.summary,
            proposed_start:
              args.startTime,
            proposed_end:
              args.endTime,
            google_event_id:
              event.id,
            reasoning:
              args.reasoning ??
              null,
          });

        return {
          success: true,
          action:
            "calendar_event_created",
          eventId: event.id,
        };
      }

      /**
       * Otherwise queue it for approval.
       */
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
            args.reasoning ??
            null,
        });

      await notifyOwner(
        email.tenantId,
        `New calendar event proposed: "${args.summary}"`
      );

      return {
        success: true,
        action:
          "calendar_event_proposed",
        requiresApproval: true,
        message:
          "The calendar event was queued for owner approval.",
      };
    } catch (error) {
      console.error(
        "Failed to propose calendar event:",
        error
      );

      return {
        success: false,
        action:
          "propose_calendar_event",
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  /**
   * Unknown tool.
   *
   * This should never happen because the model can only
   * receive tools from buildToolDefinitions().
   */
  return {
    success: false,
    error: `Unknown tool: ${toolName}`,
  };
}

/**
 * -----------------------------------------------------------
 * OpenAI tool definitions
 * -----------------------------------------------------------
 */

function buildToolDefinitions(
  flags: ToolFlags
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] =
    [];

  /**
   * Gmail draft.
   *
   * Available whenever the tenant has either draft or
   * send capability.
   */
  if (flags.draftAllowed) {
    tools.push({
      type: "function",
      function: {
        name: "create_draft",
        description:
          "Create a Gmail draft reply for a human to review and send. Use this whenever a reply needs approval, is uncertain, or touches anything sensitive such as refunds, complaints, pricing exceptions, legal issues, or cancellations.",
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
                "Brief explanation of why this reply was written this way.",
            },
          },
          required: ["body"],
        },
      },
    });
  }

  /**
   * Autonomous Gmail sending.
   */
  if (flags.sendAllowed) {
    tools.push({
      type: "function",
      function: {
        name: "send_reply",
        description:
          "Send a reply immediately without human review. Use only for straightforward requests that are clearly within the business's normal policies and do not conflict with any business rule.",
        parameters: {
          type: "object",
          properties: {
            body: {
              type: "string",
              description:
                "The complete reply body to send.",
            },
            reasoning: {
              type: "string",
              description:
                "Brief explanation of why the reply can safely be sent automatically.",
            },
          },
          required: ["body"],
        },
      },
    });
  }

  /**
   * Calendar event parameters.
   */
  const calendarEventParams = {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description:
          "Short calendar event title.",
      },
      description: {
        type: "string",
        description:
          "Optional event description.",
      },
      startTime: {
        type: "string",
        description:
          "ISO 8601 start datetime including timezone.",
      },
      endTime: {
        type: "string",
        description:
          "ISO 8601 end datetime including timezone.",
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
        description:
          "Brief explanation of why this event should be created or proposed.",
      },
    },
    required: [
      "summary",
      "startTime",
      "endTime",
    ],
  };

  /**
   * Direct calendar creation.
   */
  if (
    flags.calendarWriteCapability ===
    "write"
  ) {
    tools.push({
      type: "function",
      function: {
        name: "create_calendar_event",
        description:
          "Create a calendar event directly. Use only when the business has explicitly allowed autonomous calendar writes.",
        parameters:
          calendarEventParams,
      },
    });
  }

  /**
   * Calendar proposal.
   */
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
          "Propose a calendar event for the business owner to approve. Do not claim that the event was booked because this action only creates an approval request.",
        parameters:
          calendarEventParams,
      },
    });
  }

  return tools;
}

/**
 * -----------------------------------------------------------
 * Topic extraction
 * -----------------------------------------------------------
 */

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
  ];

  return candidates.filter(
    (candidate) =>
      text.includes(candidate)
  );
}

/**
 * -----------------------------------------------------------
 * Business knowledge
 * -----------------------------------------------------------
 *
 * This remains a placeholder until your pgvector knowledge
 * search is wired up.
 */

async function searchKnowledge(
  tenantId: string,
  queryText: string
): Promise<string[]> {
  // TODO:
  // 1. Create an embedding for queryText.
  // 2. Call Supabase RPC match_knowledge_chunks.
  // 3. Scope results by tenantId.
  // 4. Return the most relevant business knowledge.
  //
  // Keeping this empty is safe — it simply means the agent
  // currently operates without retrieved business knowledge.

  void tenantId;
  void queryText;

  return [];
}

/**
 * -----------------------------------------------------------
 * OpenAI usage metering
 * -----------------------------------------------------------
 */

async function meterOpenAIUsage(
  tenantId: string,
  threadId: string,
  completion: OpenAI.Chat.Completions.ChatCompletion
) {
  const usage = completion.usage;

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
    rawCostUsd: rawCost,
  });
}