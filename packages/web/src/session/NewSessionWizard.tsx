import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import { DirectoryPicker } from "../picker/DirectoryPicker";
import { pushRecentDir } from "../picker/recents";
import { loadDefaults, EFFORTS, PERMISSION_MODES } from "../settings/defaults";
import { ModelSelect } from "../settings/ModelSelect";
import type { ApiClient } from "../api/client";
import type { ModelInfo, SessionMeta } from "../types/server";

export interface NewSessionWizardProps {
  api: Pick<ApiClient, "listDir" | "createSession">;
  recents: string[];
  /** Wall clock (ms) — passed in so the wizard stays free of Date.now() (the app owns the tick).
   * Defaults to Date.now() at mount when omitted. */
  now?: number;
  /** Account models from GET /models. Empty → free-text fallback (today's behavior). */
  models?: ModelInfo[];
  /** Prefilled directory (e.g. "New session in this folder" from Settings). When set, the wizard skips
   * the directory picker and opens straight on the confirm step (the folder is still changeable). */
  initialCwd?: string;
  /** Prefilled session options (used by "New session in this folder with these settings"). Each falls
   * back to the saved defaults when omitted. */
  initialModel?: string;
  initialEffort?: string;
  initialPermissionMode?: string;
  initialDangerouslySkip?: boolean;
  onCreated: (session: SessionMeta) => void;
  onClose: () => void;
}

/**
 * Start a new TERMINAL session: pick a directory, then choose the session's defaults (effort, model,
 * permission mode, extra dirs, dangerously-skip). Terminal is the only session mode. Callers can prefill
 * the directory (skipping the picker step) and the model/effort/permission/danger — that's how Settings'
 * "New session in this folder with these settings" reproduces a running session's setup in the same cwd.
 */
export function NewSessionWizard({
  api,
  recents,
  now,
  models = [],
  initialCwd,
  initialModel,
  initialEffort,
  initialPermissionMode,
  initialDangerouslySkip,
  onCreated,
  onClose,
}: NewSessionWizardProps) {
  const seeded = loadDefaults();
  // When a caller prefills a cwd, open straight on the confirm step (the "Change" button still returns
  // to the picker). Otherwise start at the picker (cwd undefined).
  const [cwd, setCwd] = useState<string | undefined>(initialCwd);
  const [effort, setEffort] = useState<string>(initialEffort ?? seeded.effort);
  const [model, setModel] = useState(initialModel ?? seeded.model ?? "");
  const [permMode, setPermMode] = useState<string>(initialPermissionMode ?? seeded.permissionMode ?? "default");
  // Additional working directories (--add-dir): the host supports several, the wizard never let you set any.
  const [addDirs, setAddDirs] = useState<string[]>([]);
  const [dirDraft, setDirDraft] = useState("");
  const [dangerouslySkip, setDangerouslySkip] = useState(initialDangerouslySkip ?? seeded.dangerouslySkip);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const nowMs = now ?? Date.now();

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
      <DirectoryPicker listDir={api.listDir} recents={recents} onPick={(path) => setCwd(path)} onCancel={onClose} />
    );
  }

  // Step 2 — defaults for the new session.
  function addDir(path: string) {
    const p = path.trim();
    if (!p) return;
    setAddDirs((prev) => (prev.includes(p) ? prev : [...prev, p]));
    setDirDraft("");
  }

  async function start() {
    if (!cwd) return;
    setBusy(true);
    setError(undefined);
    try {
      const session = await api.createSession({
        cwd,
        effort,
        model: model || undefined,
        dangerouslySkip,
        // Only send a non-default mode (default is the server's implicit baseline). Skip overrides it anyway.
        permissionMode: permMode !== "default" ? permMode : undefined,
        addDirs: addDirs.length > 0 ? addDirs : undefined,
        mode: "terminal",
      });
      pushRecentDir(cwd);
      onCreated(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start session");
      setBusy(false);
    }
  }

  // nowMs is currently unused by the terminal-only flow but kept in the signature so callers stay stable.
  void nowMs;

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

          <label className="rc-wizard__field">
            <span className="rc-wizard__field-label">Permission mode</span>
            <select
              value={permMode}
              onChange={(e) => setPermMode(e.target.value)}
              className="rc-wizard__control"
              aria-label="permission mode"
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <div className="rc-wizard__field">
            <span className="rc-wizard__field-label">Additional directories (optional)</span>
            {addDirs.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", marginBottom: "var(--sp-2)" }}>
                {addDirs.map((d) => (
                  <span
                    key={d}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--sp-1)",
                      background: "var(--surface-2)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      padding: "2px var(--sp-2)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-xs)",
                    }}
                  >
                    <Mono muted>{d}</Mono>
                    <button
                      type="button"
                      aria-label={`Remove ${d}`}
                      onClick={() => setAddDirs((prev) => prev.filter((x) => x !== d))}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--text-faint)",
                      }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: "var(--sp-2)" }}>
              <input
                value={dirDraft}
                onChange={(e) => setDirDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addDir(dirDraft);
                  }
                }}
                placeholder="/absolute/path"
                aria-label="additional directory path"
                className="rc-wizard__control rc-wizard__control--mono"
                style={{ flex: 1, minWidth: 0 }}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="rc-wizard__cancel"
                onClick={() => addDir(dirDraft)}
                disabled={dirDraft.trim().length === 0}
                aria-label="Add directory"
              >
                Add
              </button>
            </div>
          </div>

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
