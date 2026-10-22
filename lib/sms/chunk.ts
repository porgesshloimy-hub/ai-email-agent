/**
 * Breaks one message into text-message-sized pieces at natural
 * boundaries, instead of cutting it off.
 *
 * Twilio rejects anything over 1,600 characters, and lib/notify.ts
 * trims to 1,500 as a last resort with a pointer to the dashboard chat
 * — but an owner texting from a phone with no web access can't follow
 * that pointer. A long message (a forwarded email kept together with
 * [[keep]], see lib/agent/reply-parts.ts) must reach them whole, so it
 * is split across several texts, in order, rather than truncated.
 *
 * Preference order for where to cut: a paragraph break, then a line
 * break, then the end of a sentence, then a space; a hard cut at the
 * limit only for a single unbroken run longer than the limit (a long
 * URL, say). A cut is never placed in the first third of a chunk, so a
 * stray early break can't produce a tiny first text and a huge second.
 */
export const SMS_CHUNK_LIMIT = 1500;

export function chunkForSms(text: string, limit: number = SMS_CHUNK_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed ? [trimmed] : [];

  const chunks: string[] = [];
  let rest = trimmed;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const minCut = Math.floor(limit / 3);

    const cut = findCut(window, minCut);
    const piece = (cut > 0 ? rest.slice(0, cut) : window).trimEnd();

    chunks.push(piece);
    rest = rest.slice(cut > 0 ? cut : limit).trimStart();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

function findCut(window: string, minCut: number): number {
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= minCut) return paragraph;

  const line = window.lastIndexOf("\n");
  if (line >= minCut) return line;

  // End of a sentence: punctuation followed by a space.
  const sentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? ")
  );
  if (sentence >= minCut) return sentence + 1;

  const space = window.lastIndexOf(" ");
  if (space >= minCut) return space;

  return -1;
}
