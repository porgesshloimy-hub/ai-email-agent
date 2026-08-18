import OpenAI from "openai";

import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmMessage,
  LlmProviderAdapter,
  LlmToolCall,
} from "./types";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * OpenAI adapter.
 *
 * This is the thinnest of the three adapters, since the common
 * LlmMessage/LlmToolCall shape was modeled directly on OpenAI's
 * chat-completions format.
 */
export const openaiAdapter: LlmProviderAdapter = {
  async complete(
    request: LlmCompletionRequest
  ): Promise<LlmCompletionResult> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      request.messages.map(toOpenAIMessage);

    const tools:
      | OpenAI.Chat.Completions.ChatCompletionTool[]
      | undefined = request.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    const completion = await openai.chat.completions.create({
      model: request.model,
      messages,
      tools,
      tool_choice: tools && tools.length > 0 ? "auto" : undefined,
    });

    const assistantMessage = completion.choices[0]?.message;

    if (!assistantMessage) {
      throw new Error("OpenAI returned no assistant message");
    }

    const toolCalls: LlmToolCall[] = (
      assistantMessage.tool_calls ?? []
    )
      .filter(
        (
          call
        ): call is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & {
          type: "function";
        } => call.type === "function"
      )
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));

    const usage = completion.usage
      ? {
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens,
        }
      : null;

    return {
      content:
        typeof assistantMessage.content === "string"
          ? assistantMessage.content
          : null,
      toolCalls,
      usage,
    };
  },
};

function toOpenAIMessage(
  message: LlmMessage
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content ?? "",
    };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      })),
    };
  }

  if (message.role === "system") {
    return {
      role: "system",
      content: message.content ?? "",
    };
  }

  return {
    role: "user",
    content: message.content ?? "",
  };
}
