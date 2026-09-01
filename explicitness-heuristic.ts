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
 * A direct, unambiguous instruction to actually send — not just discuss
 * or draft. Added after explicit feedback: requiring dictated wording
 * on top of a clear send command was too restrictive for how the owner
 * actually wanted to use this — "send it, word it however you
 * understand" is a real, clear request to send, even though it
 * delegates the wording. The gate this project actually cares about is
 * "did the owner clearly ask to send," not "did the owner write the
 * email themselves."
 */
const SEND_DIRECTIVE_PATTERN =
  /\b(send it|send this|send that|send the email|send now|go ahead and send|please send|just send|yes,? send)\b/i;

/**
 * Scores how explicit an owner's raw chat message was for actually
 * SENDING an email (as opposed to drafting one).
 *
 * Loosened per explicit request: previously required BOTH a concrete
 * recipient AND dictated/quoted content before skipping confirmation —
 * reasonable caution in the abstract, but in practice it meant even a
 * clear, direct "send it" from the owner still got held for a second
 * confirmation, purely because the wording wasn't dictated verbatim.
 * That's not the risk this check is meant to guard against — the real
 * concern is the model sending on ITS OWN inferred judgment with no
 * real owner request behind it at all, which can't happen here since
 * this tool is only ever reached in response to an owner's own message
 * in the first place (see send-email.ts's module comment).
 *
 * A clear, direct send command is now sufficient on its own. An
 * explicit recipient plus dictated content remains an alternate, even
 * stronger path to the same result — useful for a genuinely
 * first-touch "send jane@x.com: '...'" instruction with no prior
 * back-and-forth to imply intent from.
 */
export function scoreEmailInstructionExplicitness(
  ownerMessageText: string
): ExplicitnessResult {
  const reasons: string[] = [];

  const hasSendDirective = SEND_DIRECTIVE_PATTERN.test(ownerMessageText);
  const hasExplicitRecipient = EMAIL_ADDRESS_PATTERN.test(ownerMessageText);
  const hasDictatedContent = QUOTED_CONTENT_PATTERN.test(ownerMessageText);

  if (hasSendDirective) {
    reasons.push("owner gave a clear, direct instruction to send");
  }
  if (hasExplicitRecipient) {
    reasons.push("owner's message contains an explicit email address");
  }
  if (hasDictatedContent) {
    reasons.push("owner's message contains quoted/dictated content to relay");
  }

  const isExplicit = hasSendDirective || (hasExplicitRecipient && hasDictatedContent);
  const score = isExplicit ? 1 : hasExplicitRecipient || hasDictatedContent ? 0.4 : 0;

  return {
    score,
    isExplicit,
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

/**
 * A clear delete/cancel intent verb — required before treating any
 * message as an instruction to remove a calendar event at all. Without
 * this, a message that merely MENTIONS a day/time (e.g. discussing
 * availability) could otherwise satisfy the same day/time signal used
 * for calendar creation and be mistaken for a delete instruction.
 */
const DELETE_VERB_PATTERN = /\b(delete|cancel|remove|get rid of)\b/i;

/**
 * Scores how explicit an owner's raw chat message was for DELETING a
 * calendar event. Deletion is destructive and only trivially
 * correctable by recreating the event from scratch (and even then,
 * only if its exact original details are still known) — closer in
 * risk to send_email than to creating a new event, so this requires
 * both a clear delete verb AND identifying information (a day/time
 * reference, matching the same patterns used for calendar creation, OR
 * quoted/specific text naming the event) before treating an
 * instruction as explicit enough to execute without confirmation.
 * Neither signal alone is enough — see scoreEmailInstructionExplicitness's
 * identical two-signals-required reasoning above.
 */
export function scoreDeleteInstructionExplicitness(
  ownerMessageText: string
): ExplicitnessResult {
  const reasons: string[] = [];

  const hasDeleteVerb = DELETE_VERB_PATTERN.test(ownerMessageText);
  const hasTime = TIME_PATTERN.test(ownerMessageText);
  const hasDay = DAY_PATTERN.test(ownerMessageText);
  const hasQuotedName = QUOTED_CONTENT_PATTERN.test(ownerMessageText);

  if (hasDeleteVerb) reasons.push("owner used a clear delete/cancel verb");
  if (hasTime) reasons.push("owner's message contains a specific time");
  if (hasDay) reasons.push("owner's message contains a specific day reference");
  if (hasQuotedName) reasons.push("owner's message names the event specifically");

  const hasIdentifyingInfo = hasTime || hasDay || hasQuotedName;
  const isExplicit = hasDeleteVerb && hasIdentifyingInfo;

  return {
    score: isExplicit ? 1 : hasDeleteVerb || hasIdentifyingInfo ? 0.4 : 0,
    isExplicit,
    reasons,
  };
}
