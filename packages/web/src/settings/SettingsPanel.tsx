import { useEffect, useRef, useState } from "react";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import { ModelSelect } from "./ModelSelect";
import { EFFORTS, PERMISSION_MODES } from "./defaults";
import type { SessionDefaults } from "./defaults";
import type { ModelInfo, SessionMeta } from "../types/server";

export interface SettingsPanelProps {
  session?: SessionMeta;
  defaults: SessionDefaults;
  onSaveDefaults: (d: SessionDefaults) => void;
  onStopSession?: (id: string) => void;
  /** When provided, the active-session block becomes editable and applies changes live. A changed
   * `dangerouslySkip` is applied by the server via a respawn (the permission boundary is set at spawn). */
  onApplyLiveSettings?: (s: {
    model?: string;
    effort?: string;
    permissionMode?: string;
    dangerouslySkip?: boolean;
  }) => void;
  /** Account models from GET /models. Empty → free-text fallback (today's behavior). */
  models?: ModelInfo[];
  /** Push opt-in handlers. When omitted, the Notifications section is hidden (e.g. in tests/screenshots). */
  pushState?: "subscribed" | "unsubscribed" | "unsupported" | "denied";
  onEnablePush?: () => void;
  onDisablePush?: () => void;
  onClose: () => void;
}

export function SettingsPanel({
  session,
  defaults,
  onSaveDefaults,
  onStopSession,
  onApplyLiveSettings,
  models = [],
  pushState,
  onEnablePush,
  onDisablePush,
  onClose,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<SessionDefaults>(defaults);
  // "Saved ✓" confirmation for the Defaults save: it persists silently to localStorage (the panel does
  // NOT close), so without this the tap gave no feedback. Auto-reverts, and reverts on the next edit.
  const [savedDefaults, setSavedDefaults] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Live-edit drafts for the active session. Effort has NO wire echo (set_max_thinking_tokens is
  // silent), so it is reflected optimistically; model/permission-mode are observable on the next
  // system/init but we also reflect them optimistically into the session list (see ChatView).
  //
  // The seeded values are captured so "Apply to session" can send ONLY the controls the user
  // actually CHANGED. permissionMode now seeds from the session's persisted mode (Plan 6) so
  // "Apply" no longer risks silently downgrading an acceptEdits/plan session to default when the
  // user only edited the model. Omitting an unchanged control leaves the running session's setting
  // untouched (the server only applies fields present in the `settings` frame).
  // FREEZE the baseline at OPEN (useRef, captured once) — recomputing it from `session` every render
  // meant a 15s mergeSessionMeta poll (a fresh session object) could shift the baseline under the
  // unchanged drafts, so "Apply" would send a value the user never touched (or omit one they did).
  const seeded = useRef({
    model: session?.model ?? "",
    effort: session?.effort ?? "medium",
    permissionMode: session?.permissionMode ?? "default",
    danger: session?.dangerouslySkip ?? false,
  }).current;
  const [liveModel, setLiveModel] = useState(seeded.model);
  const [liveEffort, setLiveEffort] = useState(seeded.effort);
  const [livePermissionMode, setLivePermissionMode] = useState(seeded.permissionMode);
  const [liveDanger, setLiveDanger] = useState(seeded.danger);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Real modal semantics: trap Tab within the dialog and restore focus to the trigger on close.
  // This is a destructive surface (Stop session / dangerously-skip-permissions), so keyboard
  // focus must not escape to the inert background behind it.
  useFocusTrap(dialogRef);

  // Escape closes the dialog, matching DirectoryPicker / NewSessionWizard.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clear the pending "Saved ✓" timer on unmount.
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  // Editing any default after a save means there are unsaved changes again — drop the confirmation.
  useEffect(() => {
    setSavedDefaults(false);
  }, [draft]);

  function saveDefaultsNow() {
    onSaveDefaults(draft);
    setSavedDefaults(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedDefaults(false), 1800);
  }

  function toggleDanger(checked: boolean) {
    if (
      checked &&
      !window.confirm(
        "Enable --dangerously-skip-permissions for NEW sessions? This allows the agent to run tools without asking — remote code execution risk.",
      )
    ) {
      return;
    }
    setDraft((d) => ({ ...d, dangerouslySkip: checked }));
  }

  // Live toggle for the RUNNING session. EITHER direction makes the server respawn the agent (resume
  // the same conversation), since the permission boundary is fixed at spawn — so confirm-gate BOTH:
  // enabling is an RCE boundary, and disabling also restarts the session (interrupting in-flight work).
  function toggleLiveDanger(checked: boolean) {
    const message = checked
      ? "Enable --dangerously-skip-permissions for THIS running session? It restarts the agent (your conversation resumes) so it can run tools without asking — remote code execution risk."
      : "Disable --dangerously-skip-permissions for THIS running session? It restarts the agent (your conversation resumes), interrupting any in-flight work.";
    if (!window.confirm(message)) return;
    setLiveDanger(checked);
  }

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Settings" className="rc-settings">
      <section className="rc-settings__card">
        <header className="rc-settings__head">
          <span className="rc-settings__head-id">
            <span className="rc-settings__head-icon" aria-hidden="true">
              <Icon name="settings" size={18} />
            </span>
            <strong className="display rc-settings__title">Settings</strong>
          </span>
          <button type="button" className="rc-settings__close" onClick={onClose} aria-label="Close settings">
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="rc-settings__body">
          {session && (
            <section className="rc-settings__section">
              <div className="rc-settings__section-head">
                <span className="rc-settings__section-icon" aria-hidden="true">
                  <Icon name="sliders" size={15} />
                </span>
                <span className="rc-settings__section-label">This session</span>
              </div>
              <div className="rc-settings__dir">
                <span className="rc-settings__dir-key">Directory</span>
                <Mono>{session.cwd}</Mono>
              </div>
              {onApplyLiveSettings ? (
                <div className="rc-settings__fields">
                  <label className="rc-settings__field">
                    <span className="rc-settings__field-label">Active session model</span>
                    <ModelSelect
                      value={liveModel}
                      onChange={setLiveModel}
                      models={models}
                      ariaLabel="active session model"
                      className="rc-settings__control rc-settings__control--mono"
                    />
                  </label>
                  <label className="rc-settings__field">
                    <span className="rc-settings__field-label">Active session effort</span>
                    <select
                      aria-label="active session effort"
                      value={liveEffort}
                      onChange={(e) => setLiveEffort(e.target.value)}
                      className="rc-settings__control"
                    >
                      {EFFORTS.map((e) => (
                        <option key={e} value={e}>
                          {e}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="rc-settings__field">
                    <span className="rc-settings__field-label">Active session permission mode</span>
                    <select
                      aria-label="active session permission mode"
                      value={livePermissionMode}
                      onChange={(e) => setLivePermissionMode(e.target.value)}
                      className="rc-settings__control"
                    >
                      {PERMISSION_MODES.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={`rc-settings__danger-check${liveDanger ? " rc-settings__danger-check--on" : ""}`}>
                    <input
                      type="checkbox"
                      aria-label="active session dangerously skip permissions"
                      checked={liveDanger}
                      onChange={(e) => toggleLiveDanger(e.target.checked)}
                    />
                    <span>Dangerously skip permissions (restarts this session)</span>
                  </label>
                  <button
                    type="button"
                    className="rc-settings__primary"
                    aria-label="Apply to session"
                    // Disabled when nothing changed — an empty {} update would be a pointless settings
                    // frame (and could trigger a no-op respawn for a dangerouslySkip "change" to itself).
                    disabled={
                      liveModel === seeded.model &&
                      liveEffort === seeded.effort &&
                      livePermissionMode === seeded.permissionMode &&
                      liveDanger === seeded.danger
                    }
                    onClick={() => {
                      // Only send the controls the user CHANGED — an unchanged control is omitted so it
                      // cannot silently reset the running session's value (see seeding note above). A
                      // changed dangerouslySkip is applied by the server via a respawn.
                      const update: {
                        model?: string;
                        effort?: string;
                        permissionMode?: string;
                        dangerouslySkip?: boolean;
                      } = {};
                      if (liveModel !== seeded.model) update.model = liveModel || undefined;
                      if (liveEffort !== seeded.effort) update.effort = liveEffort;
                      if (livePermissionMode !== seeded.permissionMode) update.permissionMode = livePermissionMode;
                      if (liveDanger !== seeded.danger) update.dangerouslySkip = liveDanger;
                      onApplyLiveSettings(update);
                    }}
                  >
                    Apply to session
                  </button>
                </div>
              ) : (
                <div className="rc-settings__readonly">
                  <div className="rc-settings__ro-row">
                    <span>Model</span>
                    <Mono muted>{session.model ?? "default"}</Mono>
                  </div>
                  <div className="rc-settings__ro-row">
                    <span>Effort</span>
                    <Mono muted>{session.effort ?? "default"}</Mono>
                  </div>
                  <div className="rc-settings__ro-row">
                    <span>Skip permissions</span>
                    <Mono muted>{String(session.dangerouslySkip)}</Mono>
                  </div>
                  <p className="rc-settings__hint">
                    Model/effort/permissions are set when a session starts. To change them, start a new session.
                  </p>
                </div>
              )}
              {onStopSession && (
                <button
                  type="button"
                  className="rc-settings__danger"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Close this session? It's removed from the list and its claude process is terminated. The transcript stays on disk — you can resume it later.",
                      )
                    ) {
                      onStopSession(session.id);
                    }
                  }}
                  aria-label="Close session"
                >
                  <Icon name="power" size={16} />
                  Close session
                </button>
              )}
            </section>
          )}

          <section className="rc-settings__section rc-settings__section--divided">
            <div className="rc-settings__section-head">
              <span className="rc-settings__section-icon" aria-hidden="true">
                <Icon name="plus" size={15} />
              </span>
              <span className="rc-settings__section-label">Defaults for new sessions</span>
            </div>
            <label className="rc-settings__field">
              <span className="rc-settings__field-label">Default effort</span>
              <select
                value={draft.effort}
                onChange={(e) => setDraft((d) => ({ ...d, effort: e.target.value }))}
                className="rc-settings__control"
              >
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            <label className="rc-settings__field">
              <span className="rc-settings__field-label">Default model (optional)</span>
              <ModelSelect
                value={draft.model ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, model: v || undefined }))}
                models={models}
                ariaLabel="default model"
                className="rc-settings__control rc-settings__control--mono"
              />
            </label>
            <label
              className={`rc-settings__danger-check${draft.dangerouslySkip ? " rc-settings__danger-check--on" : ""}`}
            >
              <input type="checkbox" checked={draft.dangerouslySkip} onChange={(e) => toggleDanger(e.target.checked)} />
              <span>Dangerously skip permissions (RCE risk)</span>
            </label>
            <button type="button" className="rc-settings__primary" onClick={saveDefaultsNow} aria-label="Save defaults">
              {savedDefaults ? (
                <span
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "var(--sp-2)" }}
                >
                  <Icon name="check" size={15} />
                  Saved
                </span>
              ) : (
                "Save defaults"
              )}
            </button>
          </section>

          {pushState && (
            <section className="rc-settings__section rc-settings__section--divided">
              <div className="rc-settings__section-head">
                <span className="rc-settings__section-icon" aria-hidden="true">
                  <Icon name="bell" size={15} />
                </span>
                <span className="rc-settings__section-label">Notifications</span>
              </div>
              {pushState === "unsupported" ? (
                <p className="rc-settings__hint">
                  Web Push needs HTTPS (or localhost) and a supporting browser. Open this app over your secure tunnel to
                  enable notifications.
                </p>
              ) : pushState === "denied" ? (
                <p className="rc-settings__hint">
                  Notifications are blocked for this site. Re-enable them in your browser&apos;s site settings, then
                  reopen this panel.
                </p>
              ) : pushState === "subscribed" ? (
                <button
                  type="button"
                  className="rc-settings__secondary"
                  aria-label="Disable notifications"
                  onClick={() => onDisablePush?.()}
                >
                  Notifications on — tap to disable
                </button>
              ) : (
                <button
                  type="button"
                  className="rc-settings__primary"
                  aria-label="Enable notifications"
                  onClick={() => onEnablePush?.()}
                >
                  Enable notifications
                </button>
              )}
              <p className="rc-settings__hint">
                Get a push when a session finishes a task or needs your permission/answer.
              </p>
            </section>
          )}

          <p className="rc-settings__note">The access token is stored in this browser only (localStorage).</p>
        </div>
      </section>

      <style>{settingsCss}</style>
    </div>
  );
}

const settingsCss = `
.rc-settings {
  position: fixed; inset: 0; z-index: 50;
  background-color: var(--bg);
  background-image: var(--top-glow);
  display: grid; place-items: center;
  padding: var(--sp-5);
  overflow-y: auto;
}
/* The settings card — a clean floating-glass dialog (subtle fill + blur + a --line-2 border). The one
   accent is the Save/Apply coral primary. */
.rc-settings__card {
  width: min(92vw, 480px);
  /* Cap the card to the viewport and make it a flex column so the BODY scrolls (not the page): the
     header stays put and every section — incl. "Default effort" + "Save defaults" — is reachable on a
     short phone screen. */
  display: flex; flex-direction: column;
  max-height: min(86vh, calc(100dvh - 2 * var(--sp-5)));
  background: var(--glass-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-shadow);
  overflow: hidden;
}
.rc-settings__head {
  flex: none;
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.rc-settings__head-id { display: flex; align-items: center; gap: var(--sp-2); }
/* The Settings glyph — NEUTRAL (coral is reserved for the Save/Apply primary). */
.rc-settings__head-icon { color: var(--text-muted); display: grid; place-items: center; }
.rc-settings__title { font-size: var(--fs-lg); }
.rc-settings__close {
  width: var(--tap-min); height: var(--tap-min); flex: none;
  display: grid; place-items: center;
  background: transparent; border: none; cursor: pointer;
  color: var(--text-muted); border-radius: var(--radius);
  transition: color 120ms ease, background 120ms ease;
}
.rc-settings__close:hover { color: var(--text); background: var(--surface-2); }
.rc-settings__body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: var(--sp-4);
  padding-bottom: calc(var(--sp-4) + env(safe-area-inset-bottom, 0px));
  display: grid; gap: var(--sp-4);
}
.rc-settings__section { display: grid; gap: var(--sp-3); }
.rc-settings__section--divided { border-top: 1px solid var(--border); padding-top: var(--sp-4); }
.rc-settings__section-head { display: flex; align-items: center; gap: var(--sp-2); }
.rc-settings__section-icon { color: var(--text-faint); display: grid; place-items: center; }
.rc-settings__section-label {
  color: var(--text-muted); font-family: var(--font-display); font-weight: 600;
  font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.08em;
}
.rc-settings__dir {
  display: flex; gap: var(--sp-2); align-items: baseline; flex-wrap: wrap;
  font-size: var(--fs-sm);
}
.rc-settings__dir-key { color: var(--text-muted); }
.rc-settings__dir > :nth-child(2) { overflow-wrap: anywhere; }
.rc-settings__fields { display: grid; gap: var(--sp-3); }
.rc-settings__field { display: grid; gap: var(--sp-2); }
.rc-settings__field-label { font-size: var(--fs-sm); color: var(--text-muted); }
.rc-settings__control {
  min-height: var(--tap-min);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text);
  padding: 0 var(--sp-3); font: inherit;
  transition: border-color 120ms ease;
}
.rc-settings__control:focus, .rc-settings__control:focus-within { border-color: var(--accent-line); box-shadow: var(--focus-glow); }
.rc-settings__control--mono { font-family: var(--font-mono); }
.rc-settings__readonly { display: grid; gap: var(--sp-2); }
.rc-settings__ro-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3);
  font-size: var(--fs-sm); color: var(--text-muted);
}
.rc-settings__hint { color: var(--text-muted); font-size: var(--fs-xs); margin: 0; line-height: 1.5; }
.rc-settings__note { color: var(--text-faint); font-size: var(--fs-xs); margin: 0; }
.rc-settings__primary, .rc-settings__secondary {
  min-height: var(--tap-min);
  border-radius: var(--radius-sm); cursor: pointer; font: inherit; font-weight: 500;
  padding: 0 var(--sp-4);
}
/* The single coral primary — a FLAT coral fill, DARK ink label. No glow. */
.rc-settings__primary {
  background: var(--accent-grad); color: var(--on-accent); border: 1px solid transparent;
}
.rc-settings__primary:hover { filter: brightness(1.08); }
.rc-settings__secondary {
  background: transparent; color: var(--text); border: 1px solid var(--border);
}
.rc-settings__secondary:hover { border-color: var(--text-faint); }
/* The destructive Stop — a careful, err-tinted action, never a loud filled red button. */
.rc-settings__danger {
  display: flex; align-items: center; justify-content: center; gap: var(--sp-2);
  min-height: var(--tap-min);
  border-radius: var(--radius-sm); cursor: pointer; font: inherit; font-weight: 500;
  padding: 0 var(--sp-4);
  background: var(--err-bg); color: var(--err); border: 1px solid var(--err-border);
  transition: background 120ms ease, border-color 120ms ease;
}
.rc-settings__danger:hover { border-color: var(--err); }
.rc-settings__danger-check {
  display: flex; align-items: center; gap: var(--sp-2);
  min-height: var(--tap-min); font-size: var(--fs-sm); color: var(--text);
}
.rc-settings__danger-check--on { color: var(--err); }
.rc-settings__danger-check input { width: 20px; height: 20px; accent-color: var(--err); }
`;
