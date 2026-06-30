import { useState } from "react";
import { KEY_SEQUENCES, ctrlSeq } from "./terminal-keys";

/** Termux-style mobile helper row: the TUI keys a phone keyboard lacks. `Ctrl` is a sticky modifier
 *  applied to the next ordinary key (or the explicit Ctrl-C/Ctrl-D buttons). Emits raw sequences via
 *  onSend. Horizontally scrollable so the full set fits any width. */
export function TerminalKeyBar({ onSend }: { onSend: (seq: string) => void }) {
  const [ctrl, setCtrl] = useState(false);
  const tap = (label: string) => {
    const base = KEY_SEQUENCES[label] ?? label;
    onSend(ctrl ? ctrlSeq(base) : base);
    if (ctrl) setCtrl(false);
  };
  const keys = [
    "Esc", "Tab",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown",
    "/", "-", "|", "~",
  ];
  return (
    <div className="rc-termkeys" role="toolbar" aria-label="Terminal keys">
      <button
        type="button"
        aria-pressed={ctrl}
        className={ctrl ? "rc-termkeys__ctrl is-on" : "rc-termkeys__ctrl"}
        onClick={() => setCtrl((v) => !v)}
      >
        Ctrl
      </button>
      {keys.map((k) => (
        <button type="button" key={k} aria-label={k} onClick={() => tap(k)}>
          {labelFor(k)}
        </button>
      ))}
      <button type="button" aria-label="Ctrl-C" onClick={() => onSend(ctrlSeq("c"))}>
        ^C
      </button>
      <button type="button" aria-label="Ctrl-D" onClick={() => onSend(ctrlSeq("d"))}>
        ^D
      </button>
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
      Home: "Home",
      End: "End",
      PageUp: "PgUp",
      PageDown: "PgDn",
    }[k] ?? k
  );
}
