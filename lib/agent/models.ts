/**
 * Multi-LLM model catalog.
 *
 * Single source of truth for which AI providers/models a tenant may
 * select for their agent, on both the client (dashboard dropdown,
 * app/dashboard/agent/page.tsx) and the server (validation in
 * app/dashboard/agent/actions.ts, model resolution in lib/agent/run.ts
 * and lib/agent/chat.ts).
 *
 * The catalog is intentionally a fixed, curated list of four models
 * (per product decision) rather than "every model a provider offers" —
 * keeps the dashboard dropdown small and keeps lib/billing/pricing.ts
 * only responsible for pricing models that are actually selectable.
 *
 * IMPORTANT: this file must stay free of server-only imports (no
 * supabase client, no "server-only" packages, no API keys) since the
 * client-side dashboard component imports it directly.
 *
 * Adding a new provider:
 * 1. Add it to AI_PROVIDERS + the AIProvider type below.
 * 2. Add its model(s) to MODEL_CATALOG.
 * 3. Add a pricing table entry in lib/billing/pricing.ts.
 * 4. Add an adapter in lib/agent/llm/ and wire it into
 *    lib/agent/llm/index.ts's getLlmAdapter().
 * 5. Add the provider's API key env var to .env.example.
 * 6. Update the ai_provider check constraint in db/schema.sql /
 *    a new migration.
 */

export type AIProvider = "openai" | "mistral" | "anthropic";

export const AI_PROVIDERS: AIProvider[] = [
  "openai",
  "mistral",
  "anthropic",
];

export interface ModelOption {
  /** The exact model id passed to the provider's API. */
  id: string;
  /** Human-readable model name shown in the dashboard, e.g. "GPT-5 nano". */
  label: string;
  /** Short tier name shown as the primary heading for this option, e.g. "Cheapest". */
  tier: string;
  /** Longer tier description shown under the tier name, e.g. "For simple email management and everyday tasks." */
  tierDescription: string;
  /** Whether this is the recommended default shown with a star in the dashboard. */
  recommended?: true;
  /** Whether this model supports tool/function calling. All catalog entries must — the agent pipeline requires it. */
  supportsTools: true;
}

export interface ProviderInfo {
  id: AIProvider;
  label: string;
  models: ModelOption[];
}

/**
 * Exactly the four selectable models, in the order they should appear
 * in the dashboard dropdown, each presented as a cost/capability tier
 * rather than a bare provider/model name:
 *
 * Cheapest    -> GPT-5 nano
 * Economy     -> Mistral Small 4
 * Balanced (Recommended) -> Claude Haiku 4.5
 * Advanced    -> Claude Sonnet 4.6
 */
export const MODEL_CATALOG: Record<AIProvider, ProviderInfo> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    models: [
      {
        id: "gpt-5-nano",
        label: "GPT-5 nano",
        tier: "Cheapest",
        tierDescription:
          "For simple email management and everyday tasks.",
        supportsTools: true,
      },
    ],
  },

  mistral: {
    id: "mistral",
    label: "Mistral",
    models: [
      {
        id: "mistral-small-2603",
        label: "Mistral Small 4",
        tier: "Economy",
        tierDescription:
          "A strong balance of intelligence and cost.",
        supportsTools: true,
      },
    ],
  },

  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    models: [
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        tier: "Balanced",
        tierDescription:
          "Better reasoning and instruction-following for more complex tasks.",
        recommended: true,
        supportsTools: true,
      },
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        tier: "Advanced",
        tierDescription:
          "Maximum capability for complex, multi-step work.",
        supportsTools: true,
      },
    ],
  },
};

/**
 * Flat, dashboard-ordered view of every selectable model across all
 * providers — this is the order the dropdown should render in
 * (Cheapest -> Economy -> Balanced -> Advanced), independent of how the
 * models happen to be grouped by provider above.
 */
export const MODEL_OPTIONS_IN_DISPLAY_ORDER: Array<
  ModelOption & { provider: AIProvider }
> = [
  { ...MODEL_CATALOG.openai.models[0], provider: "openai" },
  { ...MODEL_CATALOG.mistral.models[0], provider: "mistral" },
  { ...MODEL_CATALOG.anthropic.models[0], provider: "anthropic" },
  { ...MODEL_CATALOG.anthropic.models[1], provider: "anthropic" },
];

export const DEFAULT_AI_PROVIDER: AIProvider = "openai";
export const DEFAULT_AI_MODEL = "gpt-5-nano";

export function isValidProvider(
  provider: string
): provider is AIProvider {
  return (AI_PROVIDERS as string[]).includes(provider);
}

/**
 * Validate a (provider, model) pair against the catalog.
 *
 * Used both when a tenant saves a selection (actions.ts) and as a
 * defensive check before actually calling a provider (run.ts / chat.ts),
 * so a stale or hand-edited database row can never send an unrecognized
 * model id to a provider API.
 */
export function isValidModelSelection(
  provider: string,
  model: string
): boolean {
  if (!isValidProvider(provider)) {
    return false;
  }

  return MODEL_CATALOG[provider].models.some(
    (option) => option.id === model
  );
}

/**
 * Resolve a tenant's stored (provider, model) selection, falling back to
 * the default when the stored value is missing or no longer valid (e.g.
 * a model was retired from the catalog). Fail-safe, not fail-closed —
 * an invalid model selection should degrade to a working default rather
 * than block all agent processing.
 */
export function resolveModelSelection(
  provider: string | null | undefined,
  model: string | null | undefined
): { provider: AIProvider; model: string } {
  if (
    provider &&
    model &&
    isValidProvider(provider) &&
    isValidModelSelection(provider, model)
  ) {
    return { provider, model };
  }

  return {
    provider: DEFAULT_AI_PROVIDER,
    model: DEFAULT_AI_MODEL,
  };
}
