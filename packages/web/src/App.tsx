import { useEffect, useMemo, useRef, useState } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { loadToken, saveToken, clearToken, consumeTokenFromUrl } from "./auth/token-store";
import { createApiClient, ApiError } from "./api/client";
import { API_BASE_URL } from "./config";
import { useStore } from "./store/store";
import { useShallow } from "zustand/react/shallow";
import { AppLayout } from "./AppLayout";
import { SessionList, awaitingCount } from "./session/SessionList";
import { sortSessionsByActivity } from "./session/order";
import { sessionIdFromLocation } from "./session/deep-link";
import { NewSessionWizard } from "./session/NewSessionWizard";
import { loadRecentDirs } from "./picker/recents";
import { ChatView } from "./chat/ChatView";
import { SettingsPanel } from "./settings/SettingsPanel";
import { loadDefaults, saveDefaults } from "./settings/defaults";
import { enablePush, disablePush, currentPushState } from "./pwa/push";
import { ConnectionBanner } from "./pwa/ConnectionBanner";
import { UpdateBanner } from "./pwa/UpdateBanner";
import { UpdatePanel } from "./update/UpdatePanel";
import { BUILD_SHA } from "./build-info";
import { claimAutoRefresh, hardRefresh, isClientStale } from "./update/stale-client";
import { useOnline } from "./pwa/online-status";
import { Icon } from "./ui/Icon";
import { MobileMenuButton } from "./ui/MobileMenuButton";
import type { UpdateStatus } from "./types/server";

type Phase = "login" | "validating" | "ready";

/**
 * After an OTA update the SERVER is on the new build, but THIS open page is still running the old
 * precached bundle: vite-plugin-pwa's autoUpdate service worker only re-checks for a new SW on a
 * navigation, never while the PWA stays open — so the update appeared to "not apply" until the user
 * fully closed and reopened. Force a check NOW: the new SW installs and (autoUpdate) takes control, and
 * main.tsx reloads the page on `controllerchange`. A delayed reload is a safety net if that never fires.
 * Gated on `navigator.serviceWorker` (absent in jsdom/dev), so it's inert in tests.
 */
let reloadScheduled = false;
function requestReloadForNewVersion(): void {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  // Guard: both the version poll AND the update-status poll can detect the new version, and each could
  // fire this — schedule the (uncancellable) fallback reload only ONCE.
  if (reloadScheduled) return;
  reloadScheduled = true;
  void navigator.serviceWorker.getRegistration().then((reg) => reg?.update());
  setTimeout(() => window.location.reload(), 10_000);
}

