import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { IrisCard } from "./IrisCard";
import type { QuestionPayload } from "../types/server";

export interface QuestionPromptProps {
  question: QuestionPayload;
  onAnswer: (answers: Record<string, string | string[]>) => void;
  onCancel: () => void;
}

/**
 * The "awaiting you" moment for an AskUserQuestion, rendered as the iris card. Each question (header +
 * prompt) shows its options; single-select picks one label, multi-select toggles a set. Every question
 * also gets a final "Other…" option that reveals a labelled free-text input — choosing it lets the user
 * answer with custom text. Submit returns the answers map (question text -> chosen label / custom text |
 * label[]); Skip cancels (for ask_user the server resolves the held request as "no selection").
 */
export function QuestionPrompt({ question, onAnswer, onCancel }: QuestionPromptProps) {
  // selections[questionIndex] = a Set of chosen preset labels (single-select keeps at most one).
  const [selections, setSelections] = useState<Record<number, Set<string>>>({});
  // otherChosen[questionIndex] = the "Other…" row is selected (single: exclusive with presets; multi:
  // toggles alongside them). otherText[questionIndex] = the typed custom answer (the raw string sent).
  const [otherChosen, setOtherChosen] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  // Per-question refs to the custom text input + the question index whose "Other…" was just opened, so
  // an effect can move focus to the freshly-revealed input (a11y) after it mounts in the next render.
  const otherInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const [focusOther, setFocusOther] = useState<number | undefined>(undefined);

  // a11y: when the prompt appears, move focus to it so a keyboard / screen-reader user lands on the
  // request immediately (Claude is waiting on the remote machine). The IrisCard region is the focus
  // target; the iris color is paired with the "Awaiting you" TEXT so color is never the sole signal.
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    regionRef.current?.focus();
  }, [question.requestId]);

  // Reset ALL per-question answer state when a new question arrives (different requestId). Without this a
  // reused instance (the reducer replaces pendingQuestion in place) would show the next question
  // pre-populated with the PREVIOUS one's selections — and submit could send the wrong answer. ChatView
  // also keys this by requestId; this makes the component correct on its own too.
  useEffect(() => {
    setSelections({});
    setOtherChosen({});
    setOtherText({});
  }, [question.requestId]);

  // a11y: when a question's "Other…" is chosen, move focus to its revealed text input so a keyboard /
  // screen-reader user can type immediately. The input mounts the render after toggleOther sets the
  // flag; this effect fires once it exists, then clears the flag so re-renders don't steal focus back.
  useEffect(() => {
    if (focusOther === undefined) return;
    otherInputRefs.current[focusOther]?.focus();
    setFocusOther(undefined);
  }, [focusOther]);

  function togglePreset(qi: number, label: string, multi: boolean) {
    setSelections((prev) => {
      const current = new Set(prev[qi] ?? []);
      if (multi) {
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        current.clear();
        current.add(label);
      }
      return { ...prev, [qi]: current };
    });
    // Single-select: choosing a preset deselects "Other" (they are mutually exclusive). Multi-select
    // leaves "Other" alone — it can be checked alongside presets and contributes its text to the array.
    if (!multi) setOtherChosen((prev) => ({ ...prev, [qi]: false }));
  }

  function toggleOther(qi: number, multi: boolean) {
    setOtherChosen((prev) => {
      const nextChosen = !prev[qi];
      // Opening "Other…" reveals its input next render — flag it so the focus effect lands on it.
      if (nextChosen) setFocusOther(qi);
      return { ...prev, [qi]: nextChosen };
    });
    // Single-select: choosing "Other" deselects any preset (the typed text becomes the answer).
    if (!multi) setSelections((prev) => ({ ...prev, [qi]: new Set() }));
  }

  // A question is satisfied when it has a preset selection OR "Other" is chosen with non-empty text.
  function isAnswered(qi: number): boolean {
    const presets = selections[qi]?.size ?? 0;
    const other = (otherChosen[qi] ?? false) && (otherText[qi]?.trim().length ?? 0) > 0;
    return presets > 0 || other;
  }

  function submit() {
    const answers: Record<string, string | string[]> = {};
    question.questions.forEach((q, qi) => {
      const chosen = [...(selections[qi] ?? [])];
      const custom = (otherChosen[qi] ?? false) ? (otherText[qi] ?? "").trim() : "";
      if (q.multiSelect) {
        const values = custom.length > 0 ? [...chosen, custom] : chosen;
        if (values.length > 0) answers[q.question] = values;
      } else {
        // Single-select: the custom text wins when "Other" is chosen, else the one chosen preset label.
        const value = custom.length > 0 ? custom : chosen[0];
        if (value !== undefined) answers[q.question] = value;
      }
    });
    onAnswer(answers);
  }

  const allAnswered = question.questions.every((_, qi) => isAnswered(qi));

  return (
    <IrisCard title="Awaiting you — question" ariaLabel="Question" regionRef={regionRef}>
      {question.questions.map((q, qi) => {
        const other = otherChosen[qi] ?? false;
        const otherInputId = `rc-other-${question.requestId}-${qi}`;
        const questionId = `rc-q-${question.requestId}-${qi}`;
        // Single-select gets RADIO semantics (mutually exclusive, "1 of N"); multi-select keeps
        // aria-pressed toggle semantics. AT users otherwise heard N independent "pressed" buttons with no
        // signal that single-select is exclusive.
        const optRole = q.multiSelect ? undefined : "radio";
        return (
          <div key={qi} style={{ display: "grid", gap: "var(--sp-2)" }}>
            {q.header && (
              <div
                style={{
                  color: "var(--text-faint)",
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--fs-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                {q.header}
              </div>
            )}
            <div id={questionId} style={{ fontSize: "var(--fs-base)" }}>
              {q.question}
            </div>
            <div
              role={q.multiSelect ? "group" : "radiogroup"}
              aria-labelledby={questionId}
              style={{ display: "grid", gap: "var(--sp-2)" }}
            >
              {q.options.map((opt, oi) => {
                const selected = selections[qi]?.has(opt.label) ?? false;
                // NOTE: the shared `Button` (packages/web/src/ui/Button.tsx) has CLOSED props (no
                // `style`, no `aria-pressed`, no rest spread), so option toggles are plain styled
                // <button>s. The Submit/Skip controls below use only Button's real props, so they
                // stay <Button>. The global :focus-visible ring (styles/global.css) keeps a bare
                // <button> keyboard-accessible without a custom class.
                return (
                  <button
                    key={`${qi}-${oi}`}
                    type="button"
                    role={optRole}
                    aria-pressed={q.multiSelect ? selected : undefined}
                    aria-checked={q.multiSelect ? undefined : selected}
                    onClick={() => togglePreset(qi, opt.label, q.multiSelect)}
                    style={optionStyle(selected)}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
                      <span style={{ fontWeight: 500, color: "var(--text)" }}>{opt.label}</span>
                      {/* The selected coral tick — the ONE coral on the option row (spec). */}
                      {selected && <Tick />}
                    </span>
                    {opt.description && (
                      <span
                        style={{
                          color: "var(--text-muted)",
                          fontSize: "var(--fs-xs)",
                        }}
                      >
                        {opt.description}
                      </span>
                    )}
                    {/* A concrete artifact to SEE (ASCII mockup / code / config) — a clean code box so
                        the user can visually compare options. <pre> is non-interactive, so it's valid
                        inside the option <button>; tapping anywhere on the card still selects it. The
                        preview stays the clean dark code panel; selection only lights its edge coral. */}
                    {opt.preview && (
                      <pre
                        style={{
                          justifySelf: "stretch",
                          margin: "var(--sp-1) 0 0",
                          padding: "var(--sp-2)",
                          background: "var(--code-bg)",
                          border: `1px solid ${selected ? "var(--accent-line)" : "var(--code-border)"}`,
                          borderRadius: "var(--radius-sm)",
                          color: "var(--code-text)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--fs-xs)",
                          lineHeight: 1.4,
                          whiteSpace: "pre",
                          overflowX: "auto",
                        }}
                      >
                        {opt.preview}
                      </pre>
                    )}
                  </button>
                );
              })}
              {/* "Other…" — a final selectable row that reveals a labelled custom-text input. */}
              <button
                type="button"
                role={optRole}
                aria-pressed={q.multiSelect ? other : undefined}
                aria-checked={q.multiSelect ? undefined : other}
                aria-expanded={other}
                aria-controls={otherInputId}
                onClick={() => toggleOther(qi, q.multiSelect)}
                style={optionStyle(other)}
              >
                <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
                  <span style={{ fontWeight: 500, color: "var(--text)" }}>Other…</span>
                  {other && <Tick />}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>Type a custom answer</span>
              </button>
            </div>
            {other && (
              <div style={{ display: "grid", gap: "2px" }}>
                <label htmlFor={otherInputId} style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
                  Your answer
                </label>
                <input
                  id={otherInputId}
                  ref={(el) => {
                    otherInputRefs.current[qi] = el;
                  }}
                  type="text"
                  value={otherText[qi] ?? ""}
                  onChange={(e) => setOtherText((prev) => ({ ...prev, [qi]: e.target.value }))}
                  placeholder="Type your answer"
                  style={{
                    minHeight: "var(--tap-min)",
                    padding: "var(--sp-2) var(--sp-3)",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--iris)",
                    background: "var(--surface-2)",
                    color: "var(--text)",
                    font: "inherit",
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)" }}>
        <Button variant="primary" onClick={submit} disabled={!allAnswered} aria-label="Submit answer">
          Submit
        </Button>
        <Button variant="ghost" onClick={onCancel} aria-label="Skip question">
          Skip
        </Button>
      </div>
    </IrisCard>
  );
}

/** Shared styling for an option / "Other…" toggle row — a NEUTRAL row (elevated surface + hairline)
 *  that takes a subtle coral ring + faint coral wash when selected (spec: neutral rows, coral
 *  ring/tick on the selected state). The label text stays neutral-bright; coral lives in the ring/tick. */
function optionStyle(selected: boolean): React.CSSProperties {
  return {
    display: "grid",
    gap: "2px",
    justifyItems: "start",
    textAlign: "left",
    minHeight: "var(--tap-min)",
    padding: "var(--sp-3)",
    borderRadius: "var(--radius-sm)",
    border: `1px solid ${selected ? "var(--accent-line)" : "var(--border)"}`,
    background: selected ? "var(--accent-soft)" : "var(--surface-2)",
    color: "var(--text)",
    boxShadow: selected ? "inset 0 0 0 1px var(--accent-line)" : "none",
    font: "inherit",
    cursor: "pointer",
  };
}

/** The selected coral tick — a small coral check dot. The ONE coral on a selected option row. */
function Tick() {
  return (
    <span
      aria-hidden
      style={{
        width: 15,
        height: 15,
        flex: "none",
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        background: "var(--coral)",
        color: "var(--on-accent)",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="10"
        height="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  );
}
