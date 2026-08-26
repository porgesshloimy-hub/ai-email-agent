/**
 * ------------------------------------------------------------
 * Email content safety: cosmetic cleanup + hallucination guard
 * ------------------------------------------------------------
 *
 * Extracted out of lib/agent/run.ts so it has exactly one definition
 * usable from anywhere content actually leaves the app as an email —
 * not just the live agent loop. Before this extraction, these checks
 * only ran inside run.ts's tool-dispatch loop (send_reply/create_draft/
 * propose_*), which meant the OTHER place a customer-facing email gets
 * sent — app/dashboard/approvals/actions.ts's sendStoredConfirmation(),
 * triggered by the human clicking "Approve" on a pending Zoom/calendar
 * proposal — ran none of them. That path sends whatever text the model
 * wrote days earlier at proposal time, substitutes {{meeting_link}} if
 * a real link exists, and sends it straight to Gmail with no check at
 * all. See app/dashboard/approvals/actions.ts's own use of this module
 * for the fix.
 *
 * Two separate functions, deliberately not combined:
 *
 * stripKnownSafePlaceholders() — cosmetic, silent cleanup for things
 * that are annoying but not misleading (a stray "[Your Name]" or
 * generic "Best regards,"). Safe to just delete.
 *
 * detectHallucinatedContent() — returns a human-readable violation
 * string (or null) for content that isn't safe to silently edit,
 * because deleting it wouldn't fix the underlying problem: the text
 * asserts something (a link, a booked service, a created meeting) that
 * isn't actually backed by anything. Callers must NOT send/save
 * content that fails this check.
 *
 * Applied to `body` (create_draft/send_reply), `confirmationMessage`
 * (propose_zoom_meeting/propose_calendar_event, and the substituted
 * text sendStoredConfirmation is about to actually send), and
 * `description`/`agenda` (create_calendar_event/create_zoom_meeting).
 * The {{meeting_link}} placeholder is intentionally exempt everywhere
 * below when it's still a real unsubstituted placeholder — it's a real
 * placeholder this app substitutes itself before sending, not an
 * AI-invented one. (sendStoredConfirmation should run this function
 * AFTER attempting its own {{meeting_link}} substitution — see its
 * comment — so that a leftover, never-substituted {{meeting_link}} at
 * that point IS treated as a violation, since by then it means the
 * substitution didn't happen.)
 */

export function stripKnownSafePlaceholders(body: string): string {
  if (!body) {
    return "";
  }

  let cleaned = body;

  /**
   * Remove common cosmetic placeholder patterns where deleting them
   * cannot misrepresent a fact:
   *
   * [Company Name]
   * [Your Name]
   * [Customer Name]
   * {{company_name}}
   * {{name}}
   * <Company Name>
   *
   * {{meeting_link}} is deliberately excluded from the {{...}} removal
   * below — it is a real placeholder this app substitutes itself
   * before sending, not an AI-invented one.
   */

  cleaned = cleaned
    .replace(
      /\[(?:company|business|organization|name|customer|client|phone|email|website|address)[^\]]*\]/gi,
      ""
    )
    .replace(/\{\{(?!meeting_link\}\})[^}]+\}\}/g, "")
    .replace(
      /<(?:company|business|organization|name|customer|client|phone|email|website|address)[^>]*>/gi,
      ""
    );

  /**
   * Remove generic/invented AI signatures.
   */

  const genericSignaturePatterns = [
    /^best regards,\s*$/im,
    /^kind regards,\s*$/im,
    /^warm regards,\s*$/im,
    /^sincerely,\s*$/im,
    /^regards,\s*$/im,
    /^the album design team\s*$/im,
    /^the [a-z0-9&' -]+ team\s*$/im,
  ];

  for (const pattern of genericSignaturePatterns) {
    cleaned = cleaned.replace(pattern, "");
  }

  /**
   * Remove leftover blank lines.
   */

  cleaned = cleaned
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

/**
 * Detect content that is not safe to silently strip and continue —
 * see the module comment above for why these are handled separately.
 * Returns a short human-readable violation description, or null if the
 * text looks safe to send.
 *
 * Two checks:
 *
 * 1. Any bracketed template-variable-looking text left over after
 *    stripKnownSafePlaceholders() has already removed the known-safe
 *    cosmetic ones. A legitimate business reply essentially never
 *    contains literal square brackets, so anything still bracketed at
 *    this point — "[zoom meeting link]", "[insert link here]",
 *    "[TBD]", a leftover unsubstituted "{{meeting_link}}" if the
 *    caller runs this AFTER its own substitution attempt — means
 *    either the model left a spot for information it didn't have, or
 *    (for {{meeting_link}} specifically) the substitution never
 *    actually happened before sending.
 *
 * 2. Any mention of Zoom when zoomCapability is "none". When
 *    zoomCapability is "none", the Zoom tools are not even offered
 *    this run/this action — so there is no legitimate way to have a
 *    real Zoom link or meeting to reference at all. This check only
 *    fires in that all-absent state; it never fires merely because
 *    zoomCapability is "propose_only"/"write" and the text legitimately
 *    quotes a real join URL a successful Zoom creation actually
 *    returned.
 */
export function detectHallucinatedContent(
  text: string,
  permissions: { zoomCapability: "write" | "propose_only" | "none" },
  options?: {
    /**
     * Whether an unsubstituted "{{meeting_link}}" placeholder is
     * currently expected/allowed in this text. True (the default) at
     * proposal-authoring time — propose_zoom_meeting/propose_calendar_event
     * are SUPPOSED to leave this placeholder in confirmationMessage,
     * since the real link doesn't exist yet. Pass `false` when checking
     * text that has already had substitution attempted right before
     * actually sending (see app/dashboard/approvals/actions.ts's
     * sendStoredConfirmation) — at that point a surviving placeholder
     * means substitution failed, not that it hasn't happened yet.
     */
    allowMeetingLinkPlaceholder?: boolean;
  }
): string | null {
  if (!text) {
    return null;
  }

  const allowMeetingLinkPlaceholder =
    options?.allowMeetingLinkPlaceholder ?? true;

  const leftoverBracketMatch = text.match(/\[[^\[\]\n]{1,100}\]/);

  if (leftoverBracketMatch) {
    return (
      `contains an unresolved bracketed placeholder (${JSON.stringify(
        leftoverBracketMatch[0]
      )}) — never send bracketed template variables; either fill in real ` +
      "information you actually have, or omit that sentence entirely."
    );
  }

  if (
    !allowMeetingLinkPlaceholder &&
    /\{\{meeting_link\}\}/.test(text)
  ) {
    return (
      "still contains the literal \"{{meeting_link}}\" placeholder — it was " +
      "never substituted with a real link before sending."
    );
  }

  if (permissions.zoomCapability === "none" && /\bzoom\b/i.test(text)) {
    return (
      "mentions Zoom, but this tenant has no connected Zoom account " +
      "(zoomCapability is \"none\") — there is no real Zoom meeting or link to " +
      "reference; do not claim one exists."
    );
  }

  return null;
}
