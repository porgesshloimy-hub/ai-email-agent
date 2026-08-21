/**
 * ------------------------------------------------------------
 * Current date context for agent system prompts
 * ------------------------------------------------------------
 *
 * Shared by both agent surfaces (lib/agent/run.ts's email pipeline and
 * lib/agent/chat.ts's Google Chat handler) so neither one has to derive
 * a weekday from a raw date on its own.
 *
 * Bug fix history: the email pipeline used to hand the model only a raw
 * ISO timestamp (e.g. "2026-08-21T09:20:00.000Z") and ask it to resolve
 * phrases like "next Monday" itself. That requires the model to compute
 * today's day-of-week, then separately count forward to the target
 * weekday, entirely through its own arithmetic — LLMs are unreliable at
 * exactly this kind of mental date math and can be off by a day
 * (observed in production: a request for "next Monday" was scheduled
 * for a Tuesday because the model mis-derived which weekday the current
 * ISO date fell on).
 *
 * Fix: compute the weekday name and a short lookahead table in code
 * (where date arithmetic is exact) and hand the model the answer
 * directly, so it only ever needs to read the right row out of a table
 * it's already been given, never derive one itself. The Google Chat
 * handler previously included no date context in its system prompt at
 * all, which is the same failure mode with no anchor point whatsoever —
 * it's fixed the same way here rather than left as a separate gap.
 */
export function buildCurrentDateContext(): string {
  const now = new Date();

  const todayLabel = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  // Next 14 days, each explicitly paired with its weekday name, so
  // resolving "next Monday" / "this Friday" / "a week from Wednesday" is
  // a lookup against this table rather than something the model has to
  // calculate itself.
  const lookahead = Array.from({ length: 14 }, (_, i) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + i + 1);

    const weekday = date.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });

    const isoDate = date.toISOString().slice(0, 10);

    return `${weekday}, ${isoDate}`;
  });

  return [
    `Current date and time: ${now.toISOString()} (UTC) — that is ${todayLabel}.`,
    "The next 14 days, with their weekday names, are:",
    ...lookahead.map((line) => `- ${line}`),
    'Use this table to resolve relative dates and times like "today," "tomorrow," "next Friday," or "a week from Monday" mentioned in the conversation — look up the correct row rather than calculating the weekday yourself. Never ask what today\'s date is — you already have it.',
  ].join("\n");
}
