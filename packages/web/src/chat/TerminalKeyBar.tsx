import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
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

/** setPointerCapture / releasePointerCapture wrapped so they can NEVER throw into a key handler. On iOS
 *  setPointerCapture throws for some touch pointerIds (NotFoundError); the bare `?.` only guards a MISSING
 *  method, not a throw — an uncaught throw here would swallow the whole keypress (this is why holding "←"
 *  could register nothing). Capture is a best-effort nicety (keeps a held repeat key firing through a slight
 *  finger drift); losing it must degrade to "still fires," never to a dead key. */
function tryCapture(el: Element, id: number) {
  try {
    (el as HTMLElement).setPointerCapture?.(id);
  } catch {
    /* capture not available for this pointer — the key still fired */
  }
}
function tryRelease(el: Element, id: number) {
  try {
    if ((el as HTMLElement).hasPointerCapture?.(id)) (el as HTMLElement).releasePointerCapture?.(id);
  } catch {
    /* wasn't captured */
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
 *  direct tap of the input).
 *
 *  EVERY key now fires on POINTERDOWN — not the synthesized `click`. iOS Safari drops the click intermittently
 *  under `touch-action: none` + a fast tap, which is why ESC "sometimes" did nothing and CTRL/ALT wouldn't arm
 *  (they looked "not sticky"). pointerdown is the reliable primitive. `click` is KEPT purely as a deduped
 *  fallback so VoiceOver / a hardware keyboard (which activate via a synthesized click, not a pointer) still
 *  work — it's ignored when a pointer just fired the same key. Press-and-hold repeat keys (arrows / PgUp /
 *  PgDn) additionally keep firing while held and best-effort-capture the pointer so a slight drift doesn't
 *  stop the repeat. */
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
  // Timestamp of the last pointer-driven fire, so the `click` fallback (kept for VoiceOver / hardware
  // keyboards, which activate via a synthesized click) can DEDUPE — a touch fires pointerdown then a
  // synthesized click ~300ms later; without this the key would fire twice.
  const lastPointerFire = useRef(0);
  // Two rows mirroring Termux's extra-keys bar. `repeat` marks the keys that press-and-hold (cursor motion /
  // paging) so holding them auto-repeats.
  type Cell = { label: string; aria: string; on: () => void; active?: boolean; icon?: IconName; repeat?: boolean };
  const rows: Cell[][] = [
    [
      { label: "ESC", aria: "Escape", on: () => onKey("Esc") },
      { label: "PGUP", aria: "Page up", on: () => onKey("PageUp"), repeat: true },
      { label: "PGDN", aria: "Page down", on: () => onKey("PageDown"), repeat: true },
      { label: "HOME", aria: "Home", on: () => onKey("Home") },
      { label: "↑", aria: "Arrow up", on: () => onKey("ArrowUp"), repeat: true },
      { label: "END", aria: "End", on: () => onKey("End") },
      { label: "Select", aria: "Select text", on: onSelect, active: selectOn },
    ],
    [
      { label: "⇥", aria: "Tab", on: () => onKey("Tab") },
      { label: "CTRL", aria: "Control (sticky)", on: onToggleCtrl, active: ctrlArmed },
      { label: "ALT", aria: "Alt (sticky)", on: onToggleAlt, active: altArmed },
      { label: "←", aria: "Arrow left", on: () => onKey("ArrowLeft"), repeat: true },
      { label: "↓", aria: "Arrow down", on: () => onKey("ArrowDown"), repeat: true },
      { label: "→", aria: "Arrow right", on: () => onKey("ArrowRight"), repeat: true },
      { label: "Paste", aria: "Paste or type text to send", on: onPaste, icon: "keyboard" },
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
              // POINTERDOWN fires the action for every key (reliable where the synthesized `click` is flaky).
              // Repeat keys start the auto-repeat + best-effort-capture the pointer; simple keys fire once.
              // The action runs BEFORE tryCapture so a capture that throws can never swallow the press.
              onPointerDown={(e: ReactPointerEvent) => {
                lastPointerFire.current = Date.now();
                if (c.repeat) {
                  repeat.start(c.on);
                  tryCapture(e.currentTarget, e.pointerId);
                } else {
                  haptic();
                  c.on();
                }
              }}
              {...(c.repeat
                ? {
                    onPointerUp: (e: ReactPointerEvent) => {
                      tryRelease(e.currentTarget, e.pointerId);
                      repeat.stop();
                    },
                    onPointerCancel: (e: ReactPointerEvent) => {
                      tryRelease(e.currentTarget, e.pointerId);
                      repeat.stop();
                    },
                    // Backstop: only fires when capture DIDN'T take (a captured pointer suppresses leave), so
                    // it ends a runaway repeat if the finger drifts off an uncaptured key — never premature.
                    onPointerLeave: () => repeat.stop(),
                  }
                : {})}
              // `click` is the deduped fallback ONLY — VoiceOver / a hardware keyboard activate via a
              // synthesized click, not a pointer sequence. Ignored when a pointer just fired the same key.
              onClick={() => {
                if (Date.now() - lastPointerFire.current < 700) return;
                if (c.repeat) repeat.stop();
                haptic();
                c.on();
              }}
            >
              {c.icon ? <Icon name={c.icon} size={18} /> : c.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
