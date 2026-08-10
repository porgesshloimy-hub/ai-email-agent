import { createServiceSupabase } from "@/lib/supabase/server";
import { stripe } from "@/lib/billing/stripe";

type UsageService = "openai" | "twilio_sms" | "storage" | "other";

interface RecordUsageInput {
  tenantId: string;
  service: UsageService;
  description: string;
  quantity: number;
  unit: string;
  rawCostUsd: number;
}

/**
 * The single entry point for logging any billable unit of work. Every
 * metered service in the app (OpenAI calls, SMS sends, storage) should
 * funnel through this function rather than writing to usage_events
 * directly, so the markup formula only lives in one place.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  const supabase = createServiceSupabase();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("usage_markup_percent, stripe_customer_id, stripe_subscription_item_id")
    .eq("id", input.tenantId)
    .single();

  const markupPercent = tenant?.usage_markup_percent ?? 3.0;
  const billedCostUsd = applyMarkup(input.rawCostUsd, markupPercent);

  const { data: event } = await supabase
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

  // Report to Stripe immediately if the tenant has billing set up. If not
  // (e.g. still on a trial, hasn't added a payment method yet), the usage
  // is still recorded locally — reconcileUnreportedUsage() can catch it up
  // later, or it stays informational-only until they do.
  if (tenant?.stripe_customer_id && event) {
    await reportUsageToStripe(tenant.stripe_customer_id, billedCostUsd, event.id);
  }
}

/**
 * Formula lives here, in exactly one place: raw cost + a percentage markup
 * (e.g. 3% to cover payment processing fees). Extend this if you want
 * tiered markups, a flat per-event fee on top of the percentage, etc. —
 * but keep it a pure function so it's easy to test against known inputs.
 */
export function applyMarkup(rawCostUsd: number, markupPercent: number): number {
  return rawCostUsd * (1 + markupPercent / 100);
}

/**
 * Stripe's Billing Meters API (their current usage-based billing model,
 * replacing the older subscription-item usage_records approach) bills in
 * whole integer units against a Price you configure as "$0.01 per unit" —
 * so a $0.037 charge gets reported as 4 units (rounded) via a meter event.
 * This keeps one meter usable for every service (OpenAI, SMS, storage)
 * instead of needing a separate meter per resource type, since everything
 * is normalized to cents before reporting.
 *
 * Meter events are scoped by Stripe customer id, not by subscription item —
 * Stripe automatically matches the event to whichever of the customer's
 * active subscription items uses that meter. You still need a subscription
 * with a metered Price attached to the "usage_cost_cents" meter for billing
 * to actually happen; the meter event alone just records usage.
 *
 * Verify the exact method name/shape against the `stripe` package version
 * you install — this is a newer part of Stripe's API and has had naming
 * changes across SDK versions (some versions expose this as
 * stripe.billing.meterEvents.create, others as a top-level
 * stripe.v2.billing.meterEvents.create). Check your installed version's
 * TypeScript types before deploying.
 */
async function reportUsageToStripe(stripeCustomerId: string, billedCostUsd: number, eventId: string) {
  const cents = Math.round(billedCostUsd * 100);
  if (cents <= 0) return; // nothing to report for near-zero-cost events

  const supabase = createServiceSupabase();

  try {
    await stripe.billing.meterEvents.create({
      event_name: "usage_cost_cents",
      payload: {
        stripe_customer_id: stripeCustomerId,
        value: String(cents),
      },
      identifier: eventId, // idempotency key — prevents double-billing on retries
    });

    await supabase.from("usage_events").update({ stripe_reported: true }).eq("id", eventId);
  } catch (err) {
    // Don't throw — a Stripe reporting failure shouldn't break the agent
    // action that triggered it. Leave stripe_reported = false so
    // reconcileUnreportedUsage() can retry it later.
    console.error(`Failed to report usage event ${eventId} to Stripe:`, err);
  }
}

/**
 * Catch-up job: finds any usage_events that were never successfully
 * reported (Stripe outage, missing subscription at the time, etc.) and
 * retries them. Run this on a schedule via Inngest — see
 * lib/inngest/functions.ts.
 */
export async function reconcileUnreportedUsage(tenantId: string): Promise<{ retried: number }> {
  const supabase = createServiceSupabase();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("stripe_customer_id")
    .eq("id", tenantId)
    .single();

  if (!tenant?.stripe_customer_id) return { retried: 0 };

  const { data: unreported } = await supabase
    .from("usage_events")
    .select("id, billed_cost_usd")
    .eq("tenant_id", tenantId)
    .eq("stripe_reported", false);

  for (const event of unreported ?? []) {
    await reportUsageToStripe(tenant.stripe_customer_id, event.billed_cost_usd, event.id);
  }

  return { retried: unreported?.length ?? 0 };
}
