import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";

export type RewindMode = "code" | "conversation" | "both";

export interface RewindSheetProps {
  /** The checkpoint (user-message uuid) this rewind targets — shown for traceability. */
  checkpointId: string;
  /** Confirm the rewind with the chosen mode. */
  onConfirm: (mode: RewindMode) => void;
  /** Dismiss without rewinding (Cancel button, Escape, or backdrop tap). */
  onCancel: () => void;
}

interface ModeDef {
  mode: RewindMode;
  label: string;
  blurb: string;
}

// The three rewind modes, each with a one-line explanation. Mirrors Claude Code's ESC-ESC choices.
const MODES: ModeDef[] = [
  { mode: "code", label: "Code", blurb: "Revert files changed since here. The conversation stays." },
  { mode: "conversation", label: "Conversation", blurb: "Drop the chat after here. Files stay as they are." },
  { mode: "both", label: "Both", blurb: "Drop the chat after here AND revert the files to match." },
];

/**
 * REWIND / CHECKPOINT confirm sheet — the tappable, mobile equivalent of Claude Code's ESC-ESC.
 * A focus-trapped, `aria-modal` dialog: a title, the three modes as a radio group with one-line
 * explanations, a destructive warning (Bash-made changes aren't tracked; this can't be undone), and
 * Cancel / Confirm. Tokens only, no emoji (icons via <Icon>), reduced-motion safe (the entrance rise
 * references a global keyframe neutralized under prefers-reduced-motion).
 */
export function RewindSheet({ checkpointId, onConfirm, onCancel }: RewindSheetProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<RewindMode>("code");
  useFocusTrap(dialogRef as React.RefObject<HTMLElement>, true);

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={BACKDROP}
    >
      <div
        ref={dialogRef}
        className="rc-glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rewind-title"
        aria-describedby="rewind-warning"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        style={SHEET}
      >
        <div style={HEADER}>
          <span aria-hidden style={{ display: "inline-flex", color: "var(--accent)" }}>
            <Icon name="history" size={17} />
          </span>
          <span id="rewind-title" style={TITLE}>
            Rewind to here
          </span>
        </div>

        <div role="radiogroup" aria-label="What to rewind" style={{ display: "grid", gap: "var(--sp-2)" }}>
          {MODES.map((m) => {
            const selected = m.mode === mode;
            return (
              <button
                key={m.mode}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={m.label}
                onClick={() => setMode(m.mode)}
                style={optionStyle(selected)}
              >
                <span aria-hidden style={radioDot(selected)} />
                <span style={{ display: "grid", gap: 2, textAlign: "left" }}>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{m.label}</span>
                  <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", lineHeight: 1.4 }}>
                    {m.blurb}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <p id="rewind-warning" role="note" style={WARNING}>
          <span aria-hidden style={{ display: "inline-flex", color: "var(--err)", flex: "none" }}>
            <Icon name="alert" size={15} />
          </span>
          <span>
            Changes made by Bash commands aren&apos;t tracked and won&apos;t be reverted. This can&apos;t be undone.
          </span>
        </p>

        <div style={{ display: "flex", gap: "var(--sp-2)", justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} style={CANCEL_BTN}>
            Cancel
          </button>
          <button type="button" onClick={() => onConfirm(mode)} style={CONFIRM_BTN} data-checkpoint={checkpointId}>
            Confirm rewind
          </button>
        </div>
      </div>
    </div>
  );
}

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  display: "grid",
  placeItems: "end center",
  padding: "var(--sp-4)",
  paddingBottom: "max(var(--sp-4), env(safe-area-inset-bottom))",
  background: "var(--scrim, rgba(0,0,0,0.45))",
};

const SHEET: CSSProperties = {
  // Liquid-glass sheet — the .rc-glass class supplies the material (blur + thickness shadow +
  // refraction rim + specular sweep); this sizes + rounds it. The 3 modes sit on it as glass rows.
  width: "min(440px, 100%)",
  borderRadius: "var(--radius)",
  padding: "var(--sp-4)",
  display: "grid",
  gap: "var(--sp-4)",
  animation: "rc-rise 0.28s ease-out",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const TITLE: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 600,
  fontSize: "var(--fs-lg, var(--fs-base))",
  color: "var(--text)",
  letterSpacing: "0.01em",
};

function optionStyle(selected: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--sp-3)",
    width: "100%",
    minHeight: "var(--tap-min)",
    textAlign: "left",
    cursor: "pointer",
    padding: "var(--sp-3)",
    borderRadius: "var(--radius-sm)",
    border: `1px solid ${selected ? "var(--accent-line)" : "var(--border)"}`,
    background: selected ? "var(--accent-soft)" : "var(--surface-2, transparent)",
  };
}

function radioDot(selected: boolean): CSSProperties {
  return {
    marginTop: 3,
    width: 16,
    height: 16,
    flex: "none",
    borderRadius: "50%",
    border: `2px solid ${selected ? "var(--accent)" : "var(--border)"}`,
    boxShadow: selected ? "inset 0 0 0 3px var(--accent)" : "none",
    background: "transparent",
  };
}

const WARNING: CSSProperties = {
  display: "flex",
  gap: "var(--sp-2)",
  alignItems: "flex-start",
  margin: 0,
  fontSize: "var(--fs-sm)",
  lineHeight: 1.45,
  color: "var(--text-muted)",
};

const CANCEL_BTN: CSSProperties = {
  minHeight: "var(--tap-min)",
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontWeight: 500,
  cursor: "pointer",
};

const CONFIRM_BTN: CSSProperties = {
  minHeight: "var(--tap-min)",
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid transparent",
  background: "var(--accent-grad)",
  color: "var(--on-accent)",
  boxShadow: "var(--shadow-pop)",
  fontWeight: 600,
  cursor: "pointer",
};
