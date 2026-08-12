"use client";

interface BillingMonth {
  key: string;
  label: string;
}

export default function MonthSelector({
  selectedMonth,
  months,
}: {
  selectedMonth: string;
  months: BillingMonth[];
}) {
  return (
    <form method="GET">
      <label style={styles.monthSelector}>
        <svg
          width="16"
          height="16"
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

        <select
          name="month"
          value={selectedMonth}
          style={styles.monthSelect}
          aria-label="Select billing month"
          onChange={(event) => {
            event.currentTarget.form?.submit();
          }}
        >
          {months.map((month) => (
            <option
              key={month.key}
              value={month.key}
            >
              {month.label}
            </option>
          ))}
        </select>

        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m6 9 6 6 6-6"
          />
        </svg>
      </label>
    </form>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
};