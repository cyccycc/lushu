/**
 * Marks that should not start a wrapped line. Opening brackets stay allowed.
 * ASCII and fullwidth closers, pauses, and the ellipsis are included.
 */
const WRAP_PUNCTUATION = new Set(
  Array.from("。，、；：！？…·・,.)]}!?;:》」』】）〉"),
);

export function isWrapPunctuation(ch: string): boolean {
  return WRAP_PUNCTUATION.has(ch);
}

/**
 * Wrap `text` to `maxWidth` using `measure`. When the next glyph would overflow
 * and it is punctuation, pull the previous glyph onto the new line so the line
 * does not open on that mark. The previous line keeps at least one character.
 */
export function wrapMeasuredText(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (line && measure(line + ch) > maxWidth) {
      let kept = line;
      let start = ch.trim() ? ch : "";
      if (start && isWrapPunctuation(Array.from(start)[0] ?? "")) {
        const current = Array.from(kept);
        while (current.length > 1 && isWrapPunctuation(Array.from(start)[0] ?? "")) {
          start = (current.pop() ?? "") + start;
        }
        kept = current.join("");
      }
      if (kept) lines.push(kept);
      line = start;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}
