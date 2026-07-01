import { Icon, type IconName } from "../ui/Icon";

/** Termux-style mobile key bar: two rows of flat, evenly-spread keys the phone keyboard lacks. Presentational
 *  only — TerminalView owns the state and decides what each key emits (mode-aware cursor keys + the sticky
 *  Ctrl/Alt modifiers the next REAL keystroke picks up). All keys fit at once — no horizontal scrolling.
 *
 *  Every button preventDefaults on MOUSEDOWN so a tap never moves focus off xterm's hidden textarea — that's
 *  what keeps the on-screen keyboard up. On iOS the focus shift happens on the compat `mousedown`, NOT on
 *  pointerdown, so preventing pointerdown (what we did before) let the blur through and the keyboard closed
 *  when arming Ctrl/Alt; and a programmatic term.focus() can't reopen it (iOS only opens the keyboard on a
 *  direct tap of the input). The action fires on `click`, which still fires after a preventDefaulted mousedown. */
export function TerminalKeyBar({
  ctrlArmed,
  onToggleCtrl,
  altArmed,
  onToggleAlt,
  onKey,
  onSelect,
  selectOn,
  onPaste,
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
  /** Open the paste/compose box (type or paste text, then send it to the terminal). */
  onPaste: () => void;
}) {
  // Two rows mirroring Termux's extra-keys bar — Select + Paste take the "/" and "-" slots, Ctrl/Alt are sticky.
  type Cell = { label: string; aria: string; on: () => void; active?: boolean; icon?: IconName };
  const rows: Cell[][] = [
    [
      { label: "ESC", aria: "Escape", on: () => onKey("Esc") },
      { label: "Select", aria: "Select text", on: onSelect, active: selectOn },
      { label: "Paste", aria: "Paste or type text to send", on: onPaste, icon: "keyboard" },
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
              // preventDefault on mousedown keeps focus on the terminal (→ keyboard stays up); onClick runs the key.
              onMouseDown={(e) => e.preventDefault()}
              onClick={c.on}
            >
              {c.icon ? <Icon name={c.icon} size={18} /> : c.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
