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
      <main style={styles.page}>
        <div style={styles.container}>
          <div style={styles.card}>
            <h1 style={styles.title}>Usage & billing</h1>
            <p style={styles.muted}>
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

  const hasUsage = Object.keys(totals.byService).length > 0;

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        {/* Header */}
        <header style={styles.header}>
          <div>
            <div style={styles.eyebrow}>ACCOUNT</div>

            <h1 style={styles.title}>Usage & billing</h1>

            <p style={styles.subtitle}>
              View your current usage and charges.
            </p>
          </div>

          <div style={styles.monthBadge}>{monthName}</div>
        </header>

        {/* Billing status */}
        <section style={styles.statusCard}>
          <div style={styles.statusLeft}>
            <div
              style={{
                ...styles.statusIcon,
                backgroundColor: tenant?.stripe_customer_id
                  ? "#ecfdf5"
                  : "#fffbeb",
              }}
            >
              <div
                style={{
                  ...styles.statusDot,
                  backgroundColor: tenant?.stripe_customer_id
                    ? "#10b981"
                    : "#f59e0b",
                }}
              />
            </div>

            <div>
              <div style={styles.statusTitle}>Billing status</div>

              <div style={styles.statusDescription}>
                {tenant?.stripe_customer_id
                  ? "Your account is connected and ready for billing."
                  : "Billing is not connected yet."}
              </div>
            </div>
          </div>

          <div
            style={{
              ...styles.statusBadge,
              color: tenant?.stripe_customer_id
                ? "#047857"
                : "#b45309",
              backgroundColor: tenant?.stripe_customer_id
                ? "#ecfdf5"
                : "#fffbeb",
            }}
          >
            {tenant?.stripe_customer_id ? "Active" : "Not connected"}
          </div>
        </section>

        {/* Main usage card */}
        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardEyebrow}>CURRENT MONTH</div>

              <div style={styles.totalRow}>
                <h2 style={styles.total}>
                  {formatCurrency(totals.billed)}
                </h2>

                <span style={styles.totalLabel}>total usage</span>
              </div>
            </div>

            <div style={styles.calendarIcon}>
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <rect
                  x="3"
                  y="4"
                  width="18"
                  height="17"
                  rx="3"
                />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </div>
          </div>

          {/* Usage breakdown */}
          <div style={styles.breakdown}>
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

            {!hasUsage && (
              <div style={styles.emptyState}>
                <div style={styles.emptyIcon}>
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path
                      strokeLinecap="round"
                      d="M12 7v5l3 2"
                    />
                  </svg>
                </div>

                <div style={styles.emptyTitle}>
                  No usage recorded yet
                </div>

                <div style={styles.emptyText}>
                  Your usage for this month will appear here.
                </div>
              </div>
            )}
          </div>

          {/* Total */}
          {hasUsage && (
            <div style={styles.totalFooter}>
              <span style={styles.totalFooterLabel}>Total</span>

              <span style={styles.totalFooterAmount}>
                {formatCurrency(totals.billed)}
              </span>
            </div>
          )}
        </section>

        {/* How billing works */}
        <section style={styles.infoCard}>
          <div style={styles.infoIcon}>
            <svg
              width="20"
              height="20"
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
            <h3 style={styles.infoTitle}>
              Usage-based billing
            </h3>

            <p style={styles.infoText}>
              Your charges are based on the services used by
              your account. AI processing scales with the amount
              of work required to handle your emails, so you only
              pay for the usage you generate.
            </p>
          </div>
        </section>

        {!tenant?.stripe_customer_id && (
          <div style={styles.notice}>
            <div style={styles.noticeIcon}>!</div>

            <div>
              <div style={styles.noticeTitle}>
                Billing isn't connected yet
              </div>

              <div style={styles.noticeText}>
                Your usage is being tracked. Charges will begin
                once billing is connected.
              </div>
            </div>
          </div>
        )}

        <div style={styles.footer}>
          Usage is calculated automatically and updated as your
          account processes emails.
        </div>
      </div>
    </main>
  );
}


/* ============================================================
   Usage Row
   ============================================================ */

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
    <div style={styles.usageRow}>
      <div style={styles.usageLeft}>
        <div
          style={{
            ...styles.serviceIcon,
            backgroundColor: featured
              ? "#0f172a"
              : "#f1f5f9",
            color: featured ? "#ffffff" : "#64748b",
          }}
        >
          {featured ? (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3l2.7 5.46L21 9.38l-4.5 4.38L17.56 20 12 17.08 6.44 20l1.06-6.24L3 9.38 9.3 8.46 12 3z"
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
            >
              <circle cx="12" cy="12" r="8.5" />
              <path
                strokeLinecap="round"
                d="M12 7v5l3 2"
              />
            </svg>
          )}
        </div>

        <div>
          <div style={styles.serviceName}>{name}</div>

          {description && (
            <div style={styles.serviceDescription}>
              {description}
            </div>
          )}
        </div>
      </div>

      <div style={styles.serviceAmount}>
        {formatCurrency(amount)}
      </div>
    </div>
  );
}


/* ============================================================
   Currency Formatting
   ============================================================ */

function formatCurrency(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    return "$0.00";
  }

  /*
   * AI usage can be less than one cent.
   * Show additional precision for very small amounts so
   * the customer can actually see their usage.
   */
  if (amount < 0.001) {
    return `$${amount.toFixed(5)}`;
  }

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


/* ============================================================
   Service Names
   ============================================================ */

function formatServiceName(service: string): string {
  const names: Record<string, string> = {
    openai: "AI processing",
    twilio_sms: "SMS notifications",
    storage: "Document storage",
    other: "Other",
  };

  return names[service] ?? service;
}


