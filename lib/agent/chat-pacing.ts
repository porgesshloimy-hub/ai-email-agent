/**
 * ------------------------------------------------------------
 * Channel typing-tracking capability
 * ------------------------------------------------------------
 *
 * The wait-and-pace system (lib/inngest/functions.ts's
 * processDelayedChatReply) depends on a real signal: can this channel
 * even tell us the owner is actively typing? Today, only the web
 * widget/full-page chat can (it pings `POST /api/agent-chat/typing`
 * from the composer). A channel with no way to detect typing at all —
 * a hypothetical future plain-SMS conversational surface, for
 * instance — has nothing for the Phase A/B "did they start typing"
 * check to actually check. Applying the wait anyway would just be an
 * arbitrary delay with no real signal behind it, which isn't the
 * point — the whole design is "wait to see if they're composing more,"
 * not "always feel slow."
 *
 * For a channel not in this set, the wait/pacing system should be
 * skipped entirely — respond as fast as the backend actually can.
 *
 * Currently only "web" is a real channel that goes through this async
 * event-driven reply system at all — Google Chat's webhook still calls
 * handleChatMessage() synchronously and directly (see
 * app/api/webhooks/google-chat/route.ts), bypassing this entire system,
 * and WhatsApp/SMS aren't built as conversational surfaces in this
 * codebase yet at all (see README's "Remaining Product Work"). This
 * function is the intended extension point for when those channels
 * are wired up — add a channel here only once it genuinely has a real
 * typing signal to check.
 */
const TYPING_TRACKING_CHANNELS = new Set(["web"]);

export function channelSupportsTypingTracking(channel: string): boolean {
  return TYPING_TRACKING_CHANNELS.has(channel);
}

/**
 * ------------------------------------------------------------
 * Per-message typing delay calculation
 * ------------------------------------------------------------
 *
 * Moved here from AgentChatPanel.tsx per explicit request — not yet to
 * make it work across other channels (Google Chat/WhatsApp aren't
 * wired onto this async system at all yet — see the channel-capability
 * note above), but so the calculation itself lives in the backend now,
 * as the right foundation for when those channels are eventually built
 * on top of it, rather than being trapped inside a React component
 * that only the web widget ever runs.
 *
 * Used by lib/agent/chat.ts's persist loop to introduce a REAL wait
 * between persisting each part of a split reply — the delay is
 * genuine backend time now, not a client-side simulation layered on
 * top of already-delivered content.
 */
const MIN_TYPING_DELAY_MS = 1200;
const MAX_TYPING_DELAY_MS = 5500;
/** Roughly a human texting pace, varied per message. */
const MIN_MS_PER_CHAR = 25;
const MAX_MS_PER_CHAR = 55;
/** ~1-in-15 messages gets an extra "thinking mid-typing" pause. */
const THINKING_PAUSE_CHANCE = 1 / 15;
const THINKING_PAUSE_MIN_MS = 3000;
const THINKING_PAUSE_MAX_MS = 7000;
/**
 * ~1-in-5 messages gets its whole computed delay stretched by an extra
 * 20-35% — separate from the thinking pause above (a flat added
 * chunk), this instead scales the WHOLE duration, so it's not always
 * the exact same length for a given character count either.
 */
const LENGTH_BOOST_CHANCE = 1 / 5;
const LENGTH_BOOST_MIN = 1.2;
const LENGTH_BOOST_MAX = 1.35;

export function calculateTypingDelayMs(content: string): number {
  const msPerChar = MIN_MS_PER_CHAR + Math.random() * (MAX_MS_PER_CHAR - MIN_MS_PER_CHAR);
  const typingDelay = content.length * msPerChar;
  let clampedTypingDelay = Math.min(Math.max(typingDelay, MIN_TYPING_DELAY_MS), MAX_TYPING_DELAY_MS);

  if (Math.random() < LENGTH_BOOST_CHANCE) {
    const boostFactor = LENGTH_BOOST_MIN + Math.random() * (LENGTH_BOOST_MAX - LENGTH_BOOST_MIN);
    clampedTypingDelay = clampedTypingDelay * boostFactor;
  }

  const thinkingPause =
    Math.random() < THINKING_PAUSE_CHANCE
      ? THINKING_PAUSE_MIN_MS + Math.random() * (THINKING_PAUSE_MAX_MS - THINKING_PAUSE_MIN_MS)
      : 0;

  return Math.round(clampedTypingDelay + thinkingPause);
}
