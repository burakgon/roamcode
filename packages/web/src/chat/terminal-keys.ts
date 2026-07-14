// Fixed sequences for keys whose bytes never depend on terminal mode (Esc/Tab/PgUp/PgDn + punctuation a
// phone keyboard hides). Cursor keys (arrows/Home/End) are NOT here — they're mode-dependent (see below).
export const KEY_SEQUENCES: Record<string, string> = {
  Esc: "\x1b",
  Tab: "\t",
  Enter: "\r",
  Backspace: "\x7f",
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

export interface TerminalModifiers {
  ctrl: boolean;
  alt: boolean;
  /** Physical Shift is folded in for hardware-keyboard special keys. The mobile bar never locks Shift. */
  shift?: boolean;
}

export const NO_TERMINAL_MODIFIERS: TerminalModifiers = { ctrl: false, alt: false };

function hasModifiers(modifiers: TerminalModifiers): boolean {
  return modifiers.ctrl || modifiers.alt || !!modifiers.shift;
}

/** Xterm/VT modifier parameter: Shift=2, Alt=3, Ctrl=5, Alt+Ctrl=7, with combinations additive. */
function modifierParameter(modifiers: TerminalModifiers): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

const CURSOR_FINAL: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

/** Mode-correct sequence for a cursor key, or undefined if `label` isn't a cursor key. */
export function cursorSeq(label: string, applicationCursorMode: boolean): string | undefined {
  const pair = CURSOR_SEQUENCES[label];
  return pair ? pair[applicationCursorMode ? 1 : 0] : undefined;
}

/** The raw bytes a key-bar label should send, picking the cursor-mode-correct form for arrows/Home/End. */
export function keySequence(
  label: string,
  applicationCursorMode: boolean,
  modifiers: TerminalModifiers = NO_TERMINAL_MODIFIERS,
): string {
  const cursorFinal = CURSOR_FINAL[label];
  if (cursorFinal) {
    return hasModifiers(modifiers)
      ? `\x1b[1;${modifierParameter(modifiers)}${cursorFinal}`
      : (cursorSeq(label, applicationCursorMode) ?? label);
  }

  if (label === "Backspace") {
    const key = modifiers.ctrl ? "\x08" : "\x7f";
    return modifiers.alt ? `\x1b${key}` : key;
  }
  if (label === "Esc") return modifiers.alt ? "\x1b\x1b" : "\x1b";
  if (label === "Enter") return modifiers.alt ? "\x1b\r" : "\r";
  if (label === "Tab") {
    // Ctrl+I is already Tab. Alt remains meaningful, including when Ctrl is locked too; preserve it as the
    // terminal Meta prefix instead of silently dropping the lock.
    const tab = modifiers.shift ? KEY_SEQUENCES.ShiftTab! : "\t";
    return modifiers.alt ? `\x1b${tab}` : tab;
  }

  const tildeCode = label === "PageUp" ? 5 : label === "PageDown" ? 6 : label === "Delete" ? 3 : undefined;
  if (tildeCode !== undefined) {
    return hasModifiers(modifiers) ? `\x1b[${tildeCode};${modifierParameter(modifiers)}~` : `\x1b[${tildeCode}~`;
  }

  const fixed = KEY_SEQUENCES[label];
  if (fixed !== undefined) return modifiedTextSequence(fixed, modifiers);
  return modifiedTextSequence(label, modifiers);
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

/** Apply locked Ctrl/Alt to a single terminal character. Multi-character payloads are paste/composition data
 *  and deliberately pass through unchanged. */
export function modifiedTextSequence(data: string, modifiers: TerminalModifiers): string {
  if (data.length !== 1) return data;
  const key = modifiers.ctrl ? ctrlSeq(data) : data;
  return modifiers.alt ? `\x1b${key}` : key;
}

/** Apply modifier locks to raw data emitted by xterm's mobile/IME path. */
export function modifiedDataSequence(data: string, modifiers: TerminalModifiers): string {
  if (data.length !== 1) return data;
  if (data === "\x7f" || data === "\x08") return keySequence("Backspace", false, modifiers);
  if (data === "\r") return keySequence("Enter", false, modifiers);
  if (data === "\x1b") return keySequence("Esc", false, modifiers);
  if (data === "\t") return keySequence("Tab", false, modifiers);
  return modifiedTextSequence(data, modifiers);
}

/** Convert a concrete DOM key into the same sequence used by the mobile key bar. Undefined means xterm
 *  should retain ownership (IME/dead keys, media keys, Meta shortcuts, and other unrecognized input). */
export function keyboardEventSequence(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  applicationCursorMode: boolean,
  locks: TerminalModifiers,
): string | undefined {
  if (event.metaKey) return undefined;
  const modifiers: TerminalModifiers = {
    ctrl: locks.ctrl || event.ctrlKey,
    alt: locks.alt || event.altKey,
    shift: event.shiftKey,
  };
  const labels: Record<string, string> = {
    Escape: "Esc",
    Enter: "Enter",
    Backspace: "Backspace",
    Delete: "Delete",
    Tab: "Tab",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  const label = labels[event.key];
  if (label) return keySequence(label, applicationCursorMode, modifiers);
  return event.key.length === 1 ? modifiedTextSequence(event.key, modifiers) : undefined;
}
