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
 * 3. Even with the business's real local timezone, "today" still
 *    flipped to the next calendar date at literal local midnight — so a
 *    message written at 12:15 AM saw "tomorrow" resolved as two
 *    calendar days out from the evening the sender actually meant. In
 *    ordinary speech, most people who are up shortly after midnight
 *    still consider themselves in "today" (the day they haven't slept
 *    through yet) and mean the calendar date that just began when they
 *    say "tomorrow" — the flip only feels real once morning actually
 *    arrives, not at the stroke of midnight. Fixed with a day-rollover
 *    cutoff: for a window after local midnight, the "today" anchor used
 *    to resolve relative language is deliberately held one day behind
 *    the real calendar date. See DAY_ROLLOVER_CUTOFF_HOUR below for why
 *    4:00 AM specifically.
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

/**
 * The local hour (0–23) before which "today," for the purposes of
 * resolving relative date language in conversation, is deliberately
 * held to the previous calendar date rather than the one that
 * technically just began at midnight.
 *
 * 4:00 AM is the chosen cutoff: it's late enough that essentially no one
 * writing "today"/"tomorrow" shortly after midnight actually means the
 * date-after-next, but early enough that by 4 AM almost everyone —
 * including genuine night owls — has either gone to sleep or otherwise
 * moved on to treating the new calendar date as "today." This mirrors
 * the same day-rollover convention used by several other systems for
 * exactly this reason (e.g. nightlife/hospitality booking treating a
 * "Friday night" as continuing into the small hours rather than ending
 * at midnight).
 *
 * This only affects how "today"/"tomorrow" style language is resolved
 * in the system prompt below — it never affects the real, actual
 * current date/time, which is always shown alongside it for
 * transparency and is what any absolute scheduling logic should still
 * be able to fall back on if needed.
 */
const DAY_ROLLOVER_CUTOFF_HOUR = 4;

export function buildCurrentDateContext(
  tenantTimezone?: string | null
): string {
  const timezone = isValidTimezone(tenantTimezone)
    ? (tenantTimezone as string)
    : DEFAULT_TIMEZONE;

  const now = new Date();

  /**
   * The one place the tenant's timezone actually matters for the REAL
   * date: determining what calendar date it technically is right now,
   * as seen from that timezone. "en-CA" is a convenient trick — that
   * locale formats dates as YYYY-MM-DD directly, which parses back
   * unambiguously.
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
   * Anchor that REAL calendar date at UTC midnight as a pure arithmetic
   * proxy. From here on we only ever add/subtract whole days from it and
   * read the result back with timeZone: "UTC" — we never re-interpret it
   * against `timezone` again, so a DST transition partway through the
   * lookahead window can't shift which weekday a future date lands on.
   * (Which day of the week a given calendar date falls on is a fact
   * about the date itself, not about any timezone — the tenant's
   * timezone was only needed once, above, to determine the real "today".)
   */
  const realTodayAnchor = new Date(
    `${todayYear}-${todayMonth}-${todayDay}T00:00:00Z`
  );

  const realTodayLabel = realTodayAnchor.toLocaleDateString("en-US", {
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

  /**
   * Current local hour, in the tenant's own timezone, used only to
   * decide whether we're inside the early-morning rollover window.
   * hourCycle: "h23" is used explicitly (rather than relying on
   * hour12: false alone) because some ICU implementations render
   * midnight as "24" instead of "0" under hour12: false, which would
   * silently break the < DAY_ROLLOVER_CUTOFF_HOUR comparison below
   * right at the one moment this logic matters most.
   */
  const localHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      hour: "numeric",
    }).format(now)
  );

  const isEarlyMorningRollover = localHour < DAY_ROLLOVER_CUTOFF_HOUR;

  /**
   * The EFFECTIVE anchor used to resolve "today"/"tomorrow" and the
   * lookahead table below. Identical to the real anchor outside the
   * rollover window; shifted back one calendar day during it, per the
   * reasoning in DAY_ROLLOVER_CUTOFF_HOUR's comment above.
   */
  const effectiveAnchor = new Date(realTodayAnchor);
  if (isEarlyMorningRollover) {
    effectiveAnchor.setUTCDate(effectiveAnchor.getUTCDate() - 1);
  }

  const effectiveTodayLabel = effectiveAnchor.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  // Next 14 days AFTER the effective anchor, each explicitly paired with
  // its weekday name, so resolving "tomorrow" / "next Monday" / "this
  // Friday" is a lookup against this table rather than something the
  // model has to calculate itself. During the rollover window, the real
  // current calendar date is simply the first row of this table (i.e.
  // "tomorrow" from the effective anchor's point of view) rather than
  // being "today" — which is exactly the resolution being aimed for.
  const lookahead = Array.from({ length: 14 }, (_, i) => {
    const date = new Date(effectiveAnchor);
    date.setUTCDate(date.getUTCDate() + i + 1);

    const weekday = date.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });

    const isoDate = date.toISOString().slice(0, 10);

    return `${weekday}, ${isoDate}`;
  });

  const todayLine = isEarlyMorningRollover
    ? `This business's timezone is ${timezone}. It's currently the early hours of the morning there (before ${DAY_ROLLOVER_CUTOFF_HOUR}:00 AM), so for the purposes of resolving "today"/"tomorrow" and similar relative language in conversation, treat today as ${effectiveTodayLabel} — the day most people are still up from, not the calendar date that technically just began at midnight. (For reference, the calendar date has technically already rolled over to ${realTodayLabel}; the current local time there is approximately ${localTimeLabel}.)`
    : `This business's timezone is ${timezone}. Today, in that timezone, is ${effectiveTodayLabel}. The current local time there is approximately ${localTimeLabel}.`;

  return [
    todayLine,
    `(Underlying UTC instant, for reference only: ${now.toISOString()}.)`,
    "The next 14 days, with their weekday names, are:",
    ...lookahead.map((line) => `- ${line}`),
    'Use this table to resolve relative dates and times like "today," "tomorrow," "next Friday," or "a week from Monday" mentioned in the conversation — look up the correct row rather than calculating the weekday yourself. Never ask what today\'s date is — you already have it.',
    "The timezone above is the BUSINESS's own — not necessarily any given customer's. If a customer's timezone is stated or clearly implied in the conversation (an area code, \"3pm EST works for me\", a stated city or region), resolve times in THEIR timezone, not the business's. Otherwise default to the business's timezone above, the same way a human assistant would. Whichever you use, whenever you state a specific date or time back to anyone — in a reply, a calendar event, or a meeting confirmation — always spell out the timezone explicitly (e.g. \"Tuesday, August 26 at 3:00 PM Eastern Time\", never a bare time with no timezone attached) so a wrong guess is immediately visible and correctable instead of a silent mismatch.",
  ].join("\n");
}
