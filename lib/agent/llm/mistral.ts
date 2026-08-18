import { Mistral } from "@mistralai/mistralai";

import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmMessage,
  LlmProviderAdapter,
  LlmToolCall,
} from "./types";

const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY ?? "",
});

/**
 * Mistral adapter.
 *
 * Mistral's chat completion API is deliberately OpenAI-compatible for
 * message roles and function/tool calling (system/user/assistant/tool
 * roles, tools as { type: "function", function: { name, description,
 * parameters } }, tool results referenced by tool_call_id), so this
 * adapter is structurally very close to lib/agent/llm/openai.ts. The
 * Mistral TypeScript SDK camelCases wire fields (toolCalls, toolCallId)
 * the same way the OpenAI SDK does.
 *
 * NOTE: this has been written against Mistral's published API/SDK
 * documentation but not exercised against a live account in this
 * environment. If tool calls don't round-trip correctly against a real
 * Mistral API key, check the exact casing of `toolCalls[].id` vs
 * `toolCalls[].function.{name,arguments}` in the SDK's response type
 * first — that's the most likely place a documentation-vs-runtime
 * mismatch would show up.
 */
export const mistralAdapter: LlmProviderAdapter = {
  async complete(
    request: LlmCompletionRequest
  ): Promise<LlmCompletionResult> {
    const messages = request.messages.map(toMistralMessage);

    const tools = request.tools?.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    const response = await mistral.chat.complete({
      model: request.model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      toolChoice: tools && tools.length > 0 ? "auto" : undefined,
    });

    const choice = response.choices?.[0];
    const assistantMessage = choice?.message;

    if (!assistantMessage) {
      throw new Error("Mistral returned no assistant message");
    }

    const toolCalls: LlmToolCall[] = (
      assistantMessage.toolCalls ?? []
    ).map((call) => ({
      id: call.id ?? "",
      name: call.function.name,
      arguments:
        typeof call.function.arguments === "string"
          ? call.function.arguments
          : JSON.stringify(call.function.arguments ?? {}),
    }));

    const usage = response.usage
      ? {
          promptTokens: response.usage.promptTokens ?? 0,
          completionTokens: response.usage.completionTokens ?? 0,
          totalTokens: response.usage.totalTokens ?? 0,
        }
      : null;

    const content =
      typeof assistantMessage.content === "string"
        ? assistantMessage.content
        : Array.isArray(assistantMessage.content)
        ? assistantMessage.content
            .map((chunk: any) =>
              typeof chunk === "string" ? chunk : chunk?.text ?? ""
            )
            .join("")
        : null;

    return {
      content,
      toolCalls,
      usage,
    };
  },
};

function toMistralMessage(message: LlmMessage): any {
  if (message.role === "tool") {
    return {
      role: "tool",
      toolCallId: message.toolCallId ?? "",
      name: message.name,
      content: message.content ?? "",
    };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      toolCalls: message.toolCalls?.map((call) => ({
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
