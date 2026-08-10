/**
 * Raw provider costs, in USD. These are what YOU pay the provider — not
 * what you charge the customer. Markup gets applied on top in meter.ts.
 *
 * Check these against current pricing before relying on them for real
 * billing — providers change prices without much notice, and this file
 * won't update itself.
 */

export const OPENAI_PRICING_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export function calculateOpenAICost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = OPENAI_PRICING_PER_1M_TOKENS[model] ?? OPENAI_PRICING_PER_1M_TOKENS["gpt-4o"];
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

// Twilio SMS: US/Canada segment price. International rates vary — extend
// this if you send SMS outside the US.
export const TWILIO_SMS_COST_PER_SEGMENT = 0.0079;

export function calculateSmsCost(segments: number): number {
  return segments * TWILIO_SMS_COST_PER_SEGMENT;
}

// Supabase Storage: approximate per-GB-month cost beyond any free tier.
export const STORAGE_COST_PER_GB_MONTH = 0.021;

export function calculateStorageCost(gbStored: number, fractionOfMonth: number): number {
  return gbStored * STORAGE_COST_PER_GB_MONTH * fractionOfMonth;
}
