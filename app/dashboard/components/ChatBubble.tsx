import type { CSSProperties, ReactNode } from "react";
import { ChatBubbleTail, TAIL_POSITION } from "./ChatBubbleTail";

/**
 * One chat bubble, with an optional tail. Must be rendered inside a
 * `relative` wrapper — the tail is positioned against it.
 *
 * When there is a tail, the bubble corner it grows out of is squared
 * off (inline style, so it reliably beats the shorthand radius class).
 */
export function ChatBubble({
  isOwner,
  hasTail,
  pending = false,
  className = "",
  children,
}: {
  isOwner: boolean;
  hasTail: boolean;
  pending?: boolean;
  className?: string;
  children: ReactNode;
}) {
  let squaredCorner: CSSProperties | undefined;

  if (hasTail) {
    const atTop = TAIL_POSITION === "top";
    squaredCorner = isOwner
      ? atTop
        ? { borderTopRightRadius: 0 }
        : { borderBottomRightRadius: 0 }
      : atTop
        ? { borderTopLeftRadius: 0 }
        : { borderBottomLeftRadius: 0 };
  }

  return (
    <>
      <div
        style={squaredCorner}
        className={`max-w-full whitespace-pre-wrap break-words rounded-panel px-3.5 py-2.5 text-sm leading-relaxed shadow-panel ${
          isOwner ? "bg-blue-100 text-ink" : "bg-[#ECEEF1] text-ink"
        } ${pending ? "opacity-60" : ""} ${className}`}
      >
        {children}
      </div>

      {hasTail && <ChatBubbleTail isOwner={isOwner} dimmed={pending} />}
    </>
  );
}