export function App() {
  // Prefer a `?token=` in the connect URL (the link the server prints): persist it + strip it from
  // the address bar, so opening the printed link authenticates directly instead of prompting. Falls
  // back to a previously stored token.
  const [token, setTokenState] = useState<string | undefined>(() => consumeTokenFromUrl() ?? loadToken());
  const [phase, setPhase] = useState<Phase>(token === undefined ? "login" : "validating");
  const [loginError, setLoginError] = useState<string | undefined>();
  // SCOPED selector (useShallow) over only the fields the shell needs — deliberately NOT `views`, which
  // changes on every streaming frame. With views excluded, an inbound delta re-renders only SessionList
  // (which subscribes to views itself), not this whole shell. Actions are stable; state fields are shallow-
  // compared, so the shell re-renders only when one it actually uses changes.
  const {
    sessions,
    setSessions,
    mergeSessionMeta,
    addSession,
    setToken,
    activeSessionId,
    setActive,
    removeSession,
    lastActiveAt,
    updateInfo,
    setUpdateInfo,
    updateState,
    setUpdateState,
    usage,
    setUsage,
  } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      setSessions: s.setSessions,
      mergeSessionMeta: s.mergeSessionMeta,
      addSession: s.addSession,
      setToken: s.setToken,
      activeSessionId: s.activeSessionId,
      setActive: s.setActive,
      removeSession: s.removeSession,
      lastActiveAt: s.lastActiveAt,
      updateInfo: s.updateInfo,
      setUpdateInfo: s.setUpdateInfo,
      updateState: s.updateState,
      setUpdateState: s.setUpdateState,
      usage: s.usage,
      setUsage: s.setUsage,
    })),
  );
  const [wizardOpen, setWizardOpen] = useState(false);
  // A small, dismissible error surfaced when a close actually FAILS (so we don't silently pretend a
  // session is gone). Cleared on the next close attempt or when the user dismisses it.
  const [closeError, setCloseError] = useState<string | undefined>();
  // Surfaced when the INITIAL session load fails for a non-auth reason (server down / wrong host /
  // network): without this the app silently dropped you into an empty list. Cleared on any successful
  // (re)load — the background poll keeps retrying.
  const [loadError, setLoadError] = useState<string | undefined>();
  // Consecutive background-poll failures — surfaces loadError only after the server is genuinely
  // unreachable (not a single blip), reset on the next success.
  const pollFailures = useRef(0);
  // GLOBAL settings (defaults for new sessions + notifications), reachable WITHOUT opening a chat — from
  // the rail header and the landing top bar. Rendered with no `session`, so it shows only the global
  // sections. Push state is read once (the opt-in itself is a deliberate tap).
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  // Read the saved defaults once PER OPEN (not on every render while the panel is up) — the panel only
  // seeds its draft from the first value anyway.
  const globalDefaults = useMemo(() => loadDefaults(), [globalSettingsOpen]);
  const [pushState, setPushState] = useState<"subscribed" | "unsubscribed" | "unsupported" | "denied">("unsubscribed");
  // Read the live push subscription state only when the global settings actually open (not on every app
  // mount): it's the only place that needs it, and deferring avoids an on-load async state update.
  useEffect(() => {
    if (!globalSettingsOpen) return;
    let mounted = true;
    currentPushState()
      .then((s) => mounted && setPushState(s))
      .catch(() => mounted && setPushState("unsupported"));
    return () => {
      mounted = false;
    };
  }, [globalSettingsOpen]);
  // Which segment the wizard's New/Resume toggle opens on. The normal +/New affordances open "new"
  // (the directory picker); the in-chat `/resume` slash command opens straight to "resume".
  const [wizardMode, setWizardMode] = useState<"new" | "resume">("new");
  const [sessionsOpen, setSessionsOpen] = useState(false);
  // OTA self-update UI state. The banner is dismissible PER SESSION (a page reload re-shows it if the
  // update is still pending). The panel is the "What's new" / confirm sheet. `updateStatus` is the
  // server-reported updater progress polled while updating. `updatedTo` drives the "Updated to …"
  // toast after a successful reconnect onto the new version.
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [updatePanelOpen, setUpdatePanelOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | undefined>();
  const [updatedTo, setUpdatedTo] = useState<string | undefined>();
  // TRUE when THIS bundle (BUILD_SHA) is older than the server is serving — a stale precached PWA. The
  // server-driven update banner can't catch this (it compares server git, not the loaded bundle), so this
  // is the only thing that surfaces a phone stuck on old JS. Set in the version poll; cleared by a refresh.
  const [clientStale, setClientStale] = useState(false);

  // Open the new-session wizard on a chosen tab. The default `+`/"New session" affordances open the
  // directory picker; `/resume` from the chat composer opens the resume picker.
  const openWizard = (mode: "new" | "resume" = "new") => {
    setWizardMode(mode);
    setWizardOpen(true);
  };
  // A client-action slash command was picked in the composer. Only `/resume` is handled today (opens
  // the wizard on its resume tab); any other client-action name is a no-op for now.
  const onSlashCommand = (name: string) => {
    if (name === "/resume") openWizard("resume");
  };
  const online = useOnline();

  // The rail's relative-time labels ("2m", "1h") need a clock. The component stays pure (no
  // Date.now() inside it); the app owns the tick and re-renders the labels every 30s so "now"
  // creeps to "1m" without a reload. Cheap: one timer, one state value.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const api = useMemo(
    () => createApiClient({ baseUrl: API_BASE_URL, getToken: () => (token === "" ? undefined : token) }),
    [token],
  );

  useEffect(() => {
    if (token === undefined) return;
    setToken(token);
    let cancelled = false;
    setPhase("validating");
    api
      .listSessions()
      .then((s) => {
        if (cancelled) return;
        setSessions(s);
        setLoadError(undefined);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          setTokenState(undefined);
          setLoginError("Invalid token (401). Check the access token and try again.");
          setPhase("login");
        } else {
          // network/other error: still enter the app (the list is empty), but SURFACE it so the user
          // knows it's a connection problem, not just "no sessions". The poll keeps retrying + clears it.
          setLoadError("Couldn't reach the server. Retrying…");
          setPhase("ready");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, api, setSessions, setToken]);

  // Notification deep-link: a tapped push opens `/?session=<id>` (the SW's notificationclick). Once
  // the app is ready (session list loaded + authenticated), select that session so the tap lands on
  // it. An unknown/garbage id falls through to the normal "Session not found" fallback (no crash).
  // Clear the query param afterward so a refresh doesn't re-trigger the deep link.
  useEffect(() => {
    if (phase !== "ready") return;
    const id = sessionIdFromLocation(window.location.search);
    if (id) {
      setActive(id);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [phase, setActive]);

  // Keep the rail honest across ALL sessions — not just the one we're connected to. A lightweight poll
  // of GET /sessions every ~15s (and on window focus + when the connection comes back online, e.g. a WS
  // reconnect after sleep) refreshes status, `awaiting` and `lastActivityAt` for every session, and
  // drops any that no longer exist. It merges META ONLY (mergeSessionMeta keeps the live `views`
  // intact), so the actively-connected conversation is never disturbed. A poll that errors is ignored
  // (transient) so a blip doesn't wipe the list.
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    const refresh = () => {
      api
        .listSessions()
        .then((s) => {
          if (cancelled) return;
          pollFailures.current = 0;
          mergeSessionMeta(s);
          setLoadError(undefined); // a successful poll clears any earlier "couldn't reach the server"
        })
        .catch(() => {
          // Keep the current list (a single blip is transient), but after a couple of CONSECUTIVE poll
          // failures the server is genuinely unreachable — surface it so the user knows the list is stale
          // (the cold-start banner only covered the first load). Cleared on the next success.
          if (cancelled) return;
          if (++pollFailures.current >= 2) setLoadError("Couldn't reach the server — the list may be stale.");
        });
    };
    const interval = setInterval(refresh, 15_000);
    const onFocusOrOnline = () => refresh();
    window.addEventListener("focus", onFocusOrOnline);
    window.addEventListener("online", onFocusOrOnline);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocusOrOnline);
      window.removeEventListener("online", onFocusOrOnline);
    };
  }, [phase, api, mergeSessionMeta]);

  // OTA self-update: poll GET /version on open and every ~15min. The server caches the underlying git
  // check (≤10min), so this is cheap. A failed poll is ignored (transient / offline / non-updatable);
  // the store keeps the last known info. When a poll comes back with a NEW current version while we
  // were updating, that means the server restarted onto the new build — finish the update UX.
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    const poll = () => {
      api
        .getVersion()
        .then((info) => {
          if (cancelled) return;
          // Detect "the server is now on a new version" while/after an update: the polled `current`
          // differs from the version we were updating FROM (read straight from the store so this is
          // current even though the effect isn't re-run on every state change). Clear the updating UX
          // + show the "Updated to …" toast.
          const { updateState: phaseNow, updateInfo: prevInfo } = useStore.getState();
          if (phaseNow === "updating" && prevInfo && info.current !== prevInfo.current) {
            setUpdatedTo(info.current);
            setUpdatePanelOpen(false);
            setUpdateBannerDismissed(false);
            setUpdateState("idle");
            requestReloadForNewVersion();
          }
          setUpdateInfo(info);
          // Stale-bundle self-heal: if THIS running bundle is older than what the server now serves (the
          // OTA built+restarted but the phone's precached PWA never swapped), drop the SW/caches and reload
          // onto the new bundle — ONCE per server version (claimAutoRefresh guards against a reload loop).
          // If we already tried for this version and it's STILL stale, surface a manual "Refresh" banner.
          if (isClientStale(BUILD_SHA, info.current)) {
            const auto = typeof sessionStorage !== "undefined" && claimAutoRefresh(info.current, sessionStorage);
            if (auto) void hardRefresh();
            else setClientStale(true);
          } else {
            setClientStale(false);
          }
        })
        .catch(() => {
          // transient/offline/non-updatable — keep the last known info.
        });
    };
    poll();
    // ~3 min (plus an on-focus re-check) so a freshly pushed update surfaces promptly. The server
    // caches the underlying git fetch (~2 min), so this stays cheap.
    const interval = setInterval(poll, 3 * 60 * 1000);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [phase, api, setUpdateInfo, setUpdateState, setClientStale]);

  // Claude usage bars: poll GET /usage on open and every ~60s (plus on window focus). The server
  // TTL-caches the underlying `claude /usage` spawn, so this poll is cheap. A failed poll is ignored
  // (transient / offline / feature unavailable) — the store keeps the last value, and a null result
  // simply hides the bars.
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    const poll = () => {
      api
        .getUsage()
        .then((u) => {
          // Only update on a REAL snapshot. The server returns `usage:null` when its `claude /usage`
          // spawn fails — which happens on a transiently loaded host — and clobbering the last-known
          // value with null made the session/weekly bars VANISH on a single slow poll. Keep the last
          // good value instead; a later good poll refreshes it (and they refresh every ~60s anyway).
          if (!cancelled && u) setUsage(u);
        })
        .catch(() => {
          // transient — keep the last value.
        });
    };
    poll();
    const interval = setInterval(poll, 60_000);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [phase, api, setUsage]);

  // While an update is in flight, poll GET /update/status (~every 2s) so the panel shows the live phase
  // (pulling → building → restarting). On a `failed` status, flip to the failed UX. Each tick ALSO
  // re-checks GET /version: when the server restarts onto the new build, `current` changes and we end
  // the "updating" state + show the toast (the 15-min version poll would be too slow to catch this).
  useEffect(() => {
    if (phase !== "ready" || updateState !== "updating") return;
    let cancelled = false;
    const poll = () => {
      api
        .getUpdateStatus()
        .then((status) => {
          if (cancelled) return;
          setUpdateStatus(status);
          if (status.state === "failed") setUpdateState("failed");
        })
        .catch(() => {
          // The server is likely mid-restart (the request fails) — that's expected; keep polling.
        });
      api
        .getVersion()
        .then((info) => {
          if (cancelled) return;
          const { updateState: phaseNow, updateInfo: prevInfo } = useStore.getState();
          if (phaseNow === "updating" && prevInfo && info.current !== prevInfo.current) {
            setUpdatedTo(info.current);
            setUpdatePanelOpen(false);
            setUpdateBannerDismissed(false);
            setUpdateState("idle");
            requestReloadForNewVersion();
          }
          setUpdateInfo(info);
        })
        .catch(() => {
          // mid-restart — keep polling.
        });
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase, updateState, api, setUpdateState, setUpdateInfo]);

  // Apply the update: POST /update, flip to the updating UX, and open the panel so the progress overlay
  // is visible. A failed POST (e.g. the server isn't a git checkout) flips to the failed UX.
  const applyUpdate = () => {
    setUpdateState("updating");
    setUpdatePanelOpen(true);
    setUpdateStatus({ state: "starting", phase: "starting" });
    void api.applyUpdate().catch((err: unknown) => {
      setUpdateState("failed");
      setUpdateStatus({
        state: "failed",
        // An ApiError carries the server's own reason (e.g. "not a git checkout"). A non-ApiError means the
        // POST never got a clean response — a network/connection drop (the server was unreachable or it
        // restarted mid-request), NOT a server rejection. Say so + surface the underlying reason so the
        // failure is diagnosable instead of a flat "Couldn't start the update."
        error:
          err instanceof ApiError
            ? err.message
            : `Couldn't reach the server to start the update${
                err instanceof Error && err.message ? ` (${err.message})` : ""
              }. If it was already updating it should reconnect shortly — otherwise check the connection and Retry.`,
      });
    });
  };

  if (phase === "login" || token === undefined) {
    return (
      <LoginScreen
        initialError={loginError}
        onAuthenticated={(t) => {
          saveToken(t);
          setLoginError(undefined);
          setTokenState(t);
        }}
      />
    );
  }

  if (phase === "validating") {
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          gap: "var(--sp-3)",
          height: "100%",
          color: "var(--text-muted)",
        }}
      >
        <span aria-hidden="true" className="display" style={{ fontSize: "var(--fs-2xl)", color: "var(--text-faint)" }}>
          rc
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)" }}>Connecting…</span>
      </div>
    );
  }

  // Close a session in one tap: DELETE /sessions/:id → 204 (no body). The server removes it from the
  // list + store while KEEPING the transcript (still resumable via /resume), so a closed session does
  // NOT reappear after refresh. We optimistically remove it client-side for a snappy rail; if the
  // active one is closed we reselect the new top (most-recently-active) row, else the empty/landing
  // state. On a REAL failure (5xx/network — not an already-gone 204, which resolves) we re-add the row
  // and surface a small error rather than silently dropping it.
  const closeSession = (id: string) => {
    const closing = sessions.find((s) => s.id === id);
    const wasActive = id === activeSessionId;
    // Optimistic removal + reselection.
    let autoSelected: string | undefined;
    if (wasActive) {
      const remaining = sortSessionsByActivity(
        sessions.filter((s) => s.id !== id),
        lastActiveAt,
      );
      autoSelected = remaining[0]?.id;
      setActive(autoSelected);
    }
    removeSession(id);
    setCloseError(undefined);
    void api.deleteSession(id).catch((err: unknown) => {
      // The delete genuinely failed — undo the optimistic removal so the row reappears, and tell the
      // user. (An already-gone session is a 204 server-side, so it never lands here.)
      if (closing) {
        addSession(closing);
        // Restore selection to the closed row ONLY if the user hasn't navigated since (the active is
        // still the one we auto-selected) — don't yank them back from a row they deliberately opened.
        if (wasActive && useStore.getState().activeSessionId === autoSelected) setActive(id);
      }
      const message = err instanceof ApiError ? err.message : "Couldn't close the session.";
      setCloseError(message);
    });
  };

  const list = (
    <SessionList
      sessions={sessions}
      activeId={activeSessionId}
      lastActiveAt={lastActiveAt}
      now={now}
      usage={usage}
      version={updateInfo?.current}
      updateAvailable={updateInfo?.updateAvailable}
      onShowUpdate={() => setUpdatePanelOpen(true)}
      onCheckUpdate={async () => {
        // Force a fresh server-side git check (bypass the cached one) so the user never waits on the poll.
        const info = await api.getVersion(true);
        setUpdateInfo(info);
        return Boolean(info.updateAvailable);
      }}
      onOpenSettings={() => {
        setGlobalSettingsOpen(true);
        setSessionsOpen(false);
      }}
      onSelect={(id) => {
        setActive(id);
        setSessionsOpen(false);
      }}
      onNew={() => openWizard("new")}
      onClose={closeSession}
      // viewWireState is intentionally NOT passed: SessionList subscribes to `views` itself and derives
      // each row's wire state, so a streaming frame re-renders only the rail — not this whole App shell.
    />
  );

  return (
    <>
      <ConnectionBanner online={online} />
      {/* Couldn't reach the server (a non-auth failure) while online — the offline banner covers the
          offline case. Auto-clears on the next successful poll; tappable to dismiss meanwhile. */}
      {loadError && online && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            // Topmost element → clear the status bar / notch itself (the fill still extends behind it).
            padding: "calc(var(--sp-2) + env(safe-area-inset-top, 0px)) var(--sp-3) var(--sp-2)",
            background: "var(--surface-2)",
            color: "var(--warn)",
            borderBottom: "1px solid var(--border)",
            fontSize: "var(--fs-sm)",
          }}
        >
          <Icon name="alert" size={15} />
          <span style={{ flex: 1, minWidth: 0 }}>{loadError}</span>
          <button
            type="button"
            onClick={() => setLoadError(undefined)}
            aria-label="Dismiss"
            style={{
              flex: "none",
              display: "grid",
              placeItems: "center",
              width: "var(--tap-min)",
              height: "var(--tap-min)",
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
      {/* This running bundle is OLDER than the deployed server (a stale precached PWA the auto-refresh
          couldn't swap). Not dismissible — tapping Refresh hard-resets (drops SW + caches) so the phone
          finally loads the current code. Takes precedence over the server-driven "update available" banner. */}
      {clientStale ? (
        <div role="status" className="rc-stale-banner">
          <Icon name="alert" size={15} />
          <span style={{ flex: 1, minWidth: 0 }}>This app is running an old version.</span>
          <button type="button" onClick={() => void hardRefresh()} className="rc-stale-refresh">
            Refresh
          </button>
          <style>{`
            .rc-stale-banner {
              display: flex; align-items: center; gap: var(--sp-2);
              padding: calc(var(--sp-2) + env(safe-area-inset-top, 0px)) var(--sp-3) var(--sp-2);
              background: var(--surface-2); color: var(--warn);
              border-bottom: 1px solid var(--border); font-size: var(--fs-sm);
            }
            .rc-stale-refresh {
              flex: none; padding: var(--sp-1) var(--sp-3);
              background: var(--coral); color: #fff; border: none;
              border-radius: var(--radius-sm); font-weight: 600; cursor: pointer;
              min-height: var(--tap-min);
            }
          `}</style>
        </div>
      ) : (
        updateInfo &&
        !updateBannerDismissed &&
        updateState !== "updating" && (
          <UpdateBanner
            info={updateInfo}
            onWhatsNew={() => setUpdatePanelOpen(true)}
            onUpdate={() => setUpdatePanelOpen(true)}
            onDismiss={() => setUpdateBannerDismissed(true)}
          />
        )
      )}
      {updatedTo && (
        <div role="status" className="rc-updated-toast">
          <Icon name="check" size={15} style={{ color: "var(--coral)" }} />
          <span>
            Updated to <span style={{ fontFamily: "var(--font-mono)" }}>{updatedTo}</span>
          </span>
          <button type="button" onClick={() => setUpdatedTo(undefined)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
          <style>{`
            .rc-updated-toast {
              position: fixed; left: 50%; transform: translateX(-50%);
              top: calc(env(safe-area-inset-top, 0px) + var(--sp-4));
              z-index: 60; max-width: min(92vw, 420px);
              display: inline-flex; align-items: center; gap: var(--sp-3);
              padding: var(--sp-2) var(--sp-3);
              background: var(--surface-2); color: var(--text);
              border: 1px solid var(--accent-line); border-radius: var(--radius);
              box-shadow: var(--shadow); font-size: var(--fs-sm);
            }
            .rc-updated-toast button {
              flex: none; display: grid; place-items: center;
              width: var(--tap-min); height: var(--tap-min); border-radius: var(--radius-sm);
              background: transparent; border: none; color: var(--text-muted); cursor: pointer;
            }
            .rc-updated-toast button:hover { color: var(--text); background: var(--surface); }
          `}</style>
        </div>
      )}
      {closeError && (
        <div role="alert" className="rc-close-err">
          <span>{closeError}</span>
          <button type="button" onClick={() => setCloseError(undefined)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
          <style>{`
            .rc-close-err {
              position: fixed; left: 50%; transform: translateX(-50%);
              bottom: calc(env(safe-area-inset-bottom, 0px) + var(--sp-4));
              z-index: 60; max-width: min(92vw, 420px);
              display: inline-flex; align-items: center; gap: var(--sp-3);
              padding: var(--sp-2) var(--sp-3);
              background: var(--surface-2); color: var(--text);
              border: 1px solid var(--err-border); border-radius: var(--radius);
              box-shadow: var(--shadow); font-size: var(--fs-sm);
            }
            .rc-close-err button {
              flex: none; display: grid; place-items: center;
              width: var(--tap-min); height: var(--tap-min); border-radius: var(--radius-sm);
              background: transparent; border: none; color: var(--text-muted); cursor: pointer;
            }
            .rc-close-err button:hover { color: var(--text); background: var(--surface); }
          `}</style>
        </div>
      )}
      <AppLayout
        sessionList={list}
        sessionsOpen={sessionsOpen}
        conversationActive={activeSessionId !== undefined}
        onHideSessions={() => setSessionsOpen(false)}
      >
        {activeSessionId ? (
          (() => {
            const active = sessions.find((s) => s.id === activeSessionId);
            return active ? (
              // Key by the active session id so switching sessions remounts ChatView with fresh
              // per-instance state. Critically, the client-side auto-allow rules and the answered
              // set live in ChatView's component state; a stable element position would reuse the
              // same instance across sessions and leak an "Always allow <tool>" rule from one
              // session into another — a cross-session bypass of the permission gate.
              <ChatView
                key={active.id}
                session={active}
                api={api}
                token={token}
                onSlashCommand={onSlashCommand}
                onClose={closeSession}
                onShowSessions={() => setSessionsOpen(true)}
                needsYou={awaitingCount(sessions)}
              />
            ) : (
              // No matching session (e.g. a stale deep-link id). There's no ChatHeader here, so keep
              // the sessions sheet reachable on mobile via the same top-left, in-flow menu button.
              <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                <div
                  style={{
                    display: "flex",
                    padding: "calc(var(--sp-3) + env(safe-area-inset-top, 0px)) var(--sp-4) var(--sp-3)",
                    flex: "none",
                  }}
                >
                  <MobileMenuButton onShowSessions={() => setSessionsOpen(true)} needsYou={awaitingCount(sessions)} />
                </div>
                <div
                  style={{ display: "grid", placeItems: "center", flex: 1, minHeight: 0, color: "var(--text-muted)" }}
                >
                  Session not found.
                </div>
              </div>
            );
          })()
        ) : (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            {/* On the landing/empty state there's no ChatHeader, so the sessions sheet still needs a
                trigger on mobile. A slim, in-flow top-left affordance carries the SAME menu button
                (with the needs-you pip) so sessions are always reachable. Desktop: the button hides
                itself (rail always visible), leaving just the empty bar. */}
            <div
              style={{
                display: "flex",
                padding: "calc(var(--sp-3) + env(safe-area-inset-top, 0px)) var(--sp-4) var(--sp-3)",
                flex: "none",
              }}
            >
              <MobileMenuButton onShowSessions={() => setSessionsOpen(true)} needsYou={awaitingCount(sessions)} />
            </div>
            <div
              style={{
                display: "grid",
                placeItems: "center",
                gap: "var(--sp-4)",
                flex: 1,
                minHeight: 0,
                color: "var(--text-muted)",
                padding: "var(--sp-5)",
                textAlign: "center",
              }}
            >
              {/* The landing mark — a flat elevated tile + a --line-2 edge; the ONE coral here is the
                  GLYPH (spec .mark), NOT a coral fill. No glow. */}
              <span
                aria-hidden="true"
                style={{
                  width: 56,
                  height: 56,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "var(--radius)",
                  background: "var(--tile-bg)",
                  border: "1px solid var(--tile-edge)",
                  color: "var(--coral)",
                }}
              >
                <Icon name="terminal" size={26} />
              </span>
              <span className="display" style={{ fontSize: "var(--fs-lg)", color: "var(--text)" }}>
                Select or start a session
              </span>
              <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", maxWidth: "26ch", lineHeight: 1.5 }}>
                No active session. Tap{" "}
                <span aria-hidden="true" style={{ color: "var(--text)", fontWeight: 600 }}>
                  +
                </span>{" "}
                to start one and drive Claude from your phone.
              </span>
              {/* A landing-state CTA so a new session is reachable without first opening the mobile
                sessions sheet (the rail's "New session" is hidden until the sheet is open on mobile).
                The single coral primary — a FLAT coral fill, dark ink label. No glow. */}
              <button
                type="button"
                onClick={() => openWizard("new")}
                aria-label="New session"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--sp-2)",
                  minHeight: "var(--tap-min)",
                  padding: "0 var(--sp-5)",
                  background: "var(--accent-grad)",
                  color: "var(--on-accent)",
                  border: "none",
                  borderRadius: "999px",
                  cursor: "pointer",
                  fontFamily: "var(--font-display)",
                  fontWeight: 600,
                }}
              >
                <Icon name="plus" size={16} />
                New session
              </button>
            </div>
          </div>
        )}
      </AppLayout>
      {wizardOpen && (
        <NewSessionWizard
          api={api}
          recents={loadRecentDirs()}
          now={now}
          initialMode={wizardMode}
          onClose={() => setWizardOpen(false)}
          onCreated={(session) => {
            // addSession is idempotent (no-op if the id already exists) and an immutable store update, so
            // it can't clobber a concurrent mergeSessionMeta poll the way a render-closure setSessions could.
            addSession(session);
            setActive(session.id);
            setWizardOpen(false);
            setSessionsOpen(false);
          }}
        />
      )}
      {globalSettingsOpen && (
        <SettingsPanel
          defaults={globalDefaults}
          onSaveDefaults={saveDefaults}
          pushState={pushState}
          onEnablePush={async () => {
            try {
              const result = await enablePush(api);
              // enablePush returns subscribed | denied | unsupported — surface "denied" so the panel can
              // explain it (re-tapping Enable silently no-ops once the browser has denied permission).
              setPushState(result);
            } catch {
              setPushState("unsubscribed");
            }
          }}
          onDisablePush={async () => {
            try {
              await disablePush(api);
            } finally {
              setPushState("unsubscribed");
            }
          }}
          onClose={() => setGlobalSettingsOpen(false)}
        />
      )}
      {updatePanelOpen && updateInfo && (
        <UpdatePanel
          info={updateInfo}
          state={updateState}
          status={updateStatus}
          onUpdate={applyUpdate}
          onClose={() => setUpdatePanelOpen(false)}
        />
      )}
    </>
  );
}
