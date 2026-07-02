import { useEffect, useRef } from "react";
import { Icon, type IconName } from "../ui/Icon";

/** A light, feature-detected haptic tick for a key tap (no-op where the device / browser lacks the API). */
function haptic() {
  if (typeof navigator !== "undefined") {
    try {
      navigator.vibrate?.(8);
    } catch {
      /* unsupported */
    }
  }
}

/** Press-and-hold auto-repeat: fire once immediately, then (after a short delay) repeat while held. Used for
 *  the arrows + PgUp/PgDn so moving the cursor / scrolling a menu isn't one-tap-per-step. Cleared on release
 *  (pointerup / leave / cancel) and on unmount. */
function useAutoRepeat() {
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval> }>({});
  const stop = () => {
    if (timers.current.delay) clearTimeout(timers.current.delay);
    if (timers.current.interval) clearInterval(timers.current.interval);
    timers.current = {};
  };
  const start = (fn: () => void) => {
    stop();
    haptic();
    fn(); // immediate first step
    timers.current.delay = setTimeout(() => {
      timers.current.interval = setInterval(fn, 70);
    }, 380);
  };
  useEffect(() => stop, []); // clear any pending timers on unmount
  return { start, stop };
}

/** Termux-style mobile key bar: two rows of flat, evenly-spread keys the phone keyboard lacks. Presentational
 *  only — TerminalView owns the state and decides what each key emits (mode-aware cursor keys + the sticky
 *  Ctrl/Alt modifiers the next REAL keystroke picks up + one-tap control chords). All keys fit at once — no
 *  horizontal scrolling.
 *
 *  Every button preventDefaults on MOUSEDOWN so a tap never moves focus off xterm's hidden textarea — that's
 *  what keeps the on-screen keyboard up. On iOS the focus shift happens on the compat `mousedown`, NOT on
 *  pointerdown, so preventing pointerdown (what we did before) let the blur through and the keyboard closed
 *  when arming Ctrl/Alt; and a programmatic term.focus() can't reopen it (iOS only opens the keyboard on a
 *  direct tap of the input). Simple keys fire on `click` (still fires after a preventDefaulted mousedown);
 *  press-and-hold repeat keys (arrows / PgUp / PgDn) drive off pointer down/up so holding auto-repeats. */
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
  const repeat = useAutoRepeat();
  // Two rows mirroring Termux's extra-keys bar. `repeat` marks the keys that press-and-hold (cursor motion /
  // paging) so holding them auto-repeats.
  type Cell = { label: string; aria: string; on: () => void; active?: boolean; icon?: IconName; repeat?: boolean };
  const rows: Cell[][] = [
    [
      { label: "ESC", aria: "Escape", on: () => onKey("Esc") },
      { label: "Select", aria: "Select text", on: onSelect, active: selectOn },
      { label: "Paste", aria: "Paste or type text to send", on: onPaste, icon: "keyboard" },
      { label: "HOME", aria: "Home", on: () => onKey("Home") },
      { label: "↑", aria: "Arrow up", on: () => onKey("ArrowUp"), repeat: true },
      { label: "END", aria: "End", on: () => onKey("End") },
      { label: "PGUP", aria: "Page up", on: () => onKey("PageUp"), repeat: true },
    ],
    [
      { label: "⇥", aria: "Tab", on: () => onKey("Tab") },
      { label: "CTRL", aria: "Control (sticky)", on: onToggleCtrl, active: ctrlArmed },
      { label: "ALT", aria: "Alt (sticky)", on: onToggleAlt, active: altArmed },
      { label: "←", aria: "Arrow left", on: () => onKey("ArrowLeft"), repeat: true },
      { label: "↓", aria: "Arrow down", on: () => onKey("ArrowDown"), repeat: true },
      { label: "→", aria: "Arrow right", on: () => onKey("ArrowRight"), repeat: true },
      { label: "PGDN", aria: "Page down", on: () => onKey("PageDown"), repeat: true },
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
              // preventDefault on mousedown keeps focus on the terminal (→ keyboard stays up).
              onMouseDown={(e) => e.preventDefault()}
              {...(c.repeat
                ? {
                    // Press-and-hold auto-repeat: fire on pointer down, keep firing while held, stop on release.
                    onPointerDown: () => repeat.start(c.on),
                    onPointerUp: repeat.stop,
                    onPointerLeave: repeat.stop,
                    onPointerCancel: repeat.stop,
                  }
                : {
                    onClick: () => {
                      haptic();
                      c.on();
                    },
                  })}
            >
              {c.icon ? <Icon name={c.icon} size={18} /> : c.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
