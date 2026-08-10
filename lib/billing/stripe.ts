import Stripe from "stripe";

// Check the installed `stripe` package's docs for the current apiVersion
// string before deploying — Stripe versions its API by date and the SDK
// will warn/fail if this doesn't match what the package expects.
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
});
