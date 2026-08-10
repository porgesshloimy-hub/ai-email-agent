import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";

export default async function BillingPage() {
  const userSupabase = await createServerSupabase();
  const {
    data: { user },
  } = await userSupabase.auth.getUser();

  const supabase = createServiceSupabase(); // service role: usage_events has no insert/update policy for users, but does have a select policy — either client works for reading here, service role used for consistency with the rest of the app's server-side reads
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, usage_markup_percent, stripe_customer_id")
    .eq("owner_user_id", user?.id)
    .single();

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data: events } = await supabase
    .from("usage_events")
    .select("service, raw_cost_usd, billed_cost_usd")
    .eq("tenant_id", tenant?.id)
    .gte("occurred_at", startOfMonth.toISOString());

  const totals = (events ?? []).reduce(
    (acc, e) => {
      acc.raw += Number(e.raw_cost_usd);
      acc.billed += Number(e.billed_cost_usd);
      acc.byService[e.service] = (acc.byService[e.service] ?? 0) + Number(e.billed_cost_usd);
      return acc;
    },
    { raw: 0, billed: 0, byService: {} as Record<string, number> }
  );

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Usage & billing</h1>

      {!tenant?.stripe_customer_id && (
        <p style={{ background: "#fff8e1", padding: 12, borderRadius: 4 }}>
          Billing isn't connected yet — usage below is being tracked, but won't be charged until Stripe is set up.
        </p>
      )}

      <section style={{ marginBottom: 24 }}>
        <h2>This month so far</h2>
        <p style={{ fontSize: 28, margin: "4px 0" }}>${totals.billed.toFixed(2)}</p>
        <p style={{ fontSize: 13, color: "#666" }}>
          Includes a {tenant?.usage_markup_percent ?? 3}% service fee on ${totals.raw.toFixed(2)} of underlying usage
          cost.
        </p>
      </section>

      <section>
        <h2>By service</h2>
        <table style={{ width: "100%" }}>
          <tbody>
            {Object.entries(totals.byService).map(([service, cost]) => (
              <tr key={service}>
                <td style={{ padding: "4px 0" }}>{formatServiceName(service)}</td>
                <td style={{ textAlign: "right" }}>${cost.toFixed(2)}</td>
              </tr>
            ))}
            {Object.keys(totals.byService).length === 0 && (
              <tr>
                <td style={{ color: "#666" }}>No usage recorded yet this month.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function formatServiceName(service: string): string {
  const names: Record<string, string> = {
    openai: "AI processing",
    twilio_sms: "SMS notifications",
    storage: "Document storage",
    other: "Other",
  };
  return names[service] ?? service;
}
