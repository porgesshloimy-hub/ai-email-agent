import { isValidTimezone, DEFAULT_TIMEZONE } from "@/lib/timezones";

/**
 * ------------------------------------------------------------
 * Current date context for agent system prompts
 * ------------------------------------------------------------
 *
 * Shared by both agent surfaces (lib/agent/run.ts's email pipeline and
 * lib/agent/chat.ts's Google Chat handler) so neither one has to derive
 * a weekday from a raw date on its own.
 *
 * Bug fix history:
 *
 * 1. The email pipeline used to hand the model only a raw ISO timestamp
 *    and ask it to resolve phrases like "next Monday" itself — LLMs are
 *    unreliable at that kind of mental date math (observed in
 *    production: "next Monday" got scheduled for a Tuesday). Fixed by
 *    computing the weekday name and a lookahead table in code and
 *    handing the model the answer directly, a lookup instead of
 *    arithmetic. Google Chat previously had no date context in its
 *    system prompt at all — same fix applied there too.
 *
 * 2. This function then hardcoded `timeZone: "UTC"` for everything,
 *    with no per-tenant override anywhere in the schema — so "today"
 *    flipped to the next calendar date at UTC midnight regardless of
 *    where the business actually is. For most of the US that lands in
 *    the middle of a normal business day (e.g. UTC midnight is
 *    mid-afternoon Pacific time), so the agent's stated "today" was
 *    wrong for a large fraction of every business day, not a rare
 *    edge case. Fixed by accepting the tenant's own stored timezone
 *    (tenants.timezone, migration 007) and anchoring "today" to that.
 *
 * This deliberately does NOT try to determine an individual customer's
 * timezone — there's no single correct answer for a business with
 * clients across multiple zones, and guessing wrong silently is worse
 * than not guessing. See the explicit business-vs-customer guidance at
 * the end of the returned block: prefer a timezone actually stated or
 * implied in the conversation, default to the business's own timezone
 * otherwise, and always restate a resolved date/time with its timezone
 * spelled out so a wrong guess is visible and correctable rather than
 * silent.
 */
export function buildCurrentDateContext(
  tenantTimezone?: string | null
): string {
  const timezone = isValidTimezone(tenantTimezone)
    ? (tenantTimezone as string)
    : DEFAULT_TIMEZONE;

  const now = new Date();

  /**
   * The one place the tenant's timezone actually matters: determining
   * what calendar date "today" is, as seen from that timezone. "en-CA"
   * is a convenient trick — that locale formats dates as YYYY-MM-DD
   * directly, which parses back unambiguously.
   */
  const todayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const todayYear = todayParts.find((part) => part.type === "year")?.value;
  const todayMonth = todayParts.find((part) => part.type === "month")?.value;
  const todayDay = todayParts.find((part) => part.type === "day")?.value;

  /**
   * Anchor that calendar date at UTC midnight as a pure arithmetic
   * proxy. From here on we only ever add whole days to it and read the
   * result back with timeZone: "UTC" — we never re-interpret it
   * against `timezone` again, so a DST transition partway through the
   * lookahead window can't shift which weekday a future date lands on.
   * (Which day of the week a given calendar date falls on is a fact
   * about the date itself, not about any timezone — the tenant's
   * timezone was only needed once, above, to determine "today".)
   */
  const todayAnchor = new Date(
    `${todayYear}-${todayMonth}-${todayDay}T00:00:00Z`
  );

  const todayLabel = todayAnchor.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  const localTimeLabel = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  });

  // Next 14 days, each explicitly paired with its weekday name, so
  // resolving "next Monday" / "this Friday" / "a week from Wednesday" is
  // a lookup against this table rather than something the model has to
  // calculate itself.
  const lookahead = Array.from({ length: 14 }, (_, i) => {
    const date = new Date(todayAnchor);
    date.setUTCDate(date.getUTCDate() + i + 1);

    const weekday = date.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });

    const isoDate = date.toISOString().slice(0, 10);

    return `${weekday}, ${isoDate}`;
  });

  return [
    `This business's timezone is ${timezone}. Today, in that timezone, is ${todayLabel}. The current local time there is approximately ${localTimeLabel}.`,
    `(Underlying UTC instant, for reference only: ${now.toISOString()}.)`,
    "The next 14 days, with their weekday names, are:",
    ...lookahead.map((line) => `- ${line}`),
    'Use this table to resolve relative dates and times like "today," "tomorrow," "next Friday," or "a week from Monday" mentioned in the conversation — look up the correct row rather than calculating the weekday yourself. Never ask what today\'s date is — you already have it.',
    "The timezone above is the BUSINESS's own — not necessarily any given customer's. If a customer's timezone is stated or clearly implied in the conversation (an area code, \"3pm EST works for me\", a stated city or region), resolve times in THEIR timezone, not the business's. Otherwise default to the business's timezone above, the same way a human assistant would. Whichever you use, whenever you state a specific date or time back to anyone — in a reply, a calendar event, or a meeting confirmation — always spell out the timezone explicitly (e.g. \"Tuesday, August 26 at 3:00 PM Eastern Time\", never a bare time with no timezone attached) so a wrong guess is immediately visible and correctable instead of a silent mismatch.",
  ].join("\n");
}
