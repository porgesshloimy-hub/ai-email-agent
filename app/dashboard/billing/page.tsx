import {
  createServerSupabase,
  createServiceSupabase,
} from "@/lib/supabase/server";

import MonthSelector from "./MonthSelector";

interface BillingMonth {
  key: string;
  label: string;
  start: Date;
}

interface ActivityCounts {
  emailsProcessed: number;
  emailsDrafted: number;
  emailsSent: number;
  smsSent: number;
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
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

  const params = await searchParams;
  const supabase = createServiceSupabase();

  /*
   * --------------------------------------------------------
   * TENANT
   * --------------------------------------------------------
   */

  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id, stripe_customer_id")
    .eq("owner_user_id", user.id)
    .single();

  if (tenantError || !tenant) {
    return (
      <main style={styles.page}>
        <div style={styles.container}>
          <header style={styles.header}>
            <div>
              <div style={styles.eyebrow}>ACCOUNT</div>

              <h1 style={styles.title}>Usage & billing</h1>

              <p style={styles.subtitle}>
                View your account activity and charges.
              </p>
            </div>
          </header>

          <div style={styles.notice}>
            <div style={styles.noticeIcon}>!</div>

            <div>
              <div style={styles.noticeTitle}>
                Billing information unavailable
              </div>

              <div style={styles.noticeText}>
                We couldn't load your billing information right now.
                Please try again later.
              </div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  /*
   * --------------------------------------------------------
   * AVAILABLE MONTHS
   * --------------------------------------------------------
   *
   * Only months that actually contain usage or activity are
   * offered in the month selector.
   */

  const [
    { data: usageMonths },
    { data: actionMonths },
    { data: smsMonths },
  ] = await Promise.all([
    supabase
      .from("usage_events")
      .select("occurred_at")
      .eq("tenant_id", tenant.id)
      .order("occurred_at", { ascending: false }),

    supabase
      .from("email_actions")
      .select("created_at")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false }),

    supabase
      .from("usage_events")
      .select("occurred_at")
      .eq("tenant_id", tenant.id)
      .eq("service", "twilio_sms")
      .order("occurred_at", { ascending: false }),
  ]);

  const availableMonthKeys = new Set<string>();

  for (const row of usageMonths ?? []) {
    if (row.occurred_at) {
      availableMonthKeys.add(
        getMonthKey(new Date(row.occurred_at))
      );
    }
  }

  for (const row of actionMonths ?? []) {
    if (row.created_at) {
      availableMonthKeys.add(
        getMonthKey(new Date(row.created_at))
      );
    }
  }

  for (const row of smsMonths ?? []) {
    if (row.occurred_at) {
      availableMonthKeys.add(
        getMonthKey(new Date(row.occurred_at))
      );
    }
  }

  /*
   * Always include the current month.
   *
   * This allows a brand-new account to see the current month
   * even when it has no activity yet.
   */

  const now = new Date();
  const currentMonthKey = getMonthKey(now);

  availableMonthKeys.add(currentMonthKey);

