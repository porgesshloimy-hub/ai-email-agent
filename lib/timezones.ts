/**
 * A curated subset of IANA timezone identifiers, not the full ~400-zone
 * database — enough to cover where an actual small/mid-size business
 * customer of this app is likely to be, presented as a plain dropdown
 * rather than a searchable-but-overwhelming list of every zone on
 * Earth. Grouped roughly by region for a scannable <select>.
 *
 * If a tenant's stored timezone (or one entered directly in the
 * database) isn't in this list, isValidTimezone() below still accepts
 * it as long as the JS runtime recognizes it as a real IANA zone —
 * this list is only a UI convenience, not the source of truth for
 * what's valid.
 */
export const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: "Pacific/Honolulu", label: "Hawaii Time — Honolulu" },
  { value: "America/Anchorage", label: "Alaska Time — Anchorage" },
  { value: "America/Los_Angeles", label: "Pacific Time — Los Angeles" },
  { value: "America/Denver", label: "Mountain Time — Denver" },
  { value: "America/Phoenix", label: "Mountain Time, no DST — Phoenix" },
  { value: "America/Chicago", label: "Central Time — Chicago" },
  { value: "America/New_York", label: "Eastern Time — New York" },
  { value: "America/Halifax", label: "Atlantic Time — Halifax" },
  { value: "America/Sao_Paulo", label: "Sao Paulo" },
  { value: "UTC", label: "UTC" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Dublin", label: "Dublin" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Europe/Madrid", label: "Madrid" },
  { value: "Europe/Rome", label: "Rome" },
  { value: "Europe/Athens", label: "Athens" },
  { value: "Europe/Moscow", label: "Moscow" },
  { value: "Africa/Johannesburg", label: "Johannesburg" },
  { value: "Asia/Jerusalem", label: "Jerusalem" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Karachi", label: "Karachi" },
  { value: "Asia/Kolkata", label: "India — Kolkata" },
  { value: "Asia/Dhaka", label: "Dhaka" },
  { value: "Asia/Bangkok", label: "Bangkok" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Hong_Kong", label: "Hong Kong" },
  { value: "Asia/Shanghai", label: "Shanghai" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Asia/Seoul", label: "Seoul" },
  { value: "Australia/Perth", label: "Perth" },
  { value: "Australia/Adelaide", label: "Adelaide" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "Pacific/Auckland", label: "Auckland" },
];

export const DEFAULT_TIMEZONE = "UTC";

/**
 * Whether the JS runtime's Intl implementation recognizes this as a
 * real IANA timezone identifier — the actual source of truth (not
 * COMMON_TIMEZONES above, which is just what's offered in the UI
 * dropdown). Used both to validate a value before saving it
 * (app/dashboard/settings/actions.ts) and as a defensive fallback
 * anywhere a stored value is read back (lib/agent/date-context.ts) —
 * a tenant row could in principle contain a value that predates a
 * stricter check, or one entered directly in the database.
 */
export function isValidTimezone(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") {
    return false;
  }

  try {
    // Intl throws a RangeError for an unrecognized zone name.
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
