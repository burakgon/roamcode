import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { useFocusTrap } from "../ui/useFocusTrap";
import { DirectoryPicker } from "../picker/DirectoryPicker";
import { ResumePicker } from "./ResumePicker";
import { pushRecentDir } from "../picker/recents";
import { loadDefaults, EFFORTS } from "../settings/defaults";
import { ModelSelect } from "../settings/ModelSelect";
import type { ApiClient } from "../api/client";
import type { ModelInfo, SessionMeta } from "../types/server";

type WizardMode = "new" | "resume";

export interface NewSessionWizardProps {
  api: Pick<ApiClient, "listDir" | "createSession" | "getResumable">;
  recents: string[];
  /** Wall clock (ms) for the resume list's relative-time labels — passed in so the wizard stays free
   * of Date.now() (the app owns the tick). Defaults to Date.now() at mount when omitted. */
  now?: number;
  /** Which segment the new/resume toggle starts on. Defaults to "new" (the directory picker); the
   * in-chat `/resume` slash command opens straight to "resume". */
  initialMode?: WizardMode;
  /** Account models from GET /models. Empty → free-text fallback (today's behavior). */
  models?: ModelInfo[];
  onCreated: (session: SessionMeta) => void;
  onClose: () => void;
}

export function NewSessionWizard({
  api,
  recents,
  now,
  initialMode = "new",
  models = [],
  onCreated,
  onClose,
}: NewSessionWizardProps) {
  const seeded = loadDefaults();
  const [mode, setMode] = useState<WizardMode>(initialMode);
  const [cwd, setCwd] = useState<string | undefined>();
  const [effort, setEffort] = useState<string>(seeded.effort);
  const [model, setModel] = useState(seeded.model ?? "");
  const [dangerouslySkip, setDangerouslySkip] = useState(seeded.dangerouslySkip);
  // RESUME has its OWN skip toggle, default OFF — NOT seeded from the global new-session default. Inheriting
  // the default meant a safe past session could come back with --dangerously-skip-permissions just because
  // the user's default is "skip"; resume is an explicit per-session opt-in instead.
  const [resumeDangerSkip, setResumeDangerSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const nowMs = now ?? Date.now();

  const toggle = (
    <SegmentedToggle<WizardMode>
      label="New session or resume"
      value={mode}
      onChange={setMode}
      options={[
        { value: "new", label: "New session", icon: <Icon name="plus" size={15} /> },
        { value: "resume", label: "Resume", icon: <Icon name="history" size={15} /> },
      ]}
    />
  );

  // Real modal semantics for the settings step: focus its first control on entry, trap Tab
  // within it, and restore focus on close. Inert while the picker (step 1) owns the viewport —
  // the picker runs its own trap. (Hooks must run unconditionally, so `active` gates it.)
  const onSettingsStep = Boolean(cwd);
  useFocusTrap(dialogRef, onSettingsStep);

  // The settings step closes on Escape (the picker handles its own Escape in step 1).
  useEffect(() => {
    if (!onSettingsStep) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSettingsStep, onClose]);

  // A backdrop click dismisses — but only when the click lands on the scrim itself, never when
  // it bubbles up from the inner content.
  function onBackdrop(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  // Resume mode — a list of past conversations to pick up where they left off. Resuming creates a
  // session (idempotent server-side) seeded from the transcript; the caller adds it + selects it, and
  // the prior conversation replays on WS connect.
  if (mode === "resume") {
    return (
      <ResumePicker
        getResumable={api.getResumable}
        scopeCwd={cwd}
        now={nowMs}
        topSlot={
          <>
            {toggle}
            {/* Resume can be dangerous-skip too — but an EXPLICIT opt-in (default OFF), not seeded from the
                new-session default. Self-styled (the resume branch renders the picker without the wizard CSS). */}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-2)",
                minHeight: "var(--tap-min)",
                fontSize: "var(--fs-sm)",
                color: resumeDangerSkip ? "var(--err)" : "var(--text)",
              }}
            >
              <input
                type="checkbox"
                aria-label="dangerously skip permissions"
                checked={resumeDangerSkip}
                onChange={(e) => setResumeDangerSkip(e.target.checked)}
                style={{ width: 20, height: 20, accentColor: "var(--err)" }}
              />
              <span>Dangerously skip permissions (RCE risk)</span>
            </label>
          </>
        }
        onCancel={onClose}
        onResume={async (resumeSessionId) => {
          // Pass the RESUME-specific skip toggle (explicit opt-in, default off) so a resumed session can
          // skip permissions WITHOUT inheriting the global new-session default. Deliberately DON'T send
          // effort/model here — the resume pane has no control for them, so sending the defaults would
          // silently downgrade a high-effort conversation; the resumed session keeps its own settings.
          const session = await api.createSession({ resumeSessionId, dangerouslySkip: resumeDangerSkip });
          onCreated(session);
        }}
      />
    );
  }

  // Step 1 — the directory picker (the headline). It owns the whole viewport. The new/resume toggle
  // sits at the very top of its header so resume is a discoverable first-class peer.
  if (!cwd) {
    return (
      <DirectoryPicker
        listDir={api.listDir}
        recents={recents}
        onPick={(path) => setCwd(path)}
        onCancel={onClose}
        topSlot={toggle}
      />
    );
  }

  // Step 2 — defaults for the new session. Live-change of these lands in Plan 5.
  async function start() {
    if (!cwd) return;
    setBusy(true);
    setError(undefined);
    try {
      const session = await api.createSession({ cwd, effort, model: model || undefined, dangerouslySkip });
      pushRecentDir(cwd);
      onCreated(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start session");
      setBusy(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="New session settings"
      className="rc-wizard"
      onClick={onBackdrop}
    >
      <section className="rc-wizard__card">
        <div className="rc-wizard__body">
          <header className="rc-wizard__head">
            <span className="rc-wizard__head-icon" aria-hidden="true">
              <Icon name="plus" size={18} />
            </span>
            <strong className="display rc-wizard__title">Start a session</strong>
          </header>

          {/* The chosen directory — a clean row with a folder icon, the mono path, and a quiet
              "Change" affordance that returns to the picker. */}
          <div className="rc-wizard__dir">
            <span className="rc-wizard__dir-icon" aria-hidden="true">
              <Icon name="folder" size={16} />
            </span>
            <Mono>{cwd}</Mono>
            <button
              type="button"
              className="rc-wizard__change"
              onClick={() => setCwd(undefined)}
              aria-label="Change directory"
            >
              Change
            </button>
          </div>

          <label className="rc-wizard__field">
            <span className="rc-wizard__field-label">Effort</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value)} className="rc-wizard__control">
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>

          <label className="rc-wizard__field">
            <span className="rc-wizard__field-label">Model (optional)</span>
            <ModelSelect
              value={model}
              onChange={setModel}
              models={models}
              ariaLabel="model"
              className="rc-wizard__control rc-wizard__control--mono"
            />
          </label>

          <label className={`rc-wizard__danger${dangerouslySkip ? " rc-wizard__danger--on" : ""}`}>
            <input type="checkbox" checked={dangerouslySkip} onChange={(e) => setDangerouslySkip(e.target.checked)} />
            <span>Dangerously skip permissions (RCE risk)</span>
          </label>

          {error && (
            <div role="alert" className="rc-wizard__error">
              <Icon name="alert" size={16} />
              <span>{error}</span>
            </div>
          )}

          <div className="rc-wizard__actions">
            <button
              type="button"
              className="rc-wizard__start"
              disabled={busy}
              onClick={start}
              aria-label="Start session"
            >
              {busy ? "Starting…" : "Start session"}
            </button>
            <button type="button" className="rc-wizard__cancel" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </section>

      <style>{wizardCss}</style>
    </div>
  );
}

const wizardCss = `
.rc-wizard {
  position: fixed; inset: 0; z-index: 50;
  background: var(--scrim);
  display: grid; place-items: center;
  padding: var(--sp-5);
  animation: rc-wizard-in 180ms ease;
}
@keyframes rc-wizard-in { from { opacity: 0; } to { opacity: 1; } }
/* The wizard card — a clean floating-glass dialog (subtle fill + blur + a --line-2 border) over the
   scrim. The one accent is the Start CTA. */
.rc-wizard__card {
  width: min(92vw, 460px);
  background: var(--glass-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-shadow);
}
.rc-wizard__body {
  padding: var(--sp-5);
  display: grid; gap: var(--sp-4);
}
.rc-wizard__head { display: flex; align-items: center; gap: var(--sp-2); }
/* The wizard head-icon tile — NEUTRAL (spec: coral lives on the Start CTA only): an elevated surface +
   a --line-2 edge, the glyph in muted text. No coral. */
.rc-wizard__head-icon {
  width: 28px; height: 28px; flex: none;
  display: grid; place-items: center;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
}
.rc-wizard__title { font-size: var(--fs-lg); }
.rc-wizard__dir {
  display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
  font-size: var(--fs-sm);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3);
}
.rc-wizard__dir-icon { color: var(--text-muted); display: grid; place-items: center; }
.rc-wizard__dir > :nth-child(2) { color: var(--text); overflow-wrap: anywhere; flex: 1; min-width: 0; }
.rc-wizard__change {
  flex: none; min-height: var(--tap-min); padding: 0 var(--sp-2);
  background: transparent; border: none; cursor: pointer;
  color: var(--text-muted); font: inherit; font-weight: 500;
  border-radius: var(--radius-sm);
}
.rc-wizard__change:hover { background: var(--surface); }
.rc-wizard__field { display: grid; gap: var(--sp-2); }
.rc-wizard__field-label { font-size: var(--fs-sm); color: var(--text-muted); }
.rc-wizard__control {
  min-height: var(--tap-min);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text);
  padding: 0 var(--sp-3); font: inherit;
  transition: border-color 120ms ease;
}
.rc-wizard__control:focus-within, .rc-wizard__control:focus { border-color: var(--accent-line); box-shadow: var(--focus-glow); }
.rc-wizard__control--mono { font-family: var(--font-mono); }
.rc-wizard__danger {
  display: flex; gap: var(--sp-2); align-items: center;
  color: var(--text); font-size: var(--fs-sm);
  min-height: var(--tap-min);
}
.rc-wizard__danger--on { color: var(--err); }
.rc-wizard__danger input { width: 20px; height: 20px; accent-color: var(--err); }
.rc-wizard__error {
  display: flex; align-items: center; gap: var(--sp-2);
  color: var(--err); background: var(--err-bg); border: 1px solid var(--err-border);
  border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-sm);
}
.rc-wizard__actions { display: flex; gap: var(--sp-3); }
/* The single coral primary — Start. A FLAT coral fill, DARK ink label (--on-accent). No glow. */
.rc-wizard__start {
  flex: 1; min-height: var(--tap-min);
  border: none; border-radius: var(--radius-sm); cursor: pointer;
  background: var(--accent-grad); color: var(--on-accent);
  font: inherit; font-weight: 600; padding: 0 var(--sp-4);
  transition: filter 120ms ease;
}
.rc-wizard__start:hover:not(:disabled) { filter: brightness(1.08); }
.rc-wizard__start:disabled { opacity: 0.5; cursor: default; }
.rc-wizard__cancel {
  min-height: var(--tap-min);
  background: transparent; border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  color: var(--text); cursor: pointer; font: inherit; padding: 0 var(--sp-4);
}
.rc-wizard__cancel:hover { border-color: var(--text-faint); }
`;
