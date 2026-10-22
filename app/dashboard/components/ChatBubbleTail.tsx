/**
 * The small protrusion on a chat bubble that marks "a new message
 * starts here", as in WhatsApp and iMessage. Drawn only on the first
 * bubble of a group (see chat-grouping.ts), never on the follow-ups.
 *
 * Positioned absolutely against the bubble's own `relative` wrapper,
 * so it costs no layout space. The matching bubble corner is squared
 * off by ChatBubble so the tail grows out of an edge instead of
 * sitting beside a rounded corner.
 */

/**
 * "top" is WhatsApp's look (tail at the upper outer corner, which suits
 * a tail that marks the START of a group); "bottom" is iMessage's.
 * Switching this one value flips both the tail and the squared corner.
 */
export const TAIL_POSITION: "top" | "bottom" = "top";

// Bubble colors, duplicated here only because an SVG fill can't read a
// background class. Keep in sync with ChatBubble.tsx.
const OWNER_FILL = "fill-blue-100";
const AGENT_FILL = "fill-[#ECEEF1]";

export function ChatBubbleTail({ isOwner, dimmed = false }: { isOwner: boolean; dimmed?: boolean }) {
  const atTop = TAIL_POSITION === "top";

  const vertical = atTop ? "top-0" : "bottom-0 -scale-y-100";
  // A half-pixel overlap with the bubble, so no hairline seam shows
  // between them at fractional zoom levels.
  const horizontal = isOwner
    ? "left-[calc(100%-0.5px)]"
    : "right-[calc(100%-0.5px)] -scale-x-100";

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 8 11"
      width="8"
      height="11"
      className={`pointer-events-none absolute ${vertical} ${horizontal} ${
        isOwner ? OWNER_FILL : AGENT_FILL
      } ${dimmed ? "opacity-60" : ""}`}
    >
      <path d="M0 0H5C6.8 0 7.6 1.4 6.6 2.7L0 11Z" />
    </svg>
  );
}
