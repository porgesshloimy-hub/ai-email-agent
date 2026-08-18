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

    const tools = request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Messages.Tool.InputSchema,
    }));

    const response = await anthropic.messages.create({
      model: request.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: system || undefined,
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

    const usage = response.usage
      ? {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens:
            response.usage.input_tokens +
            response.usage.output_tokens,
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
