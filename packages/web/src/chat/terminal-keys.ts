// Fixed sequences for keys whose bytes never depend on terminal mode (Esc/Tab/PgUp/PgDn + punctuation a
// phone keyboard hides). Cursor keys (arrows/Home/End) are NOT here — they're mode-dependent (see below).
export const KEY_SEQUENCES: Record<string, string> = {
  Esc: "\x1b",
  Tab: "\t",
  ShiftTab: "\x1b[Z", // back-tab (reverse focus / reverse-complete in TUIs)
  Delete: "\x1b[3~", // forward-delete
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  "|": "|",
  "~": "~",
  "/": "/",
  "-": "-",
  "@": "@", // file-mention prefix (claude's @-path completer)
};

// Cursor keys depend on DECCKM (application-cursor-key mode): full-screen TUIs like the claude CLI switch it
// on, and then the CORRECT bytes are SS3 (`\x1bO…`), not CSI (`\x1b[…`). [normalMode, applicationMode].
export const CURSOR_SEQUENCES: Record<string, readonly [string, string]> = {
  ArrowUp: ["\x1b[A", "\x1bOA"],
  ArrowDown: ["\x1b[B", "\x1bOB"],
  ArrowRight: ["\x1b[C", "\x1bOC"],
  ArrowLeft: ["\x1b[D", "\x1bOD"],
  Home: ["\x1b[H", "\x1bOH"],
  End: ["\x1b[F", "\x1bOF"],
};

/** Mode-correct sequence for a cursor key, or undefined if `label` isn't a cursor key. */
export function cursorSeq(label: string, applicationCursorMode: boolean): string | undefined {
  const pair = CURSOR_SEQUENCES[label];
  return pair ? pair[applicationCursorMode ? 1 : 0] : undefined;
}

/** The raw bytes a key-bar label should send, picking the cursor-mode-correct form for arrows/Home/End. */
export function keySequence(label: string, applicationCursorMode: boolean): string {
  return cursorSeq(label, applicationCursorMode) ?? KEY_SEQUENCES[label] ?? label;
}

/** Control byte for a single printable char: Ctrl-A → 0x01 … Ctrl-Z → 0x1a (uppercase-insensitive); plus the
 *  other useful controls: Ctrl-Space/@ → 0x00, Ctrl-[ → 0x1b, Ctrl-\\ → 0x1c, Ctrl-] → 0x1d, Ctrl-/ or _ → 0x1f.
 *  Anything that isn't a single printable char is returned unchanged (callers pass single chars only). */
export function ctrlSeq(ch: string): string {
  if (ch.length !== 1) return ch;
  const c = ch.toLowerCase().charCodeAt(0);
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 96); // a-z → 0x01-0x1a
  if (ch === " " || ch === "@") return "\x00";
  if (ch === "[") return "\x1b";
  if (ch === "\\") return "\x1c";
  if (ch === "]") return "\x1d";
  if (ch === "^") return "\x1e"; // Ctrl-^ / Ctrl-6 → RS
  if (ch === "/" || ch === "_") return "\x1f";
  return ch;
}
