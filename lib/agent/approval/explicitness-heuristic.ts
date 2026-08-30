/**
 * ------------------------------------------------------------
 * Owner-instruction explicitness heuristic
 * ------------------------------------------------------------
 *
 * Deliberately NOT an LLM self-report ("was I told exactly what to do?")
 * — the model's own claim of explicitness is exactly the kind of
 * self-assessment this project's grounding guard exists to distrust
 * elsewhere, and the same principle applies here: a backend, code-level
 * check sanity-checks the model's tool call against what the owner
 * actually typed, rather than taking the model's word for how explicit
 * the instruction was.
 *
 * This only scores "did the owner's own message contain the specifics
 * needed to act, or did the model have to invent/infer them" — it says
 * nothing about whether the action itself is a good idea. Scoring is
 * intentionally simple pattern matching, not a model call: the whole
 * point is a check the model can't talk its way around by narrating its
 * own confidence.
 */

export interface ExplicitnessResult {
  score: number; // 0–1, higher = more explicit
  isExplicit: boolean;
  reasons: string[];
}

const EXPLICITNESS_THRESHOLD = 0.6;

/**
 * A concrete email address in the owner's own message — the strongest
 * possible recipient signal, since it requires no resolution/inference
 * at all.
 */
const EMAIL_ADDRESS_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/**
 * Quoted text — the owner dictating actual words to relay, rather than
 * describing intent for the model to phrase itself. Matches either
 * straight or curly double quotes.
 */
const QUOTED_CONTENT_PATTERN = /["“][^"”]{8,}["”]/;

/**
 * Scores how explicit an owner's raw chat message was for actually
 * SENDING an email (as opposed to drafting one). Deliberately more
 * conservative than scoreCalendarInstructionExplicitness() above: a
 * wrong calendar entry is trivially correctable, but a wrongly-sent
 * email has already reached a real third party and can't be undone.
 * Both a clear recipient AND owner-dictated content are required —
 * either alone is not enough to skip confirmation.
 */
export function scoreEmailInstructionExplicitness(
  ownerMessageText: string
): ExplicitnessResult {
  const reasons: string[] = [];

  const hasExplicitRecipient = EMAIL_ADDRESS_PATTERN.test(ownerMessageText);
  const hasDictatedContent = QUOTED_CONTENT_PATTERN.test(ownerMessageText);

  if (hasExplicitRecipient) {
    reasons.push("owner's message contains an explicit email address");
  }
  if (hasDictatedContent) {
    reasons.push("owner's message contains quoted/dictated content to relay");
  }

  // Both required — see reasoning above. Neither alone crosses the
  // threshold, by design.
  const score = hasExplicitRecipient && hasDictatedContent ? 1 : hasExplicitRecipient || hasDictatedContent ? 0.4 : 0;

  return {
    score,
    isExplicit: score >= EXPLICITNESS_THRESHOLD,
    reasons,
  };
}

/**
 * A specific clock time ("3pm", "15:00", "3:30 PM") or an ISO-ish
 * date/time fragment. Deliberately loose — false positives here just
 * mean "treat as explicit" more often, which is the safer direction to
 * err in false-positive/negative tradeoffs for this specific check,
 * since the fallback for a false negative (sync-confirm) costs the owner
 * one extra reply, not a wrong action.
 */
const TIME_PATTERN = /\b\d{1,2}(:\d{2})?\s?(am|pm|AM|PM)\b|\b\d{4}-\d{2}-\d{2}\b|\bT\d{2}:\d{2}\b/;

/**
 * A specific day reference — a weekday name, "today"/"tomorrow", or an
 * explicit month+day. Relies on the same day-vocabulary the model
 * already resolves against lib/agent/date-context.ts's lookahead table,
 * so this doesn't need its own date-parsing logic — it just checks
 * whether the OWNER's message, not the model's interpretation of it,
 * contained one of these words at all.
 */
const DAY_PATTERN =
  /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

/**
 * Scores how explicit an owner's raw chat message was, for a calendar-
 * style action specifically (the one owner-directed tool that exists on
 * the chat surface today). Generalizing this beyond calendar actions —
 * e.g. a specific recipient name for a future owner-directed send tool —
 * is a matter of adding more pattern checks here, not restructuring the
 * function; kept calendar-specific for now rather than building
 * generality nothing yet needs.
 */
export function scoreCalendarInstructionExplicitness(
  ownerMessageText: string
): ExplicitnessResult {
  const reasons: string[] = [];
  let score = 0;

  const hasTime = TIME_PATTERN.test(ownerMessageText);
  const hasDay = DAY_PATTERN.test(ownerMessageText);

  if (hasTime) {
    score += 0.5;
    reasons.push("owner's message contains a specific time");
  }

  if (hasDay) {
    score += 0.35;
    reasons.push("owner's message contains a specific day reference");
  }

  /**
   * A message that's mostly just a vague verb ("schedule something",
   * "block off time", "set up a meeting") with no other content beyond
   * the day/time gets a small penalty — those still require the model
   * to invent the substance (what the event even is), which is exactly
   * the kind of gap-filling this check exists to catch. This is a rough
   * proxy (message length after stripping day/time words), not a real
   * substance-detector — good enough to bias short, vague requests
   * toward confirmation without needing full NLP.
   */
  const strippedLength = ownerMessageText
    .replace(TIME_PATTERN, "")
    .replace(DAY_PATTERN, "")
    .trim().length;

  if (strippedLength < 12) {
    score -= 0.15;
    reasons.push("little content beyond a day/time reference — the event's substance may be inferred");
  } else {
    score += 0.15;
  }

  const clamped = Math.max(0, Math.min(1, score));

  return {
    score: clamped,
    isExplicit: clamped >= EXPLICITNESS_THRESHOLD,
    reasons,
  };
}
