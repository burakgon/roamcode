const graphemeSegmenter =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

function splitGraphemes(value: string): string[] {
  if (!graphemeSegmenter) return Array.from(value);
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

/**
 * Convert one mobile IME candidate revision into terminal input. Shared graphemes stay in the PTY; only the
 * changed suffix is erased and replaced, keeping composition responsive without duplicating its final commit.
 */
export function compositionDelta(previousText: string, nextText: string): string {
  if (previousText === nextText) return "";
  const previous = splitGraphemes(previousText);
  const next = splitGraphemes(nextText);
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++;
  return "\x7f".repeat(previous.length - prefix) + next.slice(prefix).join("");
}
