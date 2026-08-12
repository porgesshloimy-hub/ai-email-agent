"use client";

import { useRouter } from "next/navigation";

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
  const router = useRouter();

  const selectedLabel =
    months.find((month) => month.key === selectedMonth)?.label ??
    selectedMonth;

  function handleChange(
    event: React.ChangeEvent<HTMLSelectElement>
  ) {
    const month = event.target.value;

    router.push(`/dashboard/billing?month=${month}`);
  }

  return (
    <div style={styles.monthSelector}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
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

      <span style={styles.monthSelectorText}>
        {selectedLabel}
      </span>

      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m6 9 6 6 6-6"
        />
      </svg>

      <select
        name="month"
        value={selectedMonth}
        onChange={handleChange}
        aria-label="Select billing month"
        style={styles.monthSelectOverlay}
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
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  monthSelector: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: "170px",
    height: "42px",
    padding: "0 12px",
    borderRadius: "11px",
    border: "1px solid #e2e8f0",
    background: "#ffffff",
    color: "#475569",
    boxShadow:
      "0 1px 2px rgba(15, 23, 42, 0.04)",
    cursor: "pointer",
    overflow: "hidden",
  },

  monthSelectorText: {
    flex: 1,
    fontSize: "13px",
    fontWeight: 650,
    color: "#334155",
    whiteSpace: "nowrap",
  },

  monthSelectOverlay: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    opacity: 0,
    cursor: "pointer",
    border: "none",
    outline: "none",
  },
};