import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Surface } from "../ui/Surface";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
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
  onClose: () => void;
}

const fieldStyle: CSSProperties = {
  minHeight: "var(--tap-min)",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text)",
  padding: "0 var(--sp-3)",
  font: "inherit",
};

export function SettingsPanel({
  session,
  defaults,
  onSaveDefaults,
  onStopSession,
  onApplyLiveSettings,
  onClose,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<SessionDefaults>(defaults);
  // Live-edit drafts for the active session. Effort has NO wire echo (set_max_thinking_tokens is
  // silent), so it is reflected optimistically; model/permission-mode are observable on the next
  // system/init but we also reflect them optimistically into the session list (see ChatView).
  const [liveModel, setLiveModel] = useState(session?.model ?? "");
  const [liveEffort, setLiveEffort] = useState(session?.effort ?? "medium");
  const [livePermissionMode, setLivePermissionMode] = useState("default");
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
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--bg)",
        display: "grid",
        placeItems: "center",
        padding: "var(--sp-5)",
        zIndex: 50,
        overflowY: "auto",
      }}
    >
      <Surface level={1} as="section">
        <div style={{ padding: "var(--sp-5)", display: "grid", gap: "var(--sp-4)", width: "min(92vw, 480px)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong className="display" style={{ fontSize: "var(--fs-lg)" }}>
              Settings
            </strong>
            <Button variant="ghost" onClick={onClose} aria-label="Close settings">
              Close
            </Button>
          </div>

          {session && (
            <section style={{ display: "grid", gap: "var(--sp-2)" }}>
              <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: 1 }}>
                This session (fixed at start)
              </div>
              <div>
                Directory: <Mono>{session.cwd}</Mono>
              </div>
              {onApplyLiveSettings ? (
                <div style={{ display: "grid", gap: "var(--sp-3)" }}>
                  <label style={{ display: "grid", gap: "var(--sp-2)" }}>
                    <span style={{ fontSize: "var(--fs-sm)" }}>Active session model</span>
                    <input
                      aria-label="active session model"
                      value={liveModel}
                      onChange={(e) => setLiveModel(e.target.value)}
                      placeholder="default"
                      style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: "var(--sp-2)" }}>
                    <span style={{ fontSize: "var(--fs-sm)" }}>Active session effort</span>
                    <select
                      aria-label="active session effort"
                      value={liveEffort}
                      onChange={(e) => setLiveEffort(e.target.value)}
                      style={fieldStyle}
                    >
                      {EFFORTS.map((e) => (
                        <option key={e} value={e}>
                          {e}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: "var(--sp-2)" }}>
                    <span style={{ fontSize: "var(--fs-sm)" }}>Active session permission mode</span>
                    <select
                      aria-label="active session permission mode"
                      value={livePermissionMode}
                      onChange={(e) => setLivePermissionMode(e.target.value)}
                      style={fieldStyle}
                    >
                      {PERMISSION_MODES.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="primary"
                    aria-label="Apply to session"
                    onClick={() =>
                      onApplyLiveSettings({
                        model: liveModel || undefined,
                        effort: liveEffort,
                        permissionMode: livePermissionMode,
                      })
                    }
                  >
                    Apply to session
                  </Button>
                </div>
              ) : (
                <>
                  <div>
                    Model: <Mono>{session.model ?? "default"}</Mono>
                  </div>
                  <div>
                    Effort: <Mono>{session.effort ?? "default"}</Mono>
                  </div>
                  <div>
                    Skip permissions: <Mono>{String(session.dangerouslySkip)}</Mono>
                  </div>
                  <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", margin: 0 }}>
                    Model/effort/permissions are set when a session starts. To change them, start a new session.
                  </p>
                </>
              )}
              {onStopSession && (
                <Button
                  variant="danger"
                  onClick={() => {
                    if (window.confirm("Stop this session? The running claude process will be terminated.")) {
                      onStopSession(session.id);
                    }
                  }}
                  aria-label="Stop session"
                >
                  Stop session
                </Button>
              )}
            </section>
          )}

          <section style={{ display: "grid", gap: "var(--sp-3)", borderTop: "1px solid var(--border)", paddingTop: "var(--sp-4)" }}>
            <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: 1 }}>
              Defaults for new sessions
            </div>
            <label style={{ display: "grid", gap: "var(--sp-2)" }}>
              <span style={{ fontSize: "var(--fs-sm)" }}>Default effort</span>
              <select value={draft.effort} onChange={(e) => setDraft((d) => ({ ...d, effort: e.target.value }))} style={fieldStyle}>
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e.charAt(0).toUpperCase() + e.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: "var(--sp-2)" }}>
              <span style={{ fontSize: "var(--fs-sm)" }}>Default model (optional)</span>
              <input
                value={draft.model ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value || undefined }))}
                placeholder="default"
                style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }}
              />
            </label>
            <label
              style={{
                display: "flex",
                gap: "var(--sp-2)",
                alignItems: "center",
                color: draft.dangerouslySkip ? "var(--err)" : "var(--text)",
              }}
            >
              <input type="checkbox" checked={draft.dangerouslySkip} onChange={(e) => toggleDanger(e.target.checked)} />
              <span>Dangerously skip permissions (RCE risk)</span>
            </label>
            <Button variant="primary" onClick={() => onSaveDefaults(draft)} aria-label="Save defaults">
              Save defaults
            </Button>
          </section>

          <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", margin: 0 }}>
            The access token is stored in this browser only (localStorage).
          </p>
        </div>
      </Surface>
    </div>
  );
}
