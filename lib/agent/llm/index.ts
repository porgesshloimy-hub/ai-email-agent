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
 * Which environment variable each provider's adapter actually reads its
 * API key from (see lib/agent/llm/{openai,anthropic,mistral}.ts).
 *
 * Kept here rather than duplicated at every call site, so
 * isProviderConfigured() is the one place that knows the mapping.
 */
const REQUIRED_ENV_VAR_BY_PROVIDER: Record<AIProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

/**
 * Whether the given provider's API key is actually present in this
 * deployment's environment.
 *
 * This exists because of a real incident: a tenant selected Claude
 * Haiku 4.5 on the Agent dashboard before ANTHROPIC_API_KEY had been
 * added to the production environment. lib/agent/models.ts's
 * resolveModelSelection() only validates that a (provider, model) pair
 * is a real catalog entry — it has no way to know whether that
 * provider's key is actually configured in this environment, and
 * intentionally doesn't import env/credential concerns (see that
 * file's module comment). Every email that tenant received failed
 * outright: the Anthropic SDK threw "Could not resolve authentication
 * method" mid-run, which the outer catch in lib/agent/run.ts recorded
 * as a failed email_actions row — no reply, no draft, no visible
 * explanation to the tenant.
 *
 * Called from two places: app/dashboard/agent/actions.ts's
 * saveModelSelection (reject the save up front with a clear error) and
 * lib/agent/run.ts / lib/agent/chat.ts (defensive fallback in case a
 * key is later removed from the environment after a tenant already
 * saved that selection).
 */
export function isProviderConfigured(
  provider: AIProvider
): boolean {
  const envVarName = REQUIRED_ENV_VAR_BY_PROVIDER[provider];
  const value = process.env[envVarName];

  return typeof value === "string" && value.trim().length > 0;
}

export function getRequiredEnvVarName(
  provider: AIProvider
): string {
  return REQUIRED_ENV_VAR_BY_PROVIDER[provider];
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