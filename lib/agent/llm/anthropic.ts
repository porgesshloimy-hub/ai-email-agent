import Anthropic from "@anthropic-ai/sdk";

import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmMessage,
  LlmProviderAdapter,
  LlmToolCall,
} from "./types";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Anthropic's API caps max_tokens per request. This agent produces
 * short business-email-length replies, tool calls, and brief reasoning
 * strings — nothing here needs a large completion budget.
 */
const MAX_OUTPUT_TOKENS = 4096;

export const anthropicAdapter: LlmProviderAdapter = {
  async complete(
    request: LlmCompletionRequest
  ): Promise<LlmCompletionResult> {
    const { system, messages } = toAnthropicMessages(
      request.messages
    );

    /**
     * Prompt caching — added after measuring the real cost driver
     * directly rather than guessing: the system prompt + tool
     * descriptions together run to roughly 3,000+ tokens of STATIC
     * content (identical across calls for the same tenant/persona),
     * resent in full, uncached, on every single completion — and a
     * chat turn often needs more than one completion (a tool call
     * followed by a result-phrasing call, or several steps in
     * chat.ts's multi-step loop), multiplying that resend within a
     * single turn. Marking the end of the system block and the end of
     * the tools array with cache_control caches everything up to and
     * including that point — Anthropic bills a cache hit at roughly
     * 10% of normal input price. This requires `system` to be an array
     * of content blocks rather than a plain string, which is why this
     * is built here rather than just passing the string through.
     */
    const tools = request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Messages.Tool.InputSchema,
    }));

    if (tools && tools.length > 0) {
      (tools[tools.length - 1] as any).cache_control = { type: "ephemeral" };
    }

    const systemBlocks = system
      ? [
          {
            type: "text" as const,
            text: system,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : undefined;

    const response = await anthropic.messages.create({
      model: request.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemBlocks,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
    });

    let textContent: string | null = null;
    const toolCalls: LlmToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        textContent = (textContent ?? "") + block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }

    /**
     * Anthropic returns cache_creation_input_tokens and
     * cache_read_input_tokens as separate fields from input_tokens
     * once caching is in use. The installed SDK version (0.32.1)'s
     * TypeScript types don't yet declare these fields on the Usage
     * type, even though Anthropic's actual API response does include
     * them — cast to access them rather than letting a stale type
     * definition silently under-count real cached-token usage.
     *
     * Folded into promptTokens/totalTokens here so nothing downstream
     * breaks, but this means the cost this project CALCULATES/DISPLAYS
     * (lib/billing/pricing.ts, which only knows "input tokens" at the
     * flat rate) will slightly OVERSTATE true cost after this change —
     * a cache-read token actually bills at ~10% of the input rate, not
     * the full rate this counts it at. Direction of error is safe (not
     * undercharging), but if precise customer-facing billing matters,
     * pricing.ts and the usage-recording path would need to be
     * extended to track the cache-creation/cache-read breakdown
     * separately — not done here, flagged as a known follow-up rather
     * than silently left inaccurate.
     */
    const rawUsage = response.usage as
      | (Anthropic.Messages.Usage & {
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        })
      | undefined;

    const usage = rawUsage
      ? {
          promptTokens:
            rawUsage.input_tokens +
            (rawUsage.cache_creation_input_tokens ?? 0) +
            (rawUsage.cache_read_input_tokens ?? 0),
          completionTokens: rawUsage.output_tokens,
          totalTokens:
            rawUsage.input_tokens +
            (rawUsage.cache_creation_input_tokens ?? 0) +
            (rawUsage.cache_read_input_tokens ?? 0) +
            rawUsage.output_tokens,
        }
      : null;

    return {
      content: textContent,
      toolCalls,
      usage,
    };
  },
};

/**
 * Convert the common message list into Anthropic's format.
 *
 * Anthropic requires:
 * - The system prompt passed as a separate top-level `system` string,
 *   not as a message with role "system".
 * - Strictly alternating user/assistant turns — there is no "tool"
 *   role. Tool results are represented as `tool_result` content blocks
 *   inside a user-role message.
 *
 * Our common message list (built by lib/agent/run.ts / chat.ts) pushes
 * one role: "tool" LlmMessage per tool call, back to back, whenever
 * multiple tools were called in the same assistant turn. Those need to
 * be merged into a single Anthropic user message containing multiple
 * tool_result blocks, or Anthropic will reject the non-alternating
 * consecutive user turns.
 */
function toAnthropicMessages(messages: LlmMessage[]): {
  system: string;
  messages: Anthropic.Messages.MessageParam[];
} {
  const systemParts: string[] = [];
  const result: Anthropic.Messages.MessageParam[] = [];

  let pendingToolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

  function flushPendingToolResults() {
    if (pendingToolResults.length === 0) {
      return;
    }

    result.push({
      role: "user",
      content: pendingToolResults,
    });

    pendingToolResults = [];
  }

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) {
        systemParts.push(message.content);
      }
      continue;
    }

    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content ?? "",
      });
      continue;
    }

    // Any non-tool message ends a run of tool results.
    flushPendingToolResults();

    if (message.role === "assistant") {
      const contentBlocks: Array<
        | Anthropic.Messages.TextBlockParam
        | Anthropic.Messages.ToolUseBlockParam
      > = [];

      if (message.content) {
        contentBlocks.push({
          type: "text",
          text: message.content,
        });
      }

      for (const toolCall of message.toolCalls ?? []) {
        let input: Record<string, any> = {};

        try {
          input = JSON.parse(toolCall.arguments || "{}");
        } catch {
          input = {};
        }

        contentBlocks.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input,
        });
      }

      // Anthropic rejects an assistant message with empty content.
      if (contentBlocks.length === 0) {
        contentBlocks.push({ type: "text", text: "" });
      }

      result.push({
        role: "assistant",
        content: contentBlocks,
      });

      continue;
    }

    // role === "user"
    result.push({
      role: "user",
      content: message.content ?? "",
    });
  }

  flushPendingToolResults();

  return {
    system: systemParts.join("\n\n"),
    messages: result,
  };
}
