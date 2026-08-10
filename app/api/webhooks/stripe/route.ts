import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/billing/stripe";
import { createServiceSupabase } from "@/lib/supabase/server";
import type Stripe from "stripe";

/**
 * Handles the handful of Stripe events this app actually needs to react to.
 * Configure this URL in the Stripe dashboard (or via `stripe listen` for
 * local testing) and subscribe it to: checkout.session.completed,
 * customer.subscription.deleted.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = createServiceSupabase();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const tenantId = session.client_reference_id; // set this when creating the Checkout session
      if (tenantId && session.customer) {
        await supabase
          .from("tenants")
          .update({ stripe_customer_id: session.customer as string })
          .eq("id", tenantId);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      await supabase
        .from("tenants")
        .update({ stripe_subscription_item_id: null })
        .eq("stripe_customer_id", subscription.customer as string);
      break;
    }

    default:
      // Unhandled event types are fine to ignore — Stripe sends everything
      // you're subscribed to, not everything you need to act on.
      break;
  }

  return NextResponse.json({ received: true });
}
