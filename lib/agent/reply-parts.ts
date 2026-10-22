/**
 * Splits an agent reply into the separate messages it will be delivered
 * as — one chat bubble, or one text, per part.
 *
 * Two things start a new message:
 *   - an explicit "|||"
 *   - a blank line between paragraphs
 * (the blank-line rule exists because models forget the explicit marker
 * often enough that relying on it alone gave inconsistent splitting).
 *
 * That default is wrong for content whose paragraph breaks are PART OF
 * the content rather than separate thoughts — the clearest case being a
 * forwarded or quoted email, which would otherwise arrive as five
 * disconnected messages. For that, anything wrapped in
 *
 *     [[keep]] ... [[/keep]]
 *
 * is protected: nothing inside it is split, however many paragraphs or
 * "|||" it contains, and it comes out as exactly one part with the
 * markers removed. The model is told when to use this in chat.ts's
 * system prompt; this module is what actually enforces it, so the
 * guarantee doesn't depend on the model being consistent about anything
 * but placing the markers.
 *
 * Applies to every chat channel, since all of them share this function.
 */

const KEEP_BLOCK = /\[\[keep\]\]([\s\S]*?)(?:\[\[\/keep\]\]|$)/gi;
const STRAY_MARKER = /\[\[\/?keep\]\]/gi;

// Private-use characters: can't collide with anything a model or an
// email would plausibly contain, and contain no whitespace or "|||" so
// the splitter below can never cut through a placeholder.
const PLACEHOLDER = /\uE000KEEP(\d+)\uE001/g;

export function splitReplyIntoParts(text: string): string[] {
  const protectedBlocks: string[] = [];

  // An opening marker with no closing one protects everything after it —
  // a truncated or forgetful reply keeps the content together rather
  // than splitting it, which is the safer way to be wrong.
  const withPlaceholders = text.replace(KEEP_BLOCK, (_match, inner: string) => {
    protectedBlocks.push(inner.trim());
    return `\uE000KEEP${protectedBlocks.length - 1}\uE001`;
  });

  return withPlaceholders
    .split(/\|\|\||\n\s*\n+/)
    .map((part) =>
      part
        .replace(PLACEHOLDER, (_m, index: string) => protectedBlocks[Number(index)] ?? "")
        // Never let a marker reach the owner, whether it was used
        // correctly, nested, or left dangling.
        .replace(STRAY_MARKER, "")
        .trim()
    )
    .filter((part) => part.length > 0);
}