  const availableMonths: BillingMonth[] = Array.from(
    availableMonthKeys
  )
    .map((key) => {
      const [year, month] = key.split("-").map(Number);

      const start = new Date(
        year,
        month - 1,
        1,
        0,
        0,
        0,
        0
      );

      return {
        key,
        label: start.toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        }),
        start,
      };
    })
    .sort(
      (a, b) =>
        b.start.getTime() -
        a.start.getTime()
    );

  /*
   * --------------------------------------------------------
   * SELECTED MONTH
   * --------------------------------------------------------
   */

  const selectedMonth =
    params.month &&
    availableMonths.some(
      (month) => month.key === params.month
    )
      ? params.month
      : currentMonthKey;

  const selectedMonthInfo =
    availableMonths.find(
      (month) => month.key === selectedMonth
    ) ?? availableMonths[0];

  const monthStart = selectedMonthInfo.start;

  const monthEnd = new Date(monthStart);

  monthEnd.setMonth(
    monthEnd.getMonth() + 1
  );

  /*
   * --------------------------------------------------------
   * LOAD MONTHLY DATA
   * --------------------------------------------------------
   */

  const [
    { data: events },
    { data: emailActions },
  ] = await Promise.all([
    supabase
      .from("usage_events")
      .select(
        "service, billed_cost_usd, quantity, unit, occurred_at"
      )
      .eq("tenant_id", tenant.id)
      .gte(
        "occurred_at",
        monthStart.toISOString()
      )
      .lt(
        "occurred_at",
        monthEnd.toISOString()
      ),

    supabase
      .from("email_actions")
      .select(
        "action_type, status, created_at"
      )
      .eq("tenant_id", tenant.id)
      .gte(
        "created_at",
        monthStart.toISOString()
      )
      .lt(
        "created_at",
        monthEnd.toISOString()
      ),
  ]);

  /*
   * --------------------------------------------------------
   * BILLING TOTAL
   * --------------------------------------------------------
   */

  const totalBilled = (events ?? []).reduce(
    (total, event) =>
      total +
      (Number(event.billed_cost_usd) || 0),
    0
  );

  /*
   * --------------------------------------------------------
   * ACTIVITY COUNTS
   * --------------------------------------------------------
   */

  const actions = emailActions ?? [];

  const emailsProcessed = actions.filter(
    (action) =>
      action.action_type !== "processing"
  ).length;

  const emailsDrafted = actions.filter(
    (action) =>
      action.action_type === "draft_reply"
  ).length;

  const emailsSent = actions.filter(
    (action) =>
      action.action_type === "draft_reply" &&
      action.status === "sent"
  ).length;

  /*
   * SMS count
   *
   * We count usage events rather than exposing SMS segments
   * or technical billing information to the customer.
   */

  const smsSent = (events ?? [])
    .filter(
      (event) =>
        event.service === "twilio_sms"
    )
    .reduce((total, event) => {
      const quantity = Number(event.quantity);

      return (
        total +
        (Number.isFinite(quantity)
          ? quantity
          : 1)
      );
    }, 0);

  const activity: ActivityCounts = {
    emailsProcessed,
    emailsDrafted,
    emailsSent,
    smsSent,
  };

  const hasUsage = totalBilled > 0;
  const hasActivity =
    activity.emailsProcessed > 0 ||
    activity.emailsDrafted > 0 ||
    activity.emailsSent > 0 ||
    activity.smsSent > 0;

  /*
   * --------------------------------------------------------
   * PAGE
   * --------------------------------------------------------
   */

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        {/* Header */}

        <header style={styles.header}>
          <div>
            <div style={styles.eyebrow}>
              ACCOUNT
            </div>

            <h1 style={styles.title}>
              Usage & billing
            </h1>

            <p style={styles.subtitle}>
              View your account activity and charges.
            </p>
          </div>

          <MonthSelector
            selectedMonth={selectedMonth}
            months={availableMonths}
          />
        </header>

        {/* Billing status */}

        <section style={styles.statusCard}>
          <div style={styles.statusLeft}>
            <div
              style={{
                ...styles.statusIcon,
                backgroundColor:
                  tenant.stripe_customer_id
                    ? "#ecfdf5"
                    : "#fffbeb",
              }}
            >
              <div
                style={{
                  ...styles.statusDot,
                  backgroundColor:
                    tenant.stripe_customer_id
                      ? "#10b981"
                      : "#f59e0b",
                }}
              />
            </div>

            <div>
              <div style={styles.statusTitle}>
                Billing status
              </div>

              <div
                style={
                  styles.statusDescription
                }
              >
                {tenant.stripe_customer_id
                  ? "Your account is connected and ready for billing."
                  : "Your account is tracking usage, but billing is not connected yet."}
              </div>
            </div>
          </div>

          <div
            style={{
              ...styles.statusBadge,
              color:
                tenant.stripe_customer_id
                  ? "#047857"
                  : "#b45309",
              backgroundColor:
                tenant.stripe_customer_id
                  ? "#ecfdf5"
                  : "#fffbeb",
            }}
          >
            {tenant.stripe_customer_id
              ? "Active"
              : "Not connected"}
          </div>
        </section>

        {/* Main billing card */}

        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardEyebrow}>
                {selectedMonthInfo.label.toUpperCase()}
              </div>

              <div style={styles.totalRow}>
                <h2 style={styles.total}>
                  {formatCurrency(totalBilled)}
                </h2>

                <span
                  style={styles.totalLabel}
                >
                  total charges
                </span>
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

          {!hasUsage ? (
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
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                  />

                  <path
                    strokeLinecap="round"
                    d="M12 7v5l3 2"
                  />
                </svg>
              </div>

              <div style={styles.emptyTitle}>
                No charges this month
              </div>

              <div style={styles.emptyText}>
                Any charges generated during this
                month will appear here.
              </div>
            </div>
          ) : (
            <div style={styles.totalFooter}>
              <span
                style={
                  styles.totalFooterLabel
                }
              >
                Total
              </span>

              <span
                style={
                  styles.totalFooterAmount
                }
              >
                {formatCurrency(totalBilled)}
              </span>
            </div>
          )}
        </section>

        {/* Activity */}

        <section style={styles.card}>
          <div style={styles.activityHeader}>
            <div>
              <div style={styles.cardEyebrow}>
                ACTIVITY
              </div>

              <h2 style={styles.activityTitle}>
                What happened this month
              </h2>
            </div>
          </div>

          {hasActivity ? (
            <div>
              <ActivityRow
                icon="email"
                label="Emails processed"
                value={activity.emailsProcessed}
              />

              <ActivityRow
                icon="draft"
                label="Replies drafted"
                value={activity.emailsDrafted}
              />

              <ActivityRow
                icon="send"
                label="Replies sent"
                value={activity.emailsSent}
              />

              <ActivityRow
                icon="sms"
                label="Text notifications"
                value={activity.smsSent}
                last
              />
            </div>
          ) : (
            <div style={styles.activityEmpty}>
              No activity recorded for this month.
            </div>
          )}
        </section>

        {/* Billing explanation */}

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
              <circle
                cx="12"
                cy="12"
                r="9"
              />

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
              Your charges are based on the services
              used by your account. Your account activity
              and charges are tracked automatically as
              Prime Automatic works on your behalf.
            </p>
          </div>
        </section>

        {/* Not connected notice */}

        {!tenant.stripe_customer_id && (
          <div style={styles.notice}>
            <div style={styles.noticeIcon}>
              !
            </div>

            <div>
              <div style={styles.noticeTitle}>
                Billing isn't connected yet
              </div>

              <div style={styles.noticeText}>
                Your activity is being tracked. Charges
                will begin once billing is connected.
              </div>
            </div>
          </div>
        )}

        <div style={styles.footer}>
          Billing information is calculated automatically
          from your account activity.
        </div>
      </div>
    </main>
  );
}



