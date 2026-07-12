import { useEffect, useRef, useState } from "react";
import { Mono } from "../ui/Mono";
import { Icon, type IconName } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import type { SessionDefaults } from "./defaults";
import type { ModelInfo, SessionMeta, UsageInfo } from "../types/server";
import type { ApiClient } from "../api/client";
import { ClaudeSessionOptions, type ClaudeOptionDraft } from "../providers/ClaudeSessionOptions";
import { CodexSessionOptions, type CodexOptionDraft } from "../providers/CodexSessionOptions";
import type { CodexModel, CodexSessionOptions as CodexDefaults } from "../providers/types";
import { ProviderAccounts } from "./ProviderAccounts";
import { shortenReset, usageFillColor } from "../session/UsageBars";
import { loadToken } from "../auth/token-store";
import { loadTheme, setTheme, type ThemeName } from "../pwa/theme";
import { API_BASE_URL } from "../config";
import type { SessionOrder } from "../session/order-preference";

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

/** Options for starting a fresh session in an existing session's folder (see `onNewSessionHere`). Just the
 *  cwd — the wizard seeds model/effort/permissions/danger from the user's SAVED defaults (the per-launch
 *  overrides that used to ride along here silently beat those defaults, reading as "settings not saved"). */
export interface NewSessionHereOptions {
  cwd: string;
}

export type DefaultsSaveState = "idle" | "saving" | "saved" | "error" | "conflict";
export type DefaultsSyncStatus = "loading" | "synced" | "unsynced";

export interface SettingsPanelProps {
  session?: SessionMeta;
  defaults: SessionDefaults;
  sessionOrder?: SessionOrder;
  onSessionOrderChange?: (order: SessionOrder) => void;
  onSaveDefaults: (d: SessionDefaults) => Promise<void>;
  defaultsSaveState?: DefaultsSaveState;
  defaultsSaveError?: string;
  defaultsSyncState?: DefaultsSyncStatus;
  /** When provided, renders independent Claude Code and Codex account controls. */
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
  codexModels?: CodexModel[];
  codexProfiles?: string[];
  claudeMetadataState?: "loading" | "ready" | "unavailable";
  codexMetadataState?: "loading" | "ready" | "unavailable";
  onRetryProviderMetadata?: () => void;
  /** Latest usage snapshot (GET /usage). Omit to let the panel fetch it itself via `api`; pass `null`
   * to force it hidden (tests/screenshots). Drives the near-limit warning + the Sonnet weekly bar. */
  usage?: UsageInfo | null;
  /** Push opt-in handlers. When omitted, the Notifications section is hidden (e.g. in tests/screenshots). */
  pushState?: "subscribed" | "unsubscribed" | "unsupported" | "denied";
  onEnablePush?: () => void;
  onDisablePush?: () => void;
  /** Sign out of roamcode itself (CONTRACT C2): the App wires this to clear the stored access token and
   * return to the login screen. When omitted, the "Sign out" row is hidden. */
  onSignOut?: () => void;
  onClose: () => void;
}

/** Warn once a usage bar crosses this fraction of its limit. */
const USAGE_WARN_AT = 90;

type SettingsSectionId = "session" | "appearance" | "defaults" | "accounts" | "device" | "notifications";

interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  icon: IconName;
}

function claudeDraft(defaults: SessionDefaults): ClaudeOptionDraft {
  return {
    effort: defaults.effort,
    model: defaults.model ?? "",
    permissionMode: defaults.permissionMode ?? "default",
    addDirs: [],
    dangerouslySkip: defaults.dangerouslySkip,
  };
}

function codexDraft(defaults: SessionDefaults): CodexOptionDraft {
  return {
    model: defaults.codex?.model ?? "",
    reasoningEffort: defaults.codex?.reasoningEffort ?? "medium",
    sandbox: defaults.codex?.sandbox ?? "workspace-write",
    approvalPolicy: defaults.codex?.approvalPolicy ?? "on-request",
    profile: defaults.codex?.profile ?? "",
    webSearch: defaults.codex?.webSearch ?? false,
    addDirs: defaults.codex?.addDirs ? [...defaults.codex.addDirs] : [],
    dangerouslyBypassApprovalsAndSandbox: defaults.codex?.dangerouslyBypassApprovalsAndSandbox ?? false,
  };
}

function codexDefaults(value: CodexOptionDraft): CodexDefaults {
  const common = {
    ...(value.model ? { model: value.model } : {}),
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort as CodexDefaults["reasoningEffort"] } : {}),
    ...(value.profile ? { profile: value.profile } : {}),
    ...(value.webSearch ? { webSearch: true } : {}),
    ...(value.addDirs.length > 0 ? { addDirs: [...value.addDirs] } : {}),
  };
  return value.dangerouslyBypassApprovalsAndSandbox
    ? { ...common, dangerouslyBypassApprovalsAndSandbox: true }
    : {
        ...common,
        sandbox: value.sandbox as CodexDefaults["sandbox"],
        approvalPolicy: value.approvalPolicy as CodexDefaults["approvalPolicy"],
      };
}

export function SettingsPanel({
  session,
  defaults,
  sessionOrder = "created",
  onSessionOrderChange,
  onSaveDefaults,
  defaultsSaveState = "idle",
  defaultsSaveError,
  defaultsSyncState = "synced",
  api,
  onStopSession,
  onNewSessionHere,
  models = [],
  codexModels = [],
  codexProfiles = [],
  claudeMetadataState = models.length > 0 ? "ready" : "unavailable",
  codexMetadataState = codexModels.length > 0 ? "ready" : "unavailable",
  onRetryProviderMetadata,
  usage,
  pushState,
  onEnablePush,
  onDisablePush,
  onSignOut,
  onClose,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<SessionDefaults>(defaults);
  const [draftDirty, setDraftDirty] = useState(false);
  const [savingLocally, setSavingLocally] = useState(false);
  const [claudeDefaultsOpen, setClaudeDefaultsOpen] = useState(false);
  const [codexDefaultsOpen, setCodexDefaultsOpen] = useState(false);
  const draftVersion = useRef(0);
  const submittedVersion = useRef<number | undefined>(undefined);
  const previousDefaults = useRef(defaults);
  // Appearance: the OLED true-black toggle. Mirrors the persisted theme; setTheme applies it instantly.
  const [theme, setThemeState] = useState<ThemeName>(() => loadTheme());
  // Usage: prefer the prop; otherwise self-fetch via `api` (so the near-limit warning works without the
  // app wiring a new prop). `undefined` prop means "not provided → fetch"; `null` means "hide".
  const [fetchedUsage, setFetchedUsage] = useState<UsageInfo | null | undefined>(undefined);
  // "Send test notification" feedback: idle → sending → ok / error (with the failure reason). Lets a user
  // confirm push actually reaches THIS device without waiting for a real session event.
  const [testState, setTestState] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [testError, setTestError] = useState<string | undefined>(undefined);
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(session ? "session" : "appearance");

  // Real modal semantics: trap Tab within the dialog and restore focus to the trigger on close.
  // This is a destructive surface (Stop session / dangerously-skip-permissions), so keyboard
  // focus must not escape to the inert background behind it.
  useFocusTrap(dialogRef);

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

  // Conflicts always adopt the authoritative server document. Normal hydration adopts changed props only while
  // the draft is clean; generic failures and edits made during a pending save remain available for retry.
  useEffect(() => {
    const defaultsChanged = previousDefaults.current !== defaults;
    previousDefaults.current = defaults;
    if (defaultsSaveState === "conflict") {
      draftVersion.current += 1;
      submittedVersion.current = undefined;
      setDraft(defaults);
      setDraftDirty(false);
    } else if (defaultsSaveState === "saved") {
      if (submittedVersion.current === draftVersion.current) {
        setDraft(defaults);
        setDraftDirty(false);
      }
      submittedVersion.current = undefined;
    } else if (defaultsChanged && !draftDirty && defaultsSaveState === "idle" && defaultsSyncState === "synced") {
      setDraft(defaults);
    }
  }, [defaults, defaultsSaveState, defaultsSyncState, draftDirty]);

  async function saveDefaultsNow() {
    if (savingLocally || defaultsSaveState === "saving") return;
    const version = draftVersion.current;
    submittedVersion.current = version;
    setSavingLocally(true);
    try {
      await onSaveDefaults(draft);
    } catch {
      if (submittedVersion.current === version) submittedVersion.current = undefined;
      // App-owned save state/error drives the retryable feedback below.
    } finally {
      setSavingLocally(false);
    }
  }

  function changeDraft(update: (current: SessionDefaults) => SessionDefaults) {
    draftVersion.current += 1;
    setDraftDirty(true);
    setDraft(update);
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

  const navigation: SettingsNavItem[] = [
    ...(session ? [{ id: "session", label: "Current session", icon: "sliders" } as const] : []),
    { id: "appearance", label: "Appearance", icon: "settings" },
    { id: "defaults", label: "New sessions", icon: "plus" },
    ...(api ? [{ id: "accounts", label: "Provider accounts", icon: "terminal" } as const] : []),
    ...(onSignOut ? [{ id: "device", label: "This device", icon: "lock" } as const] : []),
    ...(pushState ? [{ id: "notifications", label: "Notifications", icon: "bell" } as const] : []),
  ];

  function scrollToSection(id: SettingsSectionId) {
    setActiveSection(id);
    contentRef.current?.querySelector<HTMLElement>(`#settings-${id}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  function updateActiveSection() {
    const content = contentRef.current;
    if (!content) return;
    const contentTop = content.getBoundingClientRect().top + 24;
    let next = navigation[0]?.id;
    for (const item of navigation) {
      const section = content.querySelector<HTMLElement>(`#settings-${item.id}`);
      if (section && section.getBoundingClientRect().top <= contentTop) next = item.id;
    }
    if (next) setActiveSection(next);
  }

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Settings" className="rc-settings">
      <section className="rc-settings__card">
        <header className="rc-settings__head">
          <span className="rc-settings__head-id">
            <span className="rc-settings__head-icon" aria-hidden="true">
              <Icon name="settings" size={18} />
            </span>
            <span className="rc-settings__heading">
              <strong className="display rc-settings__title">Settings</strong>
              <span className="rc-settings__subtitle">Everything in one place, grouped by task.</span>
            </span>
          </span>
          <button type="button" className="rc-settings__close" onClick={onClose} aria-label="Close settings">
            <span className="rc-settings__close-label">Done</span>
            <Icon name="x" size={18} className="rc-settings__close-icon" />
          </button>
        </header>

        <div className="rc-settings__layout">
          <nav className="rc-settings__nav" aria-label="Settings categories">
            <span className="rc-settings__nav-label">Categories</span>
            <div className="rc-settings__nav-items">
              {navigation.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`rc-settings__nav-item${activeSection === item.id ? " rc-settings__nav-item--active" : ""}`}
                  aria-current={activeSection === item.id ? "page" : undefined}
                  aria-controls={`settings-${item.id}`}
                  onClick={() => scrollToSection(item.id)}
                >
                  <Icon name={item.icon} size={16} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </nav>

          <div ref={contentRef} className="rc-settings__body" onScroll={updateActiveSection}>
            {!api && effectiveUsage && <UsageSummary usage={effectiveUsage} />}
            {session && (
              <section id="settings-session" className="rc-settings__section" aria-labelledby="settings-session-title">
                <div className="rc-settings__section-head">
                  <span className="rc-settings__section-icon" aria-hidden="true">
                    <Icon name="sliders" size={15} />
                  </span>
                  <span>
                    <span id="settings-session-title" className="rc-settings__section-label">
                      Current session
                    </span>
                    <span className="rc-settings__section-description">Runtime details and session actions</span>
                  </span>
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
                      Runtime choices can&apos;t change after a session starts. Open a new session in this folder to use
                      different defaults; this session stays open.
                    </p>
                    {/* Just the cwd — NO per-launch overrides. The duplicated model/effort/danger controls that
                      used to live here (seeded from the CURRENT session) silently overrode the user's SAVED
                      defaults in the wizard, which read as "my settings aren't remembered" — the exact report.
                      One place chooses new-session settings now: the wizard, seeded from the saved defaults. */}
                    <button
                      type="button"
                      className="rc-settings__primary"
                      aria-label="New session in this folder"
                      onClick={() => onNewSessionHere({ cwd: session.cwd })}
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
                          "Close this session? It's removed from the list and its agent process is terminated. The transcript stays on disk — you can resume it later.",
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

            <section
              id="settings-appearance"
              className="rc-settings__section rc-settings__section--divided"
              aria-labelledby="settings-appearance-title"
            >
              <div className="rc-settings__section-head">
                <span className="rc-settings__section-icon" aria-hidden="true">
                  <Icon name="settings" size={15} />
                </span>
                <span>
                  <span id="settings-appearance-title" className="rc-settings__section-label">
                    Appearance
                  </span>
                  <span className="rc-settings__section-description">Theme and session list preferences</span>
                </span>
              </div>
              {/* OLED true-black: applies INSTANTLY (no save button) — a client-side preference persisted in
                this browser's localStorage, like session names. On an OLED panel #000 pixels are off. */}
              <label className="rc-settings__danger-check" style={{ color: "var(--text)" }}>
                <input
                  type="checkbox"
                  aria-label="OLED black theme"
                  checked={theme === "oled"}
                  onChange={(e) => {
                    const next = e.target.checked ? "oled" : "dark";
                    setThemeState(next);
                    setTheme(next);
                  }}
                  style={{ accentColor: "var(--coral)" }}
                />
                <span className="rc-settings__option-copy">
                  <strong>True black theme</strong>
                  <small>Uses pure black for OLED displays.</small>
                </span>
              </label>
              <label className="rc-settings__field">
                <span className="rc-settings__field-label">Session order</span>
                <select
                  className="rc-settings__control"
                  aria-label="Session order"
                  value={sessionOrder}
                  onChange={(event) => onSessionOrderChange?.(event.target.value as SessionOrder)}
                >
                  <option value="created">Stable (created)</option>
                  <option value="activity">Recent activity</option>
                </select>
              </label>
              <p className="rc-settings__hint">Sessions that need you always stay on top.</p>
            </section>

            <section
              id="settings-defaults"
              className="rc-settings__section rc-settings__section--divided"
              aria-labelledby="settings-defaults-title"
            >
              <div className="rc-settings__section-head">
                <span className="rc-settings__section-icon" aria-hidden="true">
                  <Icon name="plus" size={15} />
                </span>
                <span>
                  <span id="settings-defaults-title" className="rc-settings__section-label">
                    New sessions
                  </span>
                  <span className="rc-settings__section-description">Default models, reasoning and permissions</span>
                </span>
              </div>
              {defaultsSyncState === "loading" && (
                <p role="status" className="rc-settings__note">
                  Using a local fallback while server defaults load; it is not yet saved to the server.
                </p>
              )}
              {defaultsSyncState === "unsynced" && (
                <p role="status" className="rc-settings__note">
                  Couldn&apos;t synchronize defaults with the server. The local fallback is active; save defaults to
                  retry.
                </p>
              )}
              <div className="rc-settings__provider-defaults">
                <details
                  className="rc-settings__provider"
                  open={claudeDefaultsOpen}
                  onToggle={(event) => setClaudeDefaultsOpen(event.currentTarget.open)}
                >
                  <summary
                    onClick={(event) => {
                      event.preventDefault();
                      setClaudeDefaultsOpen((open) => !open);
                    }}
                  >
                    <span>Claude Code</span>
                    {draft.dangerouslySkip && <span className="rc-settings__provider-warning">Unsafe mode on</span>}
                  </summary>
                  {claudeDefaultsOpen && (
                    <div className="rc-settings__provider-body">
                      <ClaudeSessionOptions
                        value={claudeDraft(draft)}
                        onChange={(value) =>
                          changeDraft((current) => ({
                            ...current,
                            effort: value.effort || current.effort,
                            ...(value.model ? { model: value.model } : { model: undefined }),
                            ...(value.dangerouslySkip
                              ? { dangerouslySkip: true, permissionMode: undefined }
                              : {
                                  dangerouslySkip: false,
                                  ...(value.permissionMode === "default"
                                    ? { permissionMode: undefined }
                                    : { permissionMode: value.permissionMode }),
                                }),
                          }))
                        }
                        models={models}
                        metadataState={claudeMetadataState}
                        onRetryMetadata={onRetryProviderMetadata}
                        ariaLabelPrefix="Default"
                        showAdditionalDirectories={false}
                      />
                    </div>
                  )}
                </details>
                <details
                  className="rc-settings__provider"
                  open={codexDefaultsOpen}
                  onToggle={(event) => setCodexDefaultsOpen(event.currentTarget.open)}
                >
                  <summary
                    onClick={(event) => {
                      event.preventDefault();
                      setCodexDefaultsOpen((open) => !open);
                    }}
                  >
                    <span>Codex</span>
                    {draft.codex?.dangerouslyBypassApprovalsAndSandbox && (
                      <span className="rc-settings__provider-warning">Unsafe mode on</span>
                    )}
                  </summary>
                  {codexDefaultsOpen && (
                    <div className="rc-settings__provider-body">
                      <CodexSessionOptions
                        value={codexDraft(draft)}
                        onChange={(value) => changeDraft((current) => ({ ...current, codex: codexDefaults(value) }))}
                        models={codexModels}
                        profiles={codexProfiles}
                        metadataState={codexMetadataState}
                        onRetryMetadata={onRetryProviderMetadata}
                      />
                    </div>
                  )}
                </details>
              </div>
              <button
                type="button"
                className="rc-settings__primary"
                onClick={saveDefaultsNow}
                aria-label={
                  savingLocally || defaultsSaveState === "saving"
                    ? "Saving defaults"
                    : defaultsSaveState === "saved" && !draftDirty
                      ? "Defaults saved"
                      : "Save defaults"
                }
                aria-live="polite"
                disabled={savingLocally || defaultsSaveState === "saving"}
              >
                {savingLocally || defaultsSaveState === "saving" ? (
                  "Saving…"
                ) : defaultsSaveState === "saved" && !draftDirty ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "var(--sp-2)",
                    }}
                  >
                    <Icon name="check" size={15} />
                    <span>Saved</span>
                    <span aria-hidden="true">✓</span>
                  </span>
                ) : (
                  "Save defaults"
                )}
              </button>
              {(defaultsSaveState === "error" || defaultsSaveState === "conflict") && defaultsSaveError && (
                <p role="alert" className="rc-settings__note">
                  {defaultsSaveError}
                </p>
              )}
            </section>

            {api && (
              <section
                id="settings-accounts"
                className="rc-settings__section rc-settings__section--divided"
                aria-labelledby="settings-accounts-title"
              >
                <div className="rc-settings__section-head">
                  <span className="rc-settings__section-icon" aria-hidden="true">
                    <Icon name="terminal" size={15} />
                  </span>
                  <span>
                    <span id="settings-accounts-title" className="rc-settings__section-label">
                      Provider accounts
                    </span>
                    <span className="rc-settings__section-description">Sign-in status, versions and usage</span>
                  </span>
                </div>
                <ProviderAccounts api={api} claudeUsage={effectiveUsage ?? null} />
              </section>
            )}

            {onSignOut && (
              <section
                id="settings-device"
                className="rc-settings__section rc-settings__section--divided"
                aria-labelledby="settings-device-title"
              >
                <div className="rc-settings__section-head">
                  <span className="rc-settings__section-icon" aria-hidden="true">
                    <Icon name="lock" size={15} />
                  </span>
                  <span>
                    <span id="settings-device-title" className="rc-settings__section-label">
                      This device
                    </span>
                    <span className="rc-settings__section-description">Local access and sign-out</span>
                  </span>
                </div>
                {/* Sign out of roamcode itself (CONTRACT C2): the App clears the stored access token and
                  returns to the login screen. Confirm-gated — you need the connect link/token to sign back in. */}
                <button
                  type="button"
                  className="rc-settings__authrow"
                  aria-label="Sign out"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Sign out of roamcode on this device? You'll need the access link or token to sign back in.",
                      )
                    ) {
                      onSignOut();
                    }
                  }}
                >
                  <span className="rc-settings__authrow-main">
                    <span className="rc-settings__authrow-title">Sign out</span>
                    <span className="rc-settings__authrow-sub">
                      Clear the access token on this device and return to login.
                    </span>
                  </span>
                  <Icon name="power" size={16} />
                </button>
              </section>
            )}

            {pushState && (
              <section
                id="settings-notifications"
                className="rc-settings__section rc-settings__section--divided"
                aria-labelledby="settings-notifications-title"
              >
                <div className="rc-settings__section-head">
                  <span className="rc-settings__section-icon" aria-hidden="true">
                    <Icon name="bell" size={15} />
                  </span>
                  <span>
                    <span id="settings-notifications-title" className="rc-settings__section-label">
                      Notifications
                    </span>
                    <span className="rc-settings__section-description">Alerts for completed work and questions</span>
                  </span>
                </div>
                {pushState === "unsupported" ? (
                  isIosNonStandalone() ? (
                    // iOS Safari only allows Web Push from a Home-Screen (installed) PWA — the generic
                    // HTTPS/browser copy is misleading here, so give the actual fix.
                    <p className="rc-settings__hint">
                      On iPhone/iPad: tap the Share button, choose <strong>Add to Home Screen</strong>, then reopen the
                      app from the Home Screen and enable notifications here.
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
                      {testState === "sending" ? "Sending…" : testState === "ok" ? "Sent ✓" : "Send test notification"}
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

            <p className="rc-settings__note rc-settings__footnote">Your access token stays in this browser.</p>
          </div>
        </div>
      </section>

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
  position: fixed; inset: 0; z-index: 70;
  background-color: var(--bg);
  background-image: var(--top-glow);
  display: grid; place-items: center;
  padding: var(--sp-5);
  overflow-y: auto;
}
/* The settings card — a clean floating-glass dialog (subtle fill + blur + a --line-2 border). The one
   accent is the Save/Apply coral primary. */
.rc-settings__card {
  width: min(94vw, 860px);
  /* Cap the card to the viewport and make it a flex column so the BODY scrolls (not the page): the
     header stays put and every section — incl. "Default effort" + "Save defaults" — is reachable on a
     short phone screen. */
  display: flex; flex-direction: column;
  height: min(88vh, 760px);
  max-height: calc(100dvh - 2 * var(--sp-5));
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
.rc-settings__heading { display: grid; gap: 2px; }
/* The Settings glyph — NEUTRAL (coral is reserved for the Save/Apply primary). */
.rc-settings__head-icon { color: var(--text-muted); display: grid; place-items: center; }
.rc-settings__title { font-size: var(--fs-lg); }
.rc-settings__subtitle { color: var(--text-muted); font-size: var(--fs-xs); }
.rc-settings__close {
  width: var(--tap-min); height: var(--tap-min); flex: none;
  display: grid; place-items: center;
  background: transparent; border: none; cursor: pointer;
  color: var(--text-muted); border-radius: var(--radius);
  transition: color 120ms ease, background 120ms ease;
}
.rc-settings__close-label { display: none; }
.rc-settings__close:hover { color: var(--text); background: var(--surface-2); }
.rc-settings__layout {
  flex: 1; min-height: 0;
  display: grid; grid-template-columns: 190px minmax(0, 1fr);
}
.rc-settings__nav {
  min-width: 0; overflow-y: auto;
  padding: var(--sp-4) var(--sp-3);
  border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 72%, transparent);
}
.rc-settings__nav-label {
  display: block; padding: 0 var(--sp-2) var(--sp-2);
  color: var(--text-faint); font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
}
.rc-settings__nav-items { display: grid; gap: var(--sp-1); }
.rc-settings__nav-item {
  position: relative; width: 100%; min-height: var(--tap-min);
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 0 var(--sp-3); border: 1px solid transparent; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-muted); cursor: pointer; font: inherit;
  font-size: var(--fs-sm); text-align: left;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-settings__nav-item:hover { color: var(--text); background: var(--surface-2); }
.rc-settings__nav-item--active {
  color: var(--text); background: var(--accent-soft); border-color: var(--accent-line);
}
.rc-settings__nav-item--active::before {
  content: ""; position: absolute; left: 5px; width: 2px; height: 16px;
  border-radius: var(--radius-pill); background: var(--accent);
}
.rc-settings__nav-item > :first-child { flex: none; }
.rc-settings__body {
  min-width: 0; min-height: 0; overflow-y: auto; scroll-behavior: smooth;
  padding: var(--sp-5);
  padding-bottom: calc(var(--sp-5) + env(safe-area-inset-bottom, 0px));
  display: grid; gap: var(--sp-4);
}
.rc-settings__section {
  display: grid; gap: var(--sp-3); scroll-margin-top: var(--sp-5);
  padding: var(--sp-4); border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--surface);
}
.rc-settings__section--divided { border-top: 1px solid var(--border); padding-top: var(--sp-4); }
.rc-settings__section-head { display: flex; align-items: flex-start; gap: var(--sp-2); }
.rc-settings__section-head > :last-child { display: grid; gap: 3px; }
.rc-settings__section-icon { color: var(--text-faint); display: grid; place-items: center; }
.rc-settings__section-label {
  display: block; color: var(--text); font-family: var(--font-display); font-weight: 650;
  font-size: var(--fs-sm); letter-spacing: -0.01em;
}
.rc-settings__section-description { color: var(--text-muted); font-size: var(--fs-xs); line-height: 1.4; }
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
.rc-settings__provider-defaults { display: grid; gap: var(--sp-2); }
.rc-settings__provider {
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2);
}
.rc-settings__provider > summary {
  min-height: var(--tap-min); display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); cursor: pointer;
  padding: 0 var(--sp-3); color: var(--text); font-size: var(--fs-sm); font-weight: 600;
}
.rc-settings__provider > summary::marker { color: var(--text-faint); }
.rc-settings__provider-warning {
  flex: none; color: var(--err); font-size: 10px; font-weight: 650;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.rc-settings__provider-body {
  display: grid; gap: var(--sp-3); padding: var(--sp-3); border-top: 1px solid var(--border);
}
/* Provider option components are shared with the wizard so model/effort compatibility and safety copy stay
   single-sourced. Give their semantic wizard classes a compact Settings presentation here. */
.rc-settings__provider-body .rc-wizard__field { display: grid; gap: var(--sp-2); }
.rc-settings__provider-body .rc-wizard__field-label,
.rc-settings__provider-body .rc-wizard__help { font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; }
.rc-settings__provider-body .rc-wizard__control {
  width: 100%; min-height: var(--tap-min); padding: 0 var(--sp-3); font: inherit; color: var(--text);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.rc-settings__provider-body .rc-wizard__control--mono { font-family: var(--font-mono); }
.rc-settings__provider-body .rc-wizard__advanced { border-top: 1px solid var(--border); padding-top: var(--sp-2); }
.rc-settings__provider-body .rc-wizard__advanced > summary {
  cursor: pointer; color: var(--text-muted); font-size: var(--fs-xs);
}
.rc-settings__provider-body .rc-wizard__advanced-body { display: grid; gap: var(--sp-3); padding-top: var(--sp-3); }
.rc-settings__provider-body .rc-wizard__danger {
  min-height: var(--tap-min); display: flex; align-items: center; gap: var(--sp-2);
  color: var(--text); font-size: var(--fs-sm);
}
.rc-settings__provider-body .rc-wizard__danger--on { color: var(--err); }
.rc-settings__provider-body .rc-wizard__danger input { width: 20px; height: 20px; accent-color: var(--err); }
.rc-settings__provider-body .rc-wizard__danger-arm {
  display: grid; gap: var(--sp-2); padding: var(--sp-3); border-radius: var(--radius-sm);
  background: var(--err-soft); border: 1px solid var(--err-line);
}
.rc-settings__provider-body .rc-wizard__danger-arm-text { margin: 0; font-size: var(--fs-sm); line-height: 1.45; }
.rc-settings__provider-body .rc-wizard__danger-arm-row { display: flex; gap: var(--sp-2); }
.rc-settings__provider-body .rc-wizard__danger-arm-yes,
.rc-settings__provider-body .rc-wizard__danger-arm-no,
.rc-settings__provider-body .rc-wizard__cancel {
  min-height: var(--tap-min); padding: 0 var(--sp-3); border-radius: var(--radius-sm); cursor: pointer; font: inherit;
}
.rc-settings__provider-body .rc-wizard__danger-arm-yes { background: var(--err); border: 1px solid var(--err); color: #fff; }
.rc-settings__provider-body .rc-wizard__danger-arm-no,
.rc-settings__provider-body .rc-wizard__cancel { background: transparent; border: 1px solid var(--border); color: var(--text); }
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
.rc-settings__option-copy { display: grid; gap: 2px; }
.rc-settings__option-copy strong { font-size: var(--fs-sm); font-weight: 500; }
.rc-settings__option-copy small { color: var(--text-muted); font-size: var(--fs-xs); line-height: 1.4; }
.rc-settings__danger-check--on { color: var(--err); }
.rc-settings__danger-check input { width: 20px; height: 20px; accent-color: var(--err); }
/* The inline two-step confirm for enabling the danger default (window.confirm is unreliable in iOS
   standalone PWAs — it can silently return false, which made the toggle look dead). */
.rc-settings__danger-arm {
  display: flex; flex-direction: column; gap: var(--sp-2);
  padding: var(--sp-3); border-radius: var(--radius-sm);
  background: var(--err-soft); border: 1px solid var(--err-line);
}
.rc-settings__danger-arm-text { margin: 0; font-size: var(--fs-sm); color: var(--text); line-height: 1.45; }
.rc-settings__danger-arm-row { display: flex; gap: var(--sp-2); }
.rc-settings__danger-arm-yes {
  flex: none; padding: 8px 14px; border-radius: var(--radius-sm); cursor: pointer;
  background: var(--err); border: 1px solid var(--err); color: #fff; font-weight: 600; font-size: var(--fs-sm);
}
.rc-settings__danger-arm-no {
  flex: none; padding: 8px 14px; border-radius: var(--radius-sm); cursor: pointer;
  background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted); font-size: var(--fs-sm);
}
/* Full-width settings action row (used by device sign-out). */
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
.rc-settings__footnote { padding: 0 var(--sp-1); text-align: center; }
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
@media (max-width: 700px) {
  .rc-settings { padding: 0; place-items: stretch; }
  .rc-settings__card {
    width: 100%; height: 100dvh; max-height: none;
    border: 0; border-radius: 0;
  }
  .rc-settings__head {
    padding-top: calc(var(--sp-3) + env(safe-area-inset-top, 0px));
  }
  .rc-settings__subtitle { display: none; }
  .rc-settings__close {
    width: auto; min-width: var(--tap-min); padding: 0 var(--sp-3);
    display: inline-flex; align-items: center; gap: var(--sp-1);
    color: var(--text); background: var(--surface); border: 1px solid var(--border);
    font: 600 var(--fs-sm)/1 var(--font-display);
  }
  .rc-settings__close-label { display: inline; }
  .rc-settings__close-icon { display: none !important; }
  .rc-settings__layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .rc-settings__nav {
    overflow-x: auto; overflow-y: hidden; padding: var(--sp-2) var(--sp-3);
    border-right: 0; border-bottom: 1px solid var(--border);
  }
  .rc-settings__nav-label { display: none; }
  .rc-settings__nav-items { display: flex; width: max-content; gap: var(--sp-1); }
  .rc-settings__nav-item { width: auto; min-height: 38px; padding: 0 var(--sp-3); white-space: nowrap; }
  .rc-settings__nav-item--active::before {
    left: var(--sp-3); right: var(--sp-3); bottom: -9px; width: auto; height: 2px;
  }
  .rc-settings__body { padding: var(--sp-3); padding-bottom: calc(var(--sp-4) + env(safe-area-inset-bottom, 0px)); }
  .rc-settings__section { padding: var(--sp-3); }
}
@media (prefers-reduced-motion: reduce) {
  .rc-settings__usage-fill { transition: none; }
  .rc-settings__body { scroll-behavior: auto; }
}
`;
