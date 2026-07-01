/** Termux-style mobile helper row: the TUI keys a phone keyboard lacks. Presentational only — TerminalView
 *  owns the state and decides what each key emits (mode-aware cursor keys, the sticky-Ctrl modifier that the
 *  next REAL keystroke picks up, etc.). Horizontally scrollable so the full set fits any width.
 *
 *  Every button uses onPointerDown=preventDefault so a tap NEVER moves focus off xterm's hidden textarea —
 *  otherwise tapping a key would dismiss the on-screen keyboard and break typing. (pointerdown fires for BOTH
 *  touch and mouse, unlike mousedown which is unreliable/late on touch.) */
export function TerminalKeyBar({
  ctrlArmed,
  onToggleCtrl,
  onKey,
  onCtrlChord,
  onSelect,
  selectOn,
  onPaste,
}: {
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  onKey: (label: string) => void;
  onCtrlChord: (letter: string) => void;
  /** Toggle the "select text" overlay — a plain, natively-selectable copy of the buffer. */
  onSelect: () => void;
  /** Whether the select overlay is open (drives the button's active highlight). */
  selectOn: boolean;
  onPaste?: () => void;
}) {
  const keys = [
    "Esc", "Tab", "ShiftTab",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown", "Delete",
    "/", "-", "|", "~",
  ];
  const keep = (e: React.PointerEvent) => e.preventDefault(); // don't steal focus from the terminal
  return (
    <div className="rc-termkeys" role="toolbar" aria-label="Terminal keys">
      {/* Pinned control (stays visible while the rest of the row scrolls): the Select-text overlay, where
          reading back + copying happens. Scrolling is a TWO-FINGER drag on the terminal (see TerminalView);
          the ▲/▼ scroll, ⤓ jump-to-latest, and Copy buttons were removed as redundant, to save space. */}
      <div className="rc-termkeys__scroll">
        <button
          type="button"
          aria-label="Select text"
          aria-pressed={selectOn}
          title="Select text (long-press to select, then Copy)"
          className={selectOn ? "rc-termkeys__sel is-on" : "rc-termkeys__sel"}
          onPointerDown={keep}
          onClick={onSelect}
        >
          Select
        </button>
      </div>
      <button
        type="button"
        aria-pressed={ctrlArmed}
        className={ctrlArmed ? "rc-termkeys__ctrl is-on" : "rc-termkeys__ctrl"}
        onPointerDown={keep}
        onClick={onToggleCtrl}
      >
        Ctrl
      </button>
      {keys.map((k) => (
        <button type="button" key={k} aria-label={k} onPointerDown={keep} onClick={() => onKey(k)}>
          {labelFor(k)}
        </button>
      ))}
      <button type="button" aria-label="Ctrl-C" onPointerDown={keep} onClick={() => onCtrlChord("c")}>
        ^C
      </button>
      <button type="button" aria-label="Ctrl-D" onPointerDown={keep} onClick={() => onCtrlChord("d")}>
        ^D
      </button>
      {onPaste && (
        <button type="button" aria-label="Paste" onPointerDown={keep} onClick={onPaste}>
          Paste
        </button>
      )}
    </div>
  );
}

function labelFor(k: string): string {
  return (
    {
      ArrowUp: "↑",
      ArrowDown: "↓",
      ArrowLeft: "←",
      ArrowRight: "→",
      ShiftTab: "⇤",
      Home: "Home",
      End: "End",
      PageUp: "PgUp",
      PageDown: "PgDn",
      Delete: "Del",
    }[k] ?? k
  );
}
