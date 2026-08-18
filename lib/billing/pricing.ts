/**
 * Raw provider costs, in USD.
 *
 * These are the approximate costs YOU pay the provider.
 * Customer pricing/markup is applied separately in meter.ts.
 *
 * IMPORTANT:
 * Keep these prices synchronized with the provider's current pricing.
 */

export const OPENAI_PRICING_PER_1M_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  /**
   * GPT-5 nano
   *
   * Input:  $0.05 / 1M tokens
   * Output: $0.40 / 1M tokens
   */
  "gpt-5-nano": {
    input: 0.05,
    output: 0.4,
  },
};

/**
 * Anthropic (Claude) pricing.
 *
 * Sourced from Anthropic's own launch posts:
 * - Claude Haiku 4.5: $1 / $5 per 1M input/output tokens
 *   (https://www.anthropic.com/news/claude-haiku-4-5)
 * - Claude Sonnet 4.6: unchanged from Sonnet 4.5, $3 / $15 per 1M
 *   input/output tokens (https://www.anthropic.com/news/claude-sonnet-4-6)
 *
 * Keep synchronized with https://www.anthropic.com/pricing.
 */
export const ANTHROPIC_PRICING_PER_1M_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  "claude-haiku-4-5": {
    input: 1.0,
    output: 5.0,
  },

  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
  },
};

/**
 * Mistral pricing.
 *
 * Mistral Small 4 (model id "mistral-small-2603"): $0.15 / $0.60 per 1M
 * input/output tokens, per Mistral's own model card
 * (https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03).
 *
 * Keep synchronized with https://mistral.ai/pricing/.
 */
export const MISTRAL_PRICING_PER_1M_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  "mistral-small-2603": {
    input: 0.15,
    output: 0.6,
  },
};

/**
 * Per-provider pricing tables, keyed the same way as
 * lib/agent/models.ts's AIProvider type. Kept as a lookup here (rather
 * than importing AIProvider from models.ts) so this module has no
 * dependency direction requirements on the model catalog.
 */
const PRICING_TABLES_BY_PROVIDER: Record<
  string,
  Record<string, { input: number; output: number }>
> = {
  openai: OPENAI_PRICING_PER_1M_TOKENS,
  anthropic: ANTHROPIC_PRICING_PER_1M_TOKENS,
  mistral: MISTRAL_PRICING_PER_1M_TOKENS,
};

/**
 * Calculate the actual OpenAI provider cost for a request.
 *
 * Returns the raw provider cost only.
 * The customer markup is applied separately by meter.ts.
 *
 * @deprecated Prefer calculateModelCost(), which works across every
 * supported provider. Kept because it's still a convenient direct call
 * for the two OpenAI-only embedding routes
 * (app/api/knowledge/upload/route.ts, app/api/knowledge/manual/route.ts)
 * that will never call a non-OpenAI model.
 */
export function calculateOpenAICost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  return calculateModelCost("openai", model, inputTokens, outputTokens);
}

/**
 * Calculate the actual provider cost for a chat completion, across any
 * supported AI provider (OpenAI, Anthropic, Google). Returns the raw
 * provider cost only — the customer markup is applied separately by
 * meter.ts.
 */
export function calculateModelCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const table = PRICING_TABLES_BY_PROVIDER[provider];

  if (!table) {
    throw new Error(
      `Unknown AI provider "${provider}". Add its pricing table to lib/billing/pricing.ts before recording usage.`
    );
  }

  const pricing = table[model];

  if (!pricing) {
    throw new Error(
      `Unknown ${provider} model "${model}". Add its pricing to lib/billing/pricing.ts before recording usage.`
    );
  }

  const safeInputTokens = Math.max(0, Number(inputTokens) || 0);
  const safeOutputTokens = Math.max(0, Number(outputTokens) || 0);

  const inputCost =
    (safeInputTokens / 1_000_000) * pricing.input;

  const outputCost =
    (safeOutputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}


// ------------------------------------------------------------
// Twilio
// ------------------------------------------------------------

/**
 * Twilio SMS cost per segment.
 *
 * This is currently configured for the US/Canada rate.
 * International SMS rates vary by destination.
 */
export const TWILIO_SMS_COST_PER_SEGMENT = 0.0079;

export function calculateSmsCost(segments: number): number {
  const safeSegments = Math.max(0, Number(segments) || 0);

  return safeSegments * TWILIO_SMS_COST_PER_SEGMENT;
}


// ------------------------------------------------------------
// Supabase Storage
// ------------------------------------------------------------

/**
 * Approximate Supabase Storage cost per GB-month
 * beyond any applicable free tier.
 */
export const STORAGE_COST_PER_GB_MONTH = 0.021;

export function calculateStorageCost(
  gbStored: number,
  fractionOfMonth: number
): number {
  const safeGbStored = Math.max(0, Number(gbStored) || 0);
  const safeFractionOfMonth = Math.max(
    0,
    Number(fractionOfMonth) || 0
  );

  return (
    safeGbStored *
    STORAGE_COST_PER_GB_MONTH *
    safeFractionOfMonth
  );
}