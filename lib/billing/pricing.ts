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

  /**
   * Legacy models still supported by the application.
   */
  "gpt-4o": {
    input: 2.5,
    output: 10.0,
  },

  "gpt-4o-mini": {
    input: 0.15,
    output: 0.6,
  },
};

/**
 * Calculate the actual OpenAI provider cost for a request.
 *
 * Returns the raw provider cost only.
 * The customer markup is applied separately by meter.ts.
 */
export function calculateOpenAICost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = OPENAI_PRICING_PER_1M_TOKENS[model];

  if (!pricing) {
    throw new Error(
      `Unknown OpenAI model "${model}". Add its pricing to OPENAI_PRICING_PER_1M_TOKENS before recording usage.`
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