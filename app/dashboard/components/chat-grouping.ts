/**
 * How the chat widget decides which messages belong together.
 *
 * A "group" is a run of consecutive messages from the same sender that
 * show the same time label — typically one reply the agent split into
 * several bubbles, or a quick burst from the owner. The widget uses
 * this one rule for two things, so they can never disagree:
 *
 *   - the timestamp: shown once, under the LAST message of a group
 *   - the bubble tail: drawn on the FIRST message of a group, the way
 *     WhatsApp marks "a new message starts here" (see ChatBubble.tsx)
 *
 * Kept free of React so the rule is plain and testable.
 */

export interface GroupableMessage {
  role: string;
  created_at: string;
}

export function formatTimeLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * True when `current` begins a new group — i.e. it was sent by someone
 * different than `previous`, or at a different displayed time. With no
 * previous message (the first one in the conversation) it always does.
 *
 * Because groups are symmetric, "does the message AFTER this one start
 * a new group?" is also exactly "is this the last message of its
 * group?", which is how the timestamp uses it.
 */
export function startsNewMessageGroup(
  previous: GroupableMessage | undefined,
  current: GroupableMessage
): boolean {
  if (!previous) return true;
  if (previous.role !== current.role) return true;
  return formatTimeLabel(previous.created_at) !== formatTimeLabel(current.created_at);
}
