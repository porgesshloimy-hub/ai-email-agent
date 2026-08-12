import { createServiceSupabase } from "@/lib/supabase/server";
import { stripe } from "@/lib/billing/stripe";

type UsageService =
  | "openai"
  | "twilio_sms"
  | "storage"
  | "other";

interface RecordUsageInput {
  tenantId: string;
  service: UsageService;
  description: string;
  quantity: number;
  unit: string;
  rawCostUsd: number;
}

/**
 * Customer usage pricing.
 *
 * The customer-facing billed amount is the actual underlying
 * service cost plus 5%.
 *
 * The 5% is incorporated directly into the billed price and is
 * not presented to the customer as a separate fee or markup.
 */
const BILLING_RATE_MULTIPLIER = 1.05;

/**
 * Single entry point for recording billable usage.
 *
 * Every metered service in the app should go through this function
 * rather than writing directly to usage_events.
 */
export async function recordUsage(
  input: RecordUsageInput
): Promise<void> {
  const supabase = createServiceSupabase();

  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select(
      "stripe_customer_id, stripe_subscription_item_id"
    )
    .eq("id", input.tenantId)
    .single();

  if (tenantError) {
    console.error(
      "Failed to load tenant for usage recording:",
      tenantError
    );
  }

  /**
   * Calculate the customer-facing price.
   *
   * rawCostUsd = actual underlying service cost
   * billedCostUsd = customer price
   *
   * Example:
   *
   * $0.005 raw cost
   * → $0.00525 billed cost
   */
  const billedCostUsd = applyMarkup(input.rawCostUsd);

  const { data: event, error: usageError } = await supabase
    .from("usage_events")
    .insert({
      tenant_id: input.tenantId,
      service: input.service,
      description: input.description,
      quantity: input.quantity,
      unit: input.unit,
      raw_cost_usd: input.rawCostUsd,
      billed_cost_usd: billedCostUsd,
    })
    .select()
    .single();

  if (usageError) {
    console.error(
      "Failed to record usage event:",
      usageError
    );

    throw new Error("Failed to record usage");
  }

  /**
   * Report the customer-facing amount to Stripe.
   *
   * If Stripe isn't connected yet, the usage remains recorded
   * locally and can be reconciled later.
   */
  if (tenant?.stripe_customer_id && event) {
    await reportUsageToStripe(
      tenant.stripe_customer_id,
      billedCostUsd,
      event.id
    );
  }
}

/**
 * Converts the underlying service cost into the customer price.
 *
 * The 5% is built into the final price rather than displayed
 * as a separate line item or fee.
 */
export function applyMarkup(
  rawCostUsd: number
): number {
  return rawCostUsd * BILLING_RATE_MULTIPLIER;
}

/**
 * Report usage to Stripe's Billing Meters API.
 *
 * Stripe receives the customer-facing amount in cents.
 *
 * Example:
 *
 * $0.037 billed cost
 * → 4 cents reported to Stripe
 */
async function reportUsageToStripe(
  stripeCustomerId: string,
  billedCostUsd: number,
  eventId: string
) {
  const cents = Math.round(billedCostUsd * 100);

  /**
   * Extremely small usage events may round to zero cents.
   *
   * We still keep the event in our database so the usage history
   * remains accurate. It simply isn't sent individually to Stripe.
   */
  if (cents <= 0) {
    return;
  }

  const supabase = createServiceSupabase();

  try {
    await stripe.billing.meterEvents.create({
      event_name: "usage_cost_cents",
      payload: {
        stripe_customer_id: stripeCustomerId,
        value: String(cents),
      },
      identifier: eventId,
    });

    await supabase
      .from("usage_events")
      .update({
        stripe_reported: true,
      })
      .eq("id", eventId);
  } catch (err) {
    /**
     * Stripe reporting failures should not break the agent action.
     *
     * The usage event remains marked as unreported so the
     * reconciliation job can retry it later.
     */
    console.error(
      `Failed to report usage event ${eventId} to Stripe:`,
      err
    );
  }
}

/**
 * Catch-up job for usage events that were not successfully
 * reported to Stripe.
 *
 * This can be called by your scheduled Inngest job.
 */
export async function reconcileUnreportedUsage(
  tenantId: string
): Promise<{ retried: number }> {
  const supabase = createServiceSupabase();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("stripe_customer_id")
    .eq("id", tenantId)
    .single();

  if (!tenant?.stripe_customer_id) {
    return {
      retried: 0,
    };
  }

  const { data: unreported, error } = await supabase
    .from("usage_events")
    .select("id, billed_cost_usd")
    .eq("tenant_id", tenantId)
    .eq("stripe_reported", false);

  if (error) {
    console.error(
      "Failed to load unreported usage events:",
      error
    );

    return {
      retried: 0,
    };
  }

  let retried = 0;

  for (const event of unreported ?? []) {
    await reportUsageToStripe(
      tenant.stripe_customer_id,
      Number(event.billed_cost_usd),
      event.id
    );

    retried++;
  }

  return {
    retried,
  };
}