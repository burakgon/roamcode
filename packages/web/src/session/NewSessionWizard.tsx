import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Surface } from "../ui/Surface";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { useFocusTrap } from "../ui/useFocusTrap";
import { DirectoryPicker } from "../picker/DirectoryPicker";
import { pushRecentDir } from "../picker/recents";
import type { ApiClient } from "../api/client";
import type { SessionMeta } from "../types/server";

export interface NewSessionWizardProps {
  api: Pick<ApiClient, "listDir" | "createSession">;
  recents: string[];
  onCreated: (session: SessionMeta) => void;
  onClose: () => void;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

export function NewSessionWizard({ api, recents, onCreated, onClose }: NewSessionWizardProps) {
  const [cwd, setCwd] = useState<string | undefined>();
  const [effort, setEffort] = useState<Effort>("medium");
  const [model, setModel] = useState("");
  const [dangerouslySkip, setDangerouslySkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const dialogRef = useRef<HTMLDivElement>(null);

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

  // Step 1 — the directory picker (the headline). It owns the whole viewport.
  if (!cwd) {
    return (
      <DirectoryPicker
        listDir={api.listDir}
        recents={recents}
        onPick={(path) => setCwd(path)}
        onCancel={onClose}
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
      <Surface level={1} as="section">
        <div className="rc-wizard__body">
          <strong className="display" style={{ fontSize: "var(--fs-lg)" }}>
            Start a session
          </strong>

          <div className="rc-wizard__dir">
            <span className="rc-wizard__dir-label">Directory</span>
            <Mono>{cwd}</Mono>
            <Button variant="ghost" onClick={() => setCwd(undefined)} aria-label="Change directory">
              Change
            </Button>
          </div>

          <label className="rc-wizard__field">
            <span className="rc-wizard__field-label">Effort</span>
            <select
              value={effort}
              onChange={(e) => setEffort(e.target.value as Effort)}
              className="rc-wizard__control"
            >
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>

          <label className="rc-wizard__field">
            <span className="rc-wizard__field-label">Model (optional)</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="default"
              className="rc-wizard__control rc-wizard__control--mono"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>

          <label className={`rc-wizard__danger${dangerouslySkip ? " rc-wizard__danger--on" : ""}`}>
            <input
              type="checkbox"
              checked={dangerouslySkip}
              onChange={(e) => setDangerouslySkip(e.target.checked)}
            />
            <span>Dangerously skip permissions (RCE risk)</span>
          </label>

          {error && (
            <div role="alert" className="rc-wizard__error">
              {error}
            </div>
          )}

          <div className="rc-wizard__actions">
            <Button variant="primary" disabled={busy} onClick={start} aria-label="Start session">
              {busy ? "Starting…" : "Start session"}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </Surface>

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
  animation: rc-wizard-in 160ms ease;
}
@keyframes rc-wizard-in { from { opacity: 0; } to { opacity: 1; } }
.rc-wizard__body {
  padding: var(--sp-5);
  display: grid; gap: var(--sp-4);
  width: min(92vw, 460px);
}
.rc-wizard__dir {
  display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
  font-size: var(--fs-sm); color: var(--text-muted);
}
.rc-wizard__dir-label { font-weight: 500; }
.rc-wizard__dir > :nth-child(2) { color: var(--text); overflow-wrap: anywhere; }
.rc-wizard__field { display: grid; gap: var(--sp-2); }
.rc-wizard__field-label { font-size: var(--fs-sm); color: var(--text-muted); }
.rc-wizard__control {
  min-height: var(--tap-min);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text);
  padding: 0 var(--sp-3); font: inherit;
}
.rc-wizard__control:focus-within, .rc-wizard__control:focus { border-color: var(--accent); }
.rc-wizard__control--mono { font-family: var(--font-mono); }
.rc-wizard__danger {
  display: flex; gap: var(--sp-2); align-items: center;
  color: var(--text); font-size: var(--fs-sm);
  min-height: var(--tap-min);
}
.rc-wizard__danger--on { color: var(--err); }
.rc-wizard__danger input { width: 20px; height: 20px; accent-color: var(--err); }
.rc-wizard__error {
  color: var(--err); border: 1px solid var(--err);
  border-radius: var(--radius-sm); padding: var(--sp-3);
}
.rc-wizard__actions { display: flex; gap: var(--sp-3); }
.rc-wizard__actions button:first-child { flex: 1; }
`;
