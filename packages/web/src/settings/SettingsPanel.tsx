import { useEffect, useRef, useState } from "react";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import { EFFORTS, PERMISSION_MODES } from "./defaults";
import type { SessionDefaults } from "./defaults";
import type { SessionMeta } from "../types/server";

export interface SettingsPanelProps {
  session?: SessionMeta;
  defaults: SessionDefaults;
  onSaveDefaults: (d: SessionDefaults) => void;
  onStopSession?: (id: string) => void;
  /** When provided, the active-session block becomes editable and applies changes live. */
  onApplyLiveSettings?: (s: { model?: string; effort?: string; permissionMode?: string }) => void;
  /** Push opt-in handlers. When omitted, the Notifications section is hidden (e.g. in tests/screenshots). */
  pushState?: "subscribed" | "unsubscribed" | "unsupported";
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
  pushState,
  onEnablePush,
  onDisablePush,
  onClose,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<SessionDefaults>(defaults);
  // Live-edit drafts for the active session. Effort has NO wire echo (set_max_thinking_tokens is
  // silent), so it is reflected optimistically; model/permission-mode are observable on the next
  // system/init but we also reflect them optimistically into the session list (see ChatView).
  //
  // The seeded values are captured so "Apply to session" can send ONLY the controls the user
  // actually CHANGED. permissionMode now seeds from the session's persisted mode (Plan 6) so
  // "Apply" no longer risks silently downgrading an acceptEdits/plan session to default when the
  // user only edited the model. Omitting an unchanged control leaves the running session's setting
  // untouched (the server only applies fields present in the `settings` frame).
  const seededModel = session?.model ?? "";
  const seededEffort = session?.effort ?? "medium";
  const seededPermissionMode = session?.permissionMode ?? "default";
  const [liveModel, setLiveModel] = useState(seededModel);
  const [liveEffort, setLiveEffort] = useState(seededEffort);
  const [livePermissionMode, setLivePermissionMode] = useState(seededPermissionMode);
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
                    <input
                      aria-label="active session model"
                      value={liveModel}
                      onChange={(e) => setLiveModel(e.target.value)}
                      placeholder="default"
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
                  <button
                    type="button"
                    className="rc-settings__primary"
                    aria-label="Apply to session"
                    onClick={() => {
                      // Only send the controls the user CHANGED — an unchanged control is omitted so
                      // it cannot silently reset the running session's value (see seeding note above).
                      const update: { model?: string; effort?: string; permissionMode?: string } = {};
                      if (liveModel !== seededModel) update.model = liveModel || undefined;
                      if (liveEffort !== seededEffort) update.effort = liveEffort;
                      if (livePermissionMode !== seededPermissionMode) update.permissionMode = livePermissionMode;
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
                    if (window.confirm("Stop this session? The running claude process will be terminated.")) {
                      onStopSession(session.id);
                    }
                  }}
                  aria-label="Stop session"
                >
                  <Icon name="power" size={16} />
                  Stop session
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
                    {e.charAt(0).toUpperCase() + e.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="rc-settings__field">
              <span className="rc-settings__field-label">Default model (optional)</span>
              <input
                value={draft.model ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value || undefined }))}
                placeholder="default"
                className="rc-settings__control rc-settings__control--mono"
              />
            </label>
            <label className={`rc-settings__danger-check${draft.dangerouslySkip ? " rc-settings__danger-check--on" : ""}`}>
              <input type="checkbox" checked={draft.dangerouslySkip} onChange={(e) => toggleDanger(e.target.checked)} />
              <span>Dangerously skip permissions (RCE risk)</span>
            </label>
            <button type="button" className="rc-settings__primary" onClick={() => onSaveDefaults(draft)} aria-label="Save defaults">
              Save defaults
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
  background: var(--bg);
  display: grid; place-items: center;
  padding: var(--sp-5);
  overflow-y: auto;
}
/* The settings card — liquid glass (translucent warm fill + heavy blur + the 4-layer thickness
   shadow) floating over the scrim. The one accent is the Save/Apply coral gradient primary. */
.rc-settings__card {
  width: min(92vw, 480px);
  background: var(--glass-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-shadow);
  overflow: hidden;
}
.rc-settings__head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.rc-settings__head-id { display: flex; align-items: center; gap: var(--sp-2); }
/* The violet-tinted Settings glyph tile — a small icon-headed accent. */
.rc-settings__head-icon { color: var(--accent); display: grid; place-items: center; }
.rc-settings__title { font-size: var(--fs-lg); }
.rc-settings__close {
  width: var(--tap-min); height: var(--tap-min); flex: none;
  display: grid; place-items: center;
  background: transparent; border: none; cursor: pointer;
  color: var(--text-muted); border-radius: var(--radius);
  transition: color 120ms ease, background 120ms ease;
}
.rc-settings__close:hover { color: var(--text); background: var(--surface-2); }
.rc-settings__body { padding: var(--sp-4); display: grid; gap: var(--sp-4); }
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
/* The single coral primary — a clay-coral gradient with the liquid-glass glow halo, DARK ink label. */
.rc-settings__primary {
  background: var(--accent-grad); color: var(--on-accent); border: 1px solid transparent;
  box-shadow: var(--shadow-pop);
}
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