/* ============================================================
   Activity Row
   ============================================================ */

function ActivityRow({
  icon,
  label,
  value,
  last = false,
}: {
  icon:
    | "email"
    | "draft"
    | "send"
    | "sms";
  label: string;
  value: number;
  last?: boolean;
}) {
  return (
    <div
      style={{
        ...styles.activityRow,
        borderBottom: last
          ? "none"
          : "1px solid #f1f5f9",
      }}
    >
      <div style={styles.activityLeft}>
        <div style={styles.activityIcon}>
          {renderActivityIcon(icon)}
        </div>

        <span style={styles.activityLabel}>
          {label}
        </span>
      </div>

      <span style={styles.activityValue}>
        {value.toLocaleString("en-US")}
      </span>
    </div>
  );
}


/* ============================================================
   Activity Icons
   ============================================================ */

function renderActivityIcon(
  icon:
    | "email"
    | "draft"
    | "send"
    | "sms"
) {
  if (icon === "email") {
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <rect
          x="3"
          y="5"
          width="18"
          height="14"
          rx="2"
        />

        <path d="m3 7 9 6 9-6" />
      </svg>
    );
  }

  if (icon === "draft") {
    return (
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
          d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3Z"
        />

        <path
          strokeLinecap="round"
          d="m13.5 7.5 3 3"
        />
      </svg>
    );
  }

  if (icon === "send") {
    return (
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
          d="m21 3-7.5 18-3.5-7-7-3.5L21 3Z"
        />

        <path
          strokeLinecap="round"
          d="M10 14 21 3"
        />
      </svg>
    );
  }

  return (
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
        d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5c-1.3 0-2.5-.33-3.55-.92L4 19l1.02-4.95A7.46 7.46 0 0 1 5 11.5 7.5 7.5 0 1 1 20 11.5Z"
      />

      <path
        strokeLinecap="round"
        d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01"
      />
    </svg>
  );
}


