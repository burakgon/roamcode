/**
 * Pure matcher for the terminal find bar — kept dependency-free (NO xterm search addon: the lockfile must
 * not grow for a substring scan over a 1000-line scrollback). TerminalView dumps `term.buffer.active`
 * lines via translateToString and hands them here; navigation then drives term.scrollToLine + term.select
 * with the returned positions.
 */

/** One match: the buffer row (absolute, scrollback included), the start column, and the match length —
 *  exactly the triple xterm's `select(col, row, length)` wants. */
export interface BufferMatch {
  row: number;
  col: number;
  length: number;
}

/**
 * Case-insensitive substring search over buffer lines. Finds EVERY (non-overlapping) occurrence per line,
 * in top-to-bottom / left-to-right order. An empty query matches nothing (searching "" would "match"
 * everywhere and make the count meaningless). Matching is per-line only — the terminal grid has no
 * reliable cross-line string semantics (wrapped rows read as separate lines here; acceptable for a
 * find-in-scrollback).
 */
export function searchBuffer(lines: string[], q: string): BufferMatch[] {
  if (q.length === 0) return [];
  const needle = q.toLowerCase();
  const matches: BufferMatch[] = [];
  for (let row = 0; row < lines.length; row++) {
    const hay = (lines[row] ?? "").toLowerCase();
    let from = 0;
    for (;;) {
      const col = hay.indexOf(needle, from);
      if (col === -1) break;
      matches.push({ row, col, length: q.length });
      from = col + needle.length; // non-overlapping: resume AFTER the hit
    }
  }
  return matches;
}
