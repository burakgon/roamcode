/** Termux-style mobile key bar: two rows of flat, evenly-spread keys the phone keyboard lacks. Presentational
 *  only — TerminalView owns the state and decides what each key emits (mode-aware cursor keys + the sticky
 *  Ctrl/Alt modifiers the next REAL keystroke picks up). All keys fit at once — no horizontal scrolling.
 *
 *  Every button uses onPointerDown=preventDefault so a tap NEVER moves focus off xterm's hidden textarea —
 *  otherwise tapping a key would dismiss the on-screen keyboard and break typing. (pointerdown fires for BOTH
 *  touch and mouse, unlike mousedown which is unreliable/late on touch.) */
export function TerminalKeyBar({
  ctrlArmed,
  onToggleCtrl,
  altArmed,
  onToggleAlt,
  onKey,
  onSelect,
  selectOn,
}: {
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  altArmed: boolean;
  onToggleAlt: () => void;
  onKey: (label: string) => void;
  /** Toggle the "select text" overlay — a plain, natively-selectable copy of the buffer. */
  onSelect: () => void;
  /** Whether the select overlay is open (drives the button's active highlight). */
  selectOn: boolean;
}) {
  const keep = (e: React.PointerEvent) => e.preventDefault(); // don't steal focus from the terminal
  // Two rows mirroring Termux's extra-keys bar — with Select in the "/" slot, and Ctrl/Alt as sticky modifiers.
  type Cell = { label: string; aria: string; on: () => void; active?: boolean };
  const rows: Cell[][] = [
    [
      { label: "ESC", aria: "Escape", on: () => onKey("Esc") },
      { label: "Select", aria: "Select text", on: onSelect, active: selectOn },
      { label: "/", aria: "Slash", on: () => onKey("/") },
      { label: "HOME", aria: "Home", on: () => onKey("Home") },
      { label: "↑", aria: "Arrow up", on: () => onKey("ArrowUp") },
      { label: "END", aria: "End", on: () => onKey("End") },
      { label: "PGUP", aria: "Page up", on: () => onKey("PageUp") },
    ],
    [
      { label: "⇥", aria: "Tab", on: () => onKey("Tab") },
      { label: "CTRL", aria: "Control (sticky)", on: onToggleCtrl, active: ctrlArmed },
      { label: "ALT", aria: "Alt (sticky)", on: onToggleAlt, active: altArmed },
      { label: "←", aria: "Arrow left", on: () => onKey("ArrowLeft") },
      { label: "↓", aria: "Arrow down", on: () => onKey("ArrowDown") },
      { label: "→", aria: "Arrow right", on: () => onKey("ArrowRight") },
      { label: "PGDN", aria: "Page down", on: () => onKey("PageDown") },
    ],
  ];
  return (
    <div className="rc-termkeys" role="toolbar" aria-label="Terminal keys">
      {rows.map((row, i) => (
        <div className="rc-termkeys__row" key={i}>
          {row.map((c) => (
            <button
              key={c.label}
              type="button"
              aria-label={c.aria}
              {...(c.active !== undefined ? { "aria-pressed": c.active } : {})}
              className={c.active ? "rc-tk__key is-on" : "rc-tk__key"}
              onPointerDown={keep}
              onClick={c.on}
            >
              {c.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
