import { useEffect, useRef, useState } from "react";
import { Mono } from "../ui/Mono";
import { Icon, type IconName } from "../ui/Icon";
import { InlineConfirm } from "../ui/InlineConfirm";
import { useFocusTrap } from "../ui/useFocusTrap";
import type { SessionMeta, UsageInfo } from "../types/server";
import type { ApiClient } from "../api/client";
import { ProviderAccounts } from "./ProviderAccounts";
import { DeviceAccess } from "./DeviceAccess";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { TeamAccess } from "./TeamAccess";
import { OrganizationControls } from "./OrganizationControls";
import { shortenReset, usageFillColor } from "../session/UsageBars";
import { loadTheme, setTheme, type ThemeName } from "../pwa/theme";
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

/** Starting a fresh session from Settings carries only the folder; the wizard owns all launch choices. */
export interface NewSessionHereOptions {
  cwd: string;
}

export interface SettingsPanelProps {
  session?: SessionMeta;
  sessionOrder?: SessionOrder;
  onSessionOrderChange?: (order: SessionOrder) => void;
  /** When provided, renders independent Claude Code and Codex account controls. */
  api?: ApiClient;
  onStopSession?: (id: string) => void;
  /** Opens the new-session wizard in the current folder; launch choices stay owned by that wizard. */
  onNewSessionHere?: (opts: NewSessionHereOptions) => void;
  /** Latest usage snapshot (GET /usage). Omit to let the panel fetch it itself via `api`; pass `null`
   * to force it hidden (tests/screenshots). Drives the near-limit warning + the Sonnet weekly bar. */
  usage?: UsageInfo | null;
  /** Push opt-in handlers. When omitted, the Notifications section is hidden (e.g. in tests/screenshots). */
  pushState?: "subscribed" | "unsubscribed" | "unsupported" | "denied";
  onEnablePush?: () => void;
  onDisablePush?: () => void;
  /** Swap a legacy shared host credential for a per-device key without leaving Settings. */
  onDeviceTokenChanged?: (token: string) => void;
  /** Sign out of roamcode itself (CONTRACT C2): the App wires this to clear the stored access token and
   * return to the login screen. When omitted, the "Sign out" row is hidden. */
  onSignOut?: () => void;
  onClose: () => void;
}

/** Warn once a usage bar crosses this fraction of its limit. */
const USAGE_WARN_AT = 90;

type SettingsSectionId =
  "session" | "appearance" | "accounts" | "extensions" | "team" | "organization" | "device" | "notifications";

interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  icon: IconName;
}

export function SettingsPanel({
  session,
  sessionOrder = "created",
  onSessionOrderChange,
  api,
  onStopSession,
  onNewSessionHere,
  usage,
  pushState,
  onEnablePush,
  onDisablePush,
  onDeviceTokenChanged,
  onSignOut,
  onClose,
}: SettingsPanelProps) {
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
  const requestedSectionRef = useRef<{ id: SettingsSectionId; reached: boolean } | undefined>(undefined);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(session ? "session" : "appearance");
  const [confirmation, setConfirmation] = useState<"stop-session" | "sign-out">();

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

  // Route through the active host client. This is essential in a multi-host command center: neither the
  // origin nor its credential may fall back to the PWA's own host while another host is selected.
  async function sendTestNotification() {
    setTestState("sending");
    setTestError(undefined);
    try {
      if (!api) throw new Error("host API unavailable");
      await api.sendPushTest();
      setTestState("ok");
    } catch (error: unknown) {
      setTestError(error instanceof Error ? error.message : "network error");
      setTestState("error");
    }
  }

  const navigation: SettingsNavItem[] = [
    ...(session ? [{ id: "session", label: "Current session", icon: "sliders" } as const] : []),
    { id: "appearance", label: "Appearance", icon: "settings" },
    ...(api ? [{ id: "accounts", label: "Provider accounts", icon: "terminal" } as const] : []),
    ...(api ? [{ id: "extensions", label: "Extensions", icon: "bolt" } as const] : []),
    ...(api ? [{ id: "team", label: "Team & roles", icon: "agent" } as const] : []),
    ...(api ? [{ id: "organization", label: "Policy & fleet", icon: "lock" } as const] : []),
    ...(onSignOut ? [{ id: "device", label: "Devices", icon: "lock" } as const] : []),
    ...(pushState ? [{ id: "notifications", label: "Notifications", icon: "bell" } as const] : []),
  ];

  function scrollToSection(id: SettingsSectionId) {
    requestedSectionRef.current = { id, reached: false };
    setActiveSection(id);
    contentRef.current?.querySelector<HTMLElement>(`#settings-${id}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  function updateActiveSection() {
    const content = contentRef.current;
    if (!content) return;
    const requested = requestedSectionRef.current;
    if (requested) {
      const target = content.querySelector<HTMLElement>(`#settings-${requested.id}`);
      if (target) {
        const contentBounds = content.getBoundingClientRect();
        const targetBounds = target.getBoundingClientRect();
        const visible = targetBounds.bottom > contentBounds.top + 24 && targetBounds.top < contentBounds.bottom - 24;
        if (visible) {
          requested.reached = true;
          setActiveSection(requested.id);
          return;
        }
        if (!requested.reached) return;
      }
      requestedSectionRef.current = undefined;
    }
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
                      different choices; this session stays open.
                    </p>
                    {/* Carry only the cwd. The wizard is seeded from the server's last successful launch. */}
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
                    aria-expanded={confirmation === "stop-session"}
                    onClick={() => setConfirmation("stop-session")}
                    aria-label="Close session"
                  >
                    <Icon name="power" size={16} />
                    Close session
                  </button>
                )}
                {onStopSession && confirmation === "stop-session" && (
                  <InlineConfirm
                    message="Close this session? It's removed from the list and its agent process is terminated. The transcript stays on disk — you can resume it later."
                    confirmLabel="Close session now"
                    onCancel={() => setConfirmation(undefined)}
                    onConfirm={() => {
                      setConfirmation(undefined);
                      onStopSession(session.id);
                    }}
                  />
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
              {/* Theme: applies INSTANTLY (no save button) — a client-side preference persisted in this
                browser's localStorage, like session names. OLED = pure #000 (pixels off on OLED panels);
                Light = paper surfaces for bright daylight. */}
              <label className="rc-settings__field">
                <span className="rc-settings__field-label">Theme</span>
                <select
                  className="rc-settings__control"
                  aria-label="Theme"
                  value={theme}
                  onChange={(e) => {
                    const next = e.target.value as ThemeName;
                    setThemeState(next);
                    setTheme(next);
                  }}
                >
                  <option value="dark">Dark</option>
                  <option value="oled">True black (OLED)</option>
                  <option value="light">Light</option>
                </select>
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

            {api && (
              <section
                id="settings-extensions"
                className="rc-settings__section rc-settings__section--divided"
                aria-labelledby="settings-extensions-title"
              >
                <div className="rc-settings__section-head">
                  <span className="rc-settings__section-icon" aria-hidden="true">
                    <Icon name="bolt" size={15} />
                  </span>
                  <span>
                    <span id="settings-extensions-title" className="rc-settings__section-label">
                      Extensions
                    </span>
                    <span className="rc-settings__section-description">
                      Verified adapters and permissioned local plugins
                    </span>
                  </span>
                </div>
                <ExtensionsPanel api={api} />
              </section>
            )}

            {api && (
              <section
                id="settings-team"
                className="rc-settings__section rc-settings__section--divided"
                aria-labelledby="settings-team-title"
              >
                <div className="rc-settings__section-head">
                  <span className="rc-settings__section-icon" aria-hidden="true">
                    <Icon name="agent" size={15} />
                  </span>
                  <span>
                    <span id="settings-team-title" className="rc-settings__section-label">
                      Team & roles
                    </span>
                    <span className="rc-settings__section-description">
                      Shared membership, agent control and device identity
                    </span>
                  </span>
                </div>
                <TeamAccess api={api} />
              </section>
            )}

            {api && (
              <section
                id="settings-organization"
                className="rc-settings__section rc-settings__section--divided"
                aria-labelledby="settings-organization-title"
              >
                <div className="rc-settings__section-head">
                  <span className="rc-settings__section-icon" aria-hidden="true">
                    <Icon name="lock" size={15} />
                  </span>
                  <span>
                    <span id="settings-organization-title" className="rc-settings__section-label">
                      Policy & fleet
                    </span>
                    <span className="rc-settings__section-description">
                      Organization guardrails, host compliance and audit integrity
                    </span>
                  </span>
                </div>
                <OrganizationControls api={api} />
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
                      Devices
                    </span>
                    <span className="rc-settings__section-description">Paired browsers, revocation and sign-out</span>
                  </span>
                </div>
                {api && <DeviceAccess api={api} onTokenChanged={onDeviceTokenChanged} onUnpaired={onSignOut} />}
                {/* Sign out of roamcode itself (CONTRACT C2): the App clears the stored access token and
                  returns to the login screen. Confirm-gated — you need the connect link/token to sign back in. */}
                <button
                  type="button"
                  className="rc-settings__authrow"
                  aria-label="Sign out"
                  aria-expanded={confirmation === "sign-out"}
                  onClick={() => setConfirmation("sign-out")}
                >
                  <span className="rc-settings__authrow-main">
                    <span className="rc-settings__authrow-title">Sign out</span>
                    <span className="rc-settings__authrow-sub">
                      Clear the access token on this device and return to login.
                    </span>
                  </span>
                  <Icon name="power" size={16} />
                </button>
                {confirmation === "sign-out" && (
                  <InlineConfirm
                    message="Sign out of RoamCode on this device? You'll need the access link or token to sign back in."
                    confirmLabel="Sign out now"
                    onCancel={() => setConfirmation(undefined)}
                    onConfirm={onSignOut}
                  />
                )}
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

            <p className="rc-settings__note rc-settings__footnote">
              Paired devices keep only their own revocable key in this browser.
            </p>
          </div>
        </div>
      </section>

      <style>{settingsCss}</style>
    </div>
  );
}

/**
 * Compact usage readout for the panel: renders every available bar (incl. provider-named weekly bars,
 * which the rail's UsageBars omits) and — the point — surfaces a prominent warning the moment any bar
 * crosses {@link USAGE_WARN_AT}%, so a near-limit isn't a surprise. Reuses UsageBars' color + reset
 * helpers so it reads identically to the rail.
 */
function UsageSummary({ usage }: { usage: UsageInfo }) {
  const bars: { label: string; bar: UsageInfo["session"] }[] = [
    { label: "Session (5h)", bar: usage.session },
    { label: "Weekly", bar: usage.week },
    ...(usage.weekModels?.map((bar) => ({ label: `Weekly · ${bar.model}`, bar })) ??
      (usage.weekSonnet ? [{ label: "Weekly · Sonnet", bar: usage.weekSonnet }] : [])),
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
                {b.label} ~{pctOf(b.bar.percent)}% used
                {b.bar.resets ? `, resets ${shortenReset(b.bar.resets)}` : ""}
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
              {bar.resets && <span className="rc-settings__usage-reset">resets {shortenReset(bar.resets)}</span>}
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
/* The settings card — a clean floating-glass dialog (subtle fill + blur + a --line-2 border). */
.rc-settings__card {
  width: min(94vw, 860px);
  /* Cap the card to the viewport and make it a flex column so the BODY scrolls, not the page. */
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
  .rc-settings__nav-item { width: auto; min-height: var(--tap-min); padding: 0 var(--sp-3); white-space: nowrap; }
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
