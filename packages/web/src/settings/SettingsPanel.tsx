import { useEffect, useRef, useState } from "react";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import { ModelSelect } from "./ModelSelect";
import { EFFORTS, PERMISSION_MODES } from "./defaults";
import type { SessionDefaults } from "./defaults";
import type { ModelInfo, SessionMeta, UsageInfo } from "../types/server";
import type { ApiClient } from "../api/client";
import { ClaudeAuthDialog } from "./ClaudeAuthDialog";
import { shortenReset, usageFillColor } from "../session/UsageBars";
import { loadToken } from "../auth/token-store";
import { API_BASE_URL } from "../config";

/** True on iPhone/iPad NOT running as an installed (Home-Screen) PWA. iOS Safari only supports Web Push
 * from a Home-Screen app, so an "unsupported" push state here means "needs Add to Home Screen", not the
 * generic HTTPS/browser message. iPadOS 13+ reports as "Macintosh", so touch support disambiguates it. */
function isIosNonStandalone(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iPhoneOrPod = /iP(hone|od)/.test(ua);
  const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (!iPhoneOrPod && !iPad) return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const standalone = Boolean(nav.standalone) || Boolean(window.matchMedia?.("(display-mode: standalone)").matches);
  return !standalone;
}

/** Options for starting a fresh session in an existing session's folder (see `onNewSessionHere`). */
export interface NewSessionHereOptions {
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  dangerouslySkip?: boolean;
}

export interface SettingsPanelProps {
  session?: SessionMeta;
  defaults: SessionDefaults;
  onSaveDefaults: (d: SessionDefaults) => void;
  /** When provided, renders the "Claude account" re-authentication row (opens the in-app sign-in dialog). */
  api?: ApiClient;
  onStopSession?: (id: string) => void;
  /**
   * When provided (with a `session`), the "This session" block offers "New session in this folder with
   * these settings": a running claude's model/permission are FIXED at spawn, so instead of faking a
   * mid-session change we start a FRESH session in the same cwd with the chosen model/effort/permission/
   * danger. The app wires this to open {@link NewSessionWizard} prefilled with these options.
   */
  onNewSessionHere?: (opts: NewSessionHereOptions) => void;
  /** Account models from GET /models. Empty → free-text fallback (today's behavior). */
  models?: ModelInfo[];
  /** Latest usage snapshot (GET /usage). Omit to let the panel fetch it itself via `api`; pass `null`
   * to force it hidden (tests/screenshots). Drives the near-limit warning + the Sonnet weekly bar. */
  usage?: UsageInfo | null;
  /** Push opt-in handlers. When omitted, the Notifications section is hidden (e.g. in tests/screenshots). */
  pushState?: "subscribed" | "unsubscribed" | "unsupported" | "denied";
  onEnablePush?: () => void;
  onDisablePush?: () => void;
  /** Sign out of remote-coder itself (CONTRACT C2): the App wires this to clear the stored access token and
   * return to the login screen. When omitted, the "Sign out" row is hidden. */
  onSignOut?: () => void;
  onClose: () => void;
}

/** Warn once a usage bar crosses this fraction of its limit. */
const USAGE_WARN_AT = 90;

