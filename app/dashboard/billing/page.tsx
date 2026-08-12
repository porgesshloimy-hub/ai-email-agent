import {
  createServerSupabase,
  createServiceSupabase,
} from "@/lib/supabase/server";

export default async function BillingPage() {
  const userSupabase = await createServerSupabase();

  const {
    data: { user },
  } = await userSupabase.auth.getUser();

  if (!user) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-12">
        <div className="mx-auto max-w-5xl">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <h1 className="text-xl font-semibold text-slate-900">
              Usage & billing
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              Please sign in to view your billing information.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const supabase = createServiceSupabase();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, stripe_customer_id")
    .eq("owner_user_id", user.id)
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
    (acc, event) => {
      const billed = Number(event.billed_cost_usd) || 0;

      acc.billed += billed;

      acc.byService[event.service] =
        (acc.byService[event.service] ?? 0) + billed;

      return acc;
    },
    {
      billed: 0,
      byService: {} as Record<string, number>,
    }
  );

  const aiProcessing = totals.byService.openai ?? 0;

  const otherServices = Object.entries(totals.byService).filter(
    ([service]) => service !== "openai"
  );

  const monthName = startOfMonth.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500">
                Account
              </p>

              <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-900">
                Usage & billing
              </h1>

              <p className="mt-2 text-sm text-slate-500">
                View your AI usage and current month charges.
              </p>
            </div>

            <div className="text-sm text-slate-500">
              {monthName}
            </div>
          </div>
        </div>

        {/* Billing status */}
        <div className="mb-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-4 px-6 py-5">
            <div className="flex items-center gap-4">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-full ${
                  tenant?.stripe_customer_id
                    ? "bg-emerald-50"
                    : "bg-amber-50"
                }`}
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    tenant?.stripe_customer_id
                      ? "bg-emerald-500"
                      : "bg-amber-500"
                  }`}
                />
              </div>

              <div>
                <p className="text-sm font-semibold text-slate-900">
                  Billing status
                </p>

                <p className="mt-0.5 text-sm text-slate-500">
                  {tenant?.stripe_customer_id
                    ? "Your account is connected to billing."
                    : "Billing is not connected yet."}
                </p>
              </div>
            </div>

            <div
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                tenant?.stripe_customer_id
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-amber-50 text-amber-700"
              }`}
            >
              {tenant?.stripe_customer_id
                ? "Active"
                : "Not connected"}
            </div>
          </div>

          {!tenant?.stripe_customer_id && (
            <div className="border-t border-amber-100 bg-amber-50/60 px-6 py-4">
              <p className="text-sm leading-6 text-amber-800">
                Usage is currently being tracked. Charges will begin once
                billing is connected.
              </p>
            </div>
          )}
        </div>

        {/* Current usage */}
        <section className="mb-6">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-6 py-5">
              <p className="text-sm font-medium text-slate-500">
                Current month
              </p>

              <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
                <h2 className="text-4xl font-bold tracking-tight text-slate-900">
                  {formatCurrency(totals.billed)}
                </h2>

                <span className="text-sm text-slate-500">
                  total usage
                </span>
              </div>
            </div>

            {/* Usage breakdown */}
            <div className="divide-y divide-slate-100">
              <UsageRow
                name="AI processing"
                description="Email analysis and response generation"
                amount={aiProcessing}
                featured
              />

              {otherServices.map(([service, amount]) => (
                <UsageRow
                  key={service}
                  name={formatServiceName(service)}
                  amount={amount}
                />
              ))}

              {Object.keys(totals.byService).length === 0 && (
                <div className="px-6 py-10 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      className="text-slate-400"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 6v6l4 2"
                      />
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                  </div>

                  <p className="mt-4 text-sm font-medium text-slate-700">
                    No usage recorded yet
                  </p>

                  <p className="mt-1 text-sm text-slate-500">
                    Your usage for this month will appear here.
                  </p>
                </div>
              )}
            </div>

            {/* Total */}
            {Object.keys(totals.byService).length > 0 && (
              <div className="border-t border-slate-200 bg-slate-50/70 px-6 py-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-700">
                    Total
                  </span>

                  <span className="text-lg font-bold text-slate-900">
                    {formatCurrency(totals.billed)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Pricing explanation */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100">
              <svg
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <circle cx="12" cy="12" r="9" />
                <path
                  strokeLinecap="round"
                  d="M12 10v6"
                />
                <path
                  strokeLinecap="round"
                  d="M12 7.5h.01"
                />
              </svg>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Usage-based billing
              </h3>

              <p className="mt-1 text-sm leading-6 text-slate-500">
                Your charges are based on the services used by your
                account. AI processing is calculated based on the amount
                of processing required for your emails, so your cost
                scales naturally with your usage.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function UsageRow({
  name,
  description,
  amount,
  featured = false,
}: {
  name: string;
  description?: string;
  amount: number;
  featured?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-6 py-5">
      <div className="flex min-w-0 items-center gap-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            featured ? "bg-slate-900" : "bg-slate-100"
          }`}
        >
          {featured ? (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="text-white"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3l2.7 5.46L21 9.38l-4.5 4.38L17.56 20 12 17.08 6.44 20l1.06-6.24L3 9.38l6.3-.92L12 3z"
              />
            </svg>
          ) : (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="text-slate-500"
            >
              <circle cx="12" cy="12" r="8.5" />
              <path
                strokeLinecap="round"
                d="M12 7v5l3 2"
              />
            </svg>
          )}
        </div>

        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">
            {name}
          </p>

          {description && (
            <p className="mt-0.5 text-sm text-slate-500">
              {description}
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold text-slate-900">
          {formatCurrency(amount)}
        </p>
      </div>
    </div>
  );
}

function formatCurrency(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    return "$0.00";
  }

  /*
   * Very small usage amounts can otherwise all appear as $0.00.
   * Show enough precision to make small AI-processing charges
   * meaningful while keeping normal charges clean.
   */
  if (amount < 0.01) {
    return `$${amount.toFixed(4)}`;
  }

  if (amount < 1) {
    return `$${amount.toFixed(2)}`;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
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