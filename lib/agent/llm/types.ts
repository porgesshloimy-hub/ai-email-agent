/**
 * Provider-agnostic chat/tool-calling types.
 *
 * lib/agent/run.ts and lib/agent/chat.ts are written against these
 * types instead of any single provider's SDK types, so the same agent
 * loop works unmodified against OpenAI, Anthropic, or Google — only the
 * adapter in lib/agent/llm/{openai,anthropic,google}.ts needs to know
 * about the specific wire format each provider expects.
 *
 * The shape intentionally mirrors OpenAI's chat-completions format
 * fairly closely (that's the format the original single-provider agent
 * loop was written against), since it's the simplest common
 * denominator to convert the other two providers into and out of.
 */

export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCall {
  /** Provider-assigned id for this tool call, echoed back on the tool result message. */
  id: string;
  name: string;
  /** JSON-encoded arguments, exactly as the model produced them. */
  arguments: string;
}

export interface LlmMessage {
  role: LlmRole;
  /** Plain assistant/user/system text. Null for a tool-call-only assistant turn. */
  content: string | null;
  /** Only present on assistant messages that invoked one or more tools. */
  toolCalls?: LlmToolCall[];
  /** Only present on role: "tool" messages — which tool call this result answers. */
  toolCallId?: string;
  /**
   * Only present on role: "tool" messages. Not required by OpenAI, but
   * Google's function-calling format needs the function name alongside
   * the result, not just an opaque call id.
   */
  name?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's parameters. */
  parameters: Record<string, any>;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmCompletionResult {
  /** Plain text response, if any. Can coexist with toolCalls for providers that allow both (rare) — callers should treat non-empty toolCalls as taking precedence. */
  content: string | null;
  toolCalls: LlmToolCall[];
  usage: LlmUsage | null;
}

export interface LlmCompletionRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
}

export interface LlmProviderAdapter {
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResult>;
}