/* ============================================================
   Helpers
   ============================================================ */

function getMonthKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(
    date.getMonth() + 1
  ).padStart(2, "0");

  return `${year}-${month}`;
}


function formatCurrency(
  amount: number
): string {
  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return "$0.00";
  }

  if (amount < 0.001) {
    return `$${amount.toFixed(5)}`;
  }

  if (amount < 0.01) {
    return `$${amount.toFixed(4)}`;
  }

  return new Intl.NumberFormat(
    "en-US",
    {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }
  ).format(amount);
}


/* ============================================================
   Styles
   ============================================================ */

const styles: Record<
  string,
  React.CSSProperties
> = {
  page: {
    minHeight: "100vh",
    background: "#f8fafc",
    color: "#0f172a",
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding:
      "48px 24px 64px",
  },

  container: {
    width: "100%",
    maxWidth: "900px",
    margin: "0 auto",
  },

  header: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent:
      "space-between",
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

  monthSelector: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexShrink: 0,
    padding: "10px 12px",
    borderRadius: "11px",
    border: "1px solid #e2e8f0",
    background: "#ffffff",
    color: "#475569",
    boxShadow:
      "0 1px 2px rgba(15, 23, 42, 0.04)",
    cursor: "pointer",
  },

  monthSelect: {
    appearance: "none",
    WebkitAppearance: "none",
    border: "none",
    outline: "none",
    background: "transparent",
    color: "#334155",
    fontSize: "13px",
    fontWeight: 650,
    cursor: "pointer",
    padding: 0,
  },

  card: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "18px",
    boxShadow:
      "0 4px 16px rgba(15, 23, 42, 0.04)",
    overflow: "hidden",
    marginBottom: "18px",
  },

  statusCard: {
    display: "flex",
    alignItems: "center",
    justifyContent:
      "space-between",
    gap: "20px",
    padding: "18px 20px",
    marginBottom: "18px",
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "16px",
    boxShadow:
      "0 2px 8px rgba(15, 23, 42, 0.03)",
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
    justifyContent:
      "space-between",
    padding:
      "25px 26px 23px",
    borderBottom:
      "1px solid #f1f5f9",
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

  totalFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent:
      "space-between",
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

  activityHeader: {
    padding:
      "24px 26px 20px",
    borderBottom:
      "1px solid #f1f5f9",
  },

  activityTitle: {
    margin: 0,
    fontSize: "19px",
    fontWeight: 700,
    letterSpacing:
      "-0.015em",
    color: "#0f172a",
  },

  activityRow: {
    display: "flex",
    alignItems: "center",
    justifyContent:
      "space-between",
    padding:
      "17px 26px",
  },

  activityLeft: {
    display: "flex",
    alignItems: "center",
    gap: "13px",
  },

  activityIcon: {
    width: "38px",
    height: "38px",
    borderRadius: "10px",
    background: "#f1f5f9",
    color: "#64748b",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  activityLabel: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#334155",
  },

  activityValue: {
    fontSize: "16px",
    fontWeight: 750,
    color: "#0f172a",
  },

  activityEmpty: {
    padding:
      "35px 24px",
    textAlign: "center",
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
    boxShadow:
      "0 2px 8px rgba(15, 23, 42, 0.03)",
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