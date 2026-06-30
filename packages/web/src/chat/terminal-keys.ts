export const KEY_SEQUENCES: Record<string, string> = {
  Esc: "\x1b",
  Tab: "\t",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  "|": "|",
  "~": "~",
  "/": "/",
  "-": "-",
};

/** Control byte for a letter: Ctrl-C → 0x03, Ctrl-D → 0x04, … (uppercase-insensitive). */
export function ctrlSeq(ch: string): string {
  const c = ch.toLowerCase().charCodeAt(0);
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
  return ch;
}