export function SettingsPanel({
  session,
  defaults,
  onSaveDefaults,
  api,
  onStopSession,
  onNewSessionHere,
  models = [],
  usage,
  pushState,
  onEnablePush,
  onDisablePush,
  onSignOut,
  onClose,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<SessionDefaults>(defaults);
  // "Saved ✓" confirmation for the Defaults save: it persists silently to localStorage (the panel does
  // NOT close), so without this the tap gave no feedback. Auto-reverts, and reverts on the next edit.
  const [savedDefaults, setSavedDefaults] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Whether the standalone Claude sign-in dialog is open (opened by the "Claude account" row below —
  // this is the reachable entry point for the otherwise-orphaned ClaudeAuthDialog).
  const [authOpen, setAuthOpen] = useState(false);
  // "New session in this folder with these settings" drafts. A running claude's model/permission are
  // FIXED at spawn, so these do NOT change the current session — they SEED a fresh session in the same
  // cwd. Captured once from the session's current settings so the new session reproduces its setup by
  // default (the user can then tweak any control before starting).
  const seeded = useRef({
    model: session?.model ?? "",
    effort: session?.effort ?? "medium",
    permissionMode: session?.permissionMode ?? "default",
    danger: session?.dangerouslySkip ?? false,
  }).current;
  const [newModel, setNewModel] = useState(seeded.model);
  const [newEffort, setNewEffort] = useState(seeded.effort);
  const [newPermissionMode, setNewPermissionMode] = useState(seeded.permissionMode);
  const [newDanger, setNewDanger] = useState(seeded.danger);
  // Usage: prefer the prop; otherwise self-fetch via `api` (so the near-limit warning works without the
  // app wiring a new prop). `undefined` prop means "not provided → fetch"; `null` means "hide".
  const [fetchedUsage, setFetchedUsage] = useState<UsageInfo | null | undefined>(undefined);
  // "Send test notification" feedback: idle → sending → ok / error (with the failure reason). Lets a user
  // confirm push actually reaches THIS device without waiting for a real session event.
  const [testState, setTestState] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [testError, setTestError] = useState<string | undefined>(undefined);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Real modal semantics: trap Tab within the dialog and restore focus to the trigger on close.
  // This is a destructive surface (Stop session / dangerously-skip-permissions), so keyboard
  // focus must not escape to the inert background behind it. The trap goes inert while the nested
  // Claude sign-in dialog is open — that dialog runs its own trap.
  useFocusTrap(dialogRef, !authOpen);

  useEffect(() => {
    if (usage !== undefined || !api) return;
    let cancelled = false;
    void api
      .getUsage()
      .then((u) => {
        if (!cancelled) setFetchedUsage(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [usage, api]);
  const effectiveUsage = usage !== undefined ? usage : fetchedUsage;

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

  // Danger toggle for the NEW session started from this folder. Enabling is an RCE boundary, so
  // confirm-gate it (disabling is harmless — the new session just hasn't started yet).
  function toggleNewDanger(checked: boolean) {
    if (
      checked &&
      !window.confirm(
        "Enable --dangerously-skip-permissions for the NEW session? It lets the agent run tools without asking — remote code execution risk.",
      )
    ) {
      return;
    }
    setNewDanger(checked);
  }

  // POST /push/test with the bearer token (the api client doesn't own this endpoint, so call it directly the
  // way client.ts's standalone helpers do — loadToken() + API_BASE_URL). CONTRACT: the server agent adds
  // POST /push/test, which pushes a "test notification" to this account's subscriptions.
  async function sendTestNotification() {
    setTestState("sending");
    setTestError(undefined);
    try {
      const token = loadToken();
      const res = await fetch(`${API_BASE_URL}/push/test`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        let message = `failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* non-JSON error body — keep the default message */
        }
        setTestError(message);
        setTestState("error");
        return;
      }
      setTestState("ok");
    } catch {
      setTestError("network error");
      setTestState("error");
    }
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
          {effectiveUsage && <UsageSummary usage={effectiveUsage} />}
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
              {/* A running claude's model/effort/permission are FIXED when it spawns — show them read-only. */}
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
                  <span>Permission mode</span>
                  <Mono muted>{session.permissionMode ?? "default"}</Mono>
                </div>
                <div className="rc-settings__ro-row">
                  <span>Skip permissions</span>
                  <Mono muted>{String(session.dangerouslySkip)}</Mono>
                </div>
              </div>
              {onNewSessionHere ? (
                <div className="rc-settings__fields">
                  <p className="rc-settings__hint">
                    A session&apos;s model &amp; permissions can&apos;t change once it&apos;s running. Start a fresh
                    session in this same folder with the settings below — your current session stays open.
                  </p>
                  <label className="rc-settings__field">
                    <span className="rc-settings__field-label">New session model</span>
                    <ModelSelect
                      value={newModel}
                      onChange={setNewModel}
                      models={models}
                      ariaLabel="new session model"
                      className="rc-settings__control rc-settings__control--mono"
                    />
                  </label>
                  <label className="rc-settings__field">
                    <span className="rc-settings__field-label">New session effort</span>
                    <select
                      aria-label="new session effort"
                      value={newEffort}
                      onChange={(e) => setNewEffort(e.target.value)}
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
                    <span className="rc-settings__field-label">New session permission mode</span>
                    <select
                      aria-label="new session permission mode"
                      value={newPermissionMode}
                      onChange={(e) => setNewPermissionMode(e.target.value)}
                      className="rc-settings__control"
                    >
                      {PERMISSION_MODES.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={`rc-settings__danger-check${newDanger ? " rc-settings__danger-check--on" : ""}`}>
                    <input
                      type="checkbox"
                      aria-label="new session dangerously skip permissions"
                      checked={newDanger}
                      onChange={(e) => toggleNewDanger(e.target.checked)}
                    />
                    <span>Dangerously skip permissions (RCE risk)</span>
                  </label>
                  <button
                    type="button"
                    className="rc-settings__primary"
                    aria-label="New session in this folder with these settings"
                    onClick={() =>
                      onNewSessionHere({
                        cwd: session.cwd,
                        model: newModel || undefined,
                        effort: newEffort,
                        permissionMode: newPermissionMode,
                        dangerouslySkip: newDanger,
                      })
                    }
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "var(--sp-2)",
                      }}
                    >
                      <Icon name="plus" size={15} />
                      New session in this folder
                    </span>
                  </button>
                </div>
              ) : (
                <p className="rc-settings__hint">
                  Model/effort/permissions are set when a session starts. To change them, start a new session.
                </p>
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
            <label className="rc-settings__field">
              <span className="rc-settings__field-label">Default permission mode</span>
              <select
                value={draft.permissionMode ?? "default"}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, permissionMode: e.target.value === "default" ? undefined : e.target.value }))
                }
                className="rc-settings__control"
                aria-label="default permission mode"
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
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

          {api && (
            <section className="rc-settings__section rc-settings__section--divided">
              <div className="rc-settings__section-head">
                <span className="rc-settings__section-icon" aria-hidden="true">
                  <Icon name="terminal" size={15} />
                </span>
                <span className="rc-settings__section-label">Claude account</span>
              </div>
              {/* The always-present entry point to the (otherwise orphaned) in-app sign-in dialog: if turns
                  start failing with a 401, the host's Claude login can be renewed from the phone here. */}
              <button
                type="button"
                className="rc-settings__authrow"
                onClick={() => setAuthOpen(true)}
                aria-label="Claude sign-in / Re-authenticate"
              >
                <span className="rc-settings__authrow-main">
                  <span className="rc-settings__authrow-title">Claude sign-in / Re-authenticate</span>
                  <span className="rc-settings__authrow-sub">
                    Claude keeps erroring, or the login expired? Sign in again here — no SSH needed.
                  </span>
                </span>
                <Icon name="chevron-right" size={16} />
              </button>
            </section>
          )}

          {onSignOut && (
            <section className="rc-settings__section rc-settings__section--divided">
              <div className="rc-settings__section-head">
                <span className="rc-settings__section-icon" aria-hidden="true">
                  <Icon name="lock" size={15} />
                </span>
                <span className="rc-settings__section-label">This device</span>
              </div>
              {/* Sign out of remote-coder itself (CONTRACT C2): the App clears the stored access token and
                  returns to the login screen. Confirm-gated — you need the connect link/token to sign back in. */}
              <button
                type="button"
                className="rc-settings__authrow"
                aria-label="Sign out"
                onClick={() => {
                  if (
                    window.confirm(
                      "Sign out of remote-coder on this device? You'll need the access link or token to sign back in.",
                    )
                  ) {
                    onSignOut();
                  }
                }}
              >
                <span className="rc-settings__authrow-main">
                  <span className="rc-settings__authrow-title">Sign out</span>
                  <span className="rc-settings__authrow-sub">Clear the access token on this device and return to login.</span>
                </span>
                <Icon name="power" size={16} />
              </button>
            </section>
          )}

          {pushState && (
            <section className="rc-settings__section rc-settings__section--divided">
              <div className="rc-settings__section-head">
                <span className="rc-settings__section-icon" aria-hidden="true">
                  <Icon name="bell" size={15} />
                </span>
                <span className="rc-settings__section-label">Notifications</span>
              </div>
              {pushState === "unsupported" ? (
                isIosNonStandalone() ? (
                  // iOS Safari only allows Web Push from a Home-Screen (installed) PWA — the generic
                  // HTTPS/browser copy is misleading here, so give the actual fix.
                  <p className="rc-settings__hint">
                    On iPhone/iPad: tap the Share button, choose <strong>Add to Home Screen</strong>, then reopen
                    the app from the Home Screen and enable notifications here.
                  </p>
                ) : (
                  <p className="rc-settings__hint">
                    Web Push needs HTTPS (or localhost) and a supporting browser. Open this app over your secure
                    tunnel to enable notifications.
                  </p>
                )
              ) : pushState === "denied" ? (
                <p className="rc-settings__hint">
                  Notifications are blocked for this site. Re-enable them in your browser&apos;s site settings, then
                  reopen this panel.
                </p>
              ) : pushState === "subscribed" ? (
                <>
                  <button
                    type="button"
                    className="rc-settings__secondary"
                    aria-label="Disable notifications"
                    onClick={() => onDisablePush?.()}
                  >
                    Notifications on — tap to disable
                  </button>
                  {/* Prove push reaches THIS device without waiting for a real session event. */}
                  <button
                    type="button"
                    className="rc-settings__secondary"
                    aria-label="Send test notification"
                    disabled={testState === "sending"}
                    onClick={() => void sendTestNotification()}
                  >
                    {testState === "sending"
                      ? "Sending…"
                      : testState === "ok"
                        ? "Sent ✓"
                        : "Send test notification"}
                  </button>
                  {testState === "error" && (
                    <p className="rc-settings__hint" role="alert" style={{ color: "var(--err)" }}>
                      Couldn&apos;t send test — {testError ?? "unknown error"}.
                    </p>
                  )}
                </>
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

      {/* The in-app Claude sign-in dialog, opened from the "Claude account" row above. It runs its own
          focus trap, so the settings trap is held inert (see useFocusTrap gate) while it's open. */}
      {api && authOpen && <ClaudeAuthDialog api={api} onClose={() => setAuthOpen(false)} />}

      <style>{settingsCss}</style>
    </div>
  );
}

/**
 * Compact usage readout for the panel: renders every available bar (incl. the Sonnet-only weekly bar,
 * which the rail's UsageBars omits) and — the point — surfaces a prominent warning the moment any bar
 * crosses {@link USAGE_WARN_AT}%, so a near-limit isn't a surprise. Reuses UsageBars' color + reset
 * helpers so it reads identically to the rail.
 */
function UsageSummary({ usage }: { usage: UsageInfo }) {
  const bars: { label: string; bar: UsageInfo["session"] }[] = [
    { label: "Session (5h)", bar: usage.session },
    { label: "Weekly", bar: usage.week },
    { label: "Weekly · Sonnet", bar: usage.weekSonnet },
  ];
  const present = bars.filter((b): b is { label: string; bar: NonNullable<UsageInfo["session"]> } => Boolean(b.bar));
  if (present.length === 0) return null;

  const pctOf = (p: number) => Math.max(0, Math.min(100, Math.round(p)));
  const near = present.filter((b) => pctOf(b.bar.percent) >= USAGE_WARN_AT);

  return (
    <div className="rc-settings__usage">
      {near.length > 0 && (
        <div className="rc-settings__usage-warn" role="status">
          <Icon name="alert" size={16} />
          <span>
            Near a Claude usage limit —{" "}
            {near.map((b, i) => (
              <span key={b.label}>
                {i > 0 ? "; " : ""}
                {b.label} ~{pctOf(b.bar.percent)}% used, resets {shortenReset(b.bar.resets)}
              </span>
            ))}
            .
          </span>
        </div>
      )}
      <div className="rc-settings__usage-bars">
        {present.map(({ label, bar }) => {
          const pct = pctOf(bar.percent);
          return (
            <div className="rc-settings__usage-row" key={label}>
              <div className="rc-settings__usage-line">
                <span className="rc-settings__usage-label">{label}</span>
                <span className="rc-settings__usage-pct">{pct}%</span>
              </div>
              <div
                className="rc-settings__usage-track"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${label} limit ${pct}% used`}
              >
                <span
                  className="rc-settings__usage-fill"
                  style={{ width: `${pct}%`, background: usageFillColor(pct) }}
                />
              </div>
              <span className="rc-settings__usage-reset">resets {shortenReset(bar.resets)}</span>
            </div>
          );
        })}
      </div>
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
.rc-settings__secondary:disabled { opacity: 0.6; cursor: default; }
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
/* Claude account row — a full-width tappable row that opens the in-app sign-in dialog. */
.rc-settings__authrow {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
  width: 100%; min-height: var(--tap-min); text-align: left;
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--text); cursor: pointer; font: inherit;
  transition: border-color 120ms ease, background 120ms ease;
}
.rc-settings__authrow:hover { border-color: var(--text-faint); }
.rc-settings__authrow > :last-child { color: var(--text-faint); flex: none; }
.rc-settings__authrow-main { display: grid; gap: 2px; min-width: 0; }
.rc-settings__authrow-title { font-size: var(--fs-sm); font-weight: 500; }
.rc-settings__authrow-sub { font-size: var(--fs-xs); color: var(--text-muted); }
/* Usage readout — a bordered mini-panel at the top of the body with a near-limit warning. */
.rc-settings__usage {
  display: grid; gap: var(--sp-3);
  padding: var(--sp-3);
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.rc-settings__usage-warn {
  display: flex; align-items: flex-start; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  background: var(--err-bg); color: var(--err); border: 1px solid var(--err-border);
  border-radius: var(--radius-sm); font-size: var(--fs-sm); line-height: 1.4;
}
.rc-settings__usage-warn > :first-child { flex: none; margin-top: 1px; }
.rc-settings__usage-bars { display: grid; gap: var(--sp-3); }
.rc-settings__usage-row { display: grid; gap: 5px; }
.rc-settings__usage-line { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
.rc-settings__usage-label {
  font-size: var(--fs-xs); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-muted);
}
.rc-settings__usage-pct {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text); font-variant-numeric: tabular-nums;
}
.rc-settings__usage-track {
  position: relative; height: 4px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--border); overflow: hidden;
}
.rc-settings__usage-fill { display: block; height: 100%; border-radius: 999px; transition: width 360ms ease; }
.rc-settings__usage-reset {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-faint); font-variant-numeric: tabular-nums;
}
@media (prefers-reduced-motion: reduce) { .rc-settings__usage-fill { transition: none; } }
`;
