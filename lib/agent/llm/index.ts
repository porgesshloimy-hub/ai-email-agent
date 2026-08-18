import type { AIProvider } from "@/lib/agent/models";

import { openaiAdapter } from "./openai";
import { anthropicAdapter } from "./anthropic";
import { mistralAdapter } from "./mistral";

import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmProviderAdapter,
} from "./types";

export * from "./types";

/**
 * Resolve the adapter for a given AI provider.
 *
 * Every call site should go through this rather than importing a
 * specific adapter directly, so adding a new provider only requires
 * changes here + lib/agent/models.ts, not at every call site.
 */
export function getLlmAdapter(
  provider: AIProvider
): LlmProviderAdapter {
  switch (provider) {
    case "openai":
      return openaiAdapter;
    case "anthropic":
      return anthropicAdapter;
    case "mistral":
      return mistralAdapter;
    default: {
      // Exhaustiveness check: if AIProvider ever gains a member without
      // a corresponding case above, this line fails to typecheck.
      const exhaustiveCheck: never = provider;
      throw new Error(
        `No LLM adapter registered for provider "${exhaustiveCheck}"`
      );
    }
  }
}

/**
 * Convenience wrapper: run a single completion against whichever
 * provider/model the caller resolved (see lib/agent/models.ts's
 * resolveModelSelection). This is the one function lib/agent/run.ts and
 * lib/agent/chat.ts call — neither needs to know which SDK is actually
 * involved.
 */
export async function runChatCompletion(
  provider: AIProvider,
  request: LlmCompletionRequest
): Promise<LlmCompletionResult> {
  const adapter = getLlmAdapter(provider);
  return adapter.complete(request);
}