/* ============================================================
   Styles
   ============================================================ */

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f8fafc",
    color: "#0f172a",
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: "48px 24px 64px",
  },

  container: {
    width: "100%",
    maxWidth: "900px",
    margin: "0 auto",
  },

  header: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: "24px",
    marginBottom: "28px",
  },

  eyebrow: {
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.12em",
    color: "#64748b",
    marginBottom: "8px",
  },

  title: {
    margin: 0,
    fontSize: "32px",
    lineHeight: 1.15,
    fontWeight: 750,
    letterSpacing: "-0.025em",
    color: "#0f172a",
  },

  subtitle: {
    margin: "9px 0 0",
    fontSize: "15px",
    lineHeight: 1.5,
    color: "#64748b",
  },

  monthBadge: {
    flexShrink: 0,
    padding: "9px 14px",
    borderRadius: "10px",
    border: "1px solid #e2e8f0",
    background: "#ffffff",
    color: "#475569",
    fontSize: "13px",
    fontWeight: 600,
    boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
  },

  card: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "18px",
    boxShadow: "0 4px 16px rgba(15, 23, 42, 0.04)",
    overflow: "hidden",
    marginBottom: "18px",
  },

  statusCard: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "20px",
    padding: "18px 20px",
    marginBottom: "18px",
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "16px",
    boxShadow: "0 2px 8px rgba(15, 23, 42, 0.03)",
  },

  statusLeft: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
  },

  statusIcon: {
    width: "42px",
    height: "42px",
    borderRadius: "12px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  statusDot: {
    width: "9px",
    height: "9px",
    borderRadius: "50%",
  },

  statusTitle: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#0f172a",
  },

  statusDescription: {
    marginTop: "3px",
    fontSize: "13px",
    color: "#64748b",
  },

  statusBadge: {
    flexShrink: 0,
    padding: "6px 10px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 700,
  },

  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "25px 26px 23px",
    borderBottom: "1px solid #f1f5f9",
  },

  cardEyebrow: {
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.1em",
    color: "#94a3b8",
    marginBottom: "8px",
  },

  totalRow: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
  },

  total: {
    margin: 0,
    fontSize: "42px",
    lineHeight: 1,
    fontWeight: 750,
    letterSpacing: "-0.04em",
    color: "#0f172a",
  },

  totalLabel: {
    fontSize: "13px",
    color: "#94a3b8",
    fontWeight: 500,
  },

  calendarIcon: {
    width: "44px",
    height: "44px",
    borderRadius: "12px",
    background: "#f8fafc",
    color: "#64748b",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  breakdown: {
    width: "100%",
  },

  usageRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "20px",
    padding: "20px 26px",
    borderBottom: "1px solid #f1f5f9",
  },

  usageLeft: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    minWidth: 0,
  },

  serviceIcon: {
    flexShrink: 0,
    width: "40px",
    height: "40px",
    borderRadius: "11px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  serviceName: {
    fontSize: "14px",
    fontWeight: 650,
    color: "#0f172a",
  },

  serviceDescription: {
    marginTop: "3px",
    fontSize: "13px",
    color: "#64748b",
  },

  serviceAmount: {
    flexShrink: 0,
    fontSize: "14px",
    fontWeight: 700,
    color: "#0f172a",
  },

  totalFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "19px 26px",
    background: "#f8fafc",
  },

  totalFooterLabel: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#475569",
  },

  totalFooterAmount: {
    fontSize: "18px",
    fontWeight: 750,
    color: "#0f172a",
  },

  emptyState: {
    padding: "50px 24px",
    textAlign: "center",
  },

  emptyIcon: {
    width: "48px",
    height: "48px",
    margin: "0 auto",
    borderRadius: "14px",
    background: "#f1f5f9",
    color: "#94a3b8",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  emptyTitle: {
    marginTop: "15px",
    fontSize: "14px",
    fontWeight: 650,
    color: "#475569",
  },

  emptyText: {
    marginTop: "4px",
    fontSize: "13px",
    color: "#94a3b8",
  },

  infoCard: {
    display: "flex",
    gap: "15px",
    padding: "22px 24px",
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "16px",
    boxShadow: "0 2px 8px rgba(15, 23, 42, 0.03)",
    marginBottom: "18px",
  },

  infoIcon: {
    flexShrink: 0,
    width: "40px",
    height: "40px",
    borderRadius: "11px",
    background: "#f1f5f9",
    color: "#64748b",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  infoTitle: {
    margin: "1px 0 0",
    fontSize: "14px",
    fontWeight: 700,
    color: "#0f172a",
  },

  infoText: {
    margin: "5px 0 0",
    fontSize: "13px",
    lineHeight: 1.65,
    color: "#64748b",
  },

  notice: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    padding: "15px 17px",
    background: "#fffbeb",
    border: "1px solid #fde68a",
    borderRadius: "14px",
    marginBottom: "18px",
  },

  noticeIcon: {
    width: "22px",
    height: "22px",
    flexShrink: 0,
    borderRadius: "50%",
    background: "#f59e0b",
    color: "#ffffff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "12px",
    fontWeight: 800,
  },

  noticeTitle: {
    fontSize: "13px",
    fontWeight: 700,
    color: "#92400e",
  },

  noticeText: {
    marginTop: "3px",
    fontSize: "13px",
    lineHeight: 1.5,
    color: "#a16207",
  },

  muted: {
    marginTop: "8px",
    fontSize: "14px",
    color: "#64748b",
  },

  footer: {
    textAlign: "center",
    paddingTop: "8px",
    fontSize: "12px",
    color: "#94a3b8",
  },
};