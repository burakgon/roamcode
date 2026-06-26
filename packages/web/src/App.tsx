import { useEffect, useMemo, useState } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { loadToken, saveToken, clearToken, consumeTokenFromUrl } from "./auth/token-store";
import { createApiClient, ApiError } from "./api/client";
import { API_BASE_URL } from "./config";
import { useStore } from "./store/store";
import { AppLayout } from "./AppLayout";
import { SessionList, awaitingCount } from "./session/SessionList";
import { wireStateForSession } from "./session/status";
import { sortSessionsByActivity } from "./session/order";
import { sessionIdFromLocation } from "./session/deep-link";
import { NewSessionWizard } from "./session/NewSessionWizard";
import { loadRecentDirs } from "./picker/recents";
import { ChatView } from "./chat/ChatView";
import { ConnectionBanner } from "./pwa/ConnectionBanner";
import { UpdateBanner } from "./pwa/UpdateBanner";
import { UpdatePanel } from "./update/UpdatePanel";
import { useOnline } from "./pwa/online-status";
import { Icon } from "./ui/Icon";
import { MobileMenuButton } from "./ui/MobileMenuButton";
import type { UpdateStatus } from "./types/server";

type Phase = "login" | "validating" | "ready";

export function App() {
  // Prefer a `?token=` in the connect URL (the link the server prints): persist it + strip it from
  // the address bar, so opening the printed link authenticates directly instead of prompting. Falls
  // back to a previously stored token.
  const [token, setTokenState] = useState<string | undefined>(() => consumeTokenFromUrl() ?? loadToken());
  const [phase, setPhase] = useState<Phase>(token === undefined ? "login" : "validating");
  const [loginError, setLoginError] = useState<string | undefined>();
  const {
    sessions,
    setSessions,
    mergeSessionMeta,
    addSession,
    setToken,
    activeSessionId,
    setActive,
    removeSession,
    views,
    lastActiveAt,
    updateInfo,
    setUpdateInfo,
    updateState,
    setUpdateState,
    usage,
    setUsage,
  } = useStore();
  const [wizardOpen, setWizardOpen] = useState(false);
  // A small, dismissible error surfaced when a close actually FAILS (so we don't silently pretend a
  // session is gone). Cleared on the next close attempt or when the user dismisses it.
  const [closeError, setCloseError] = useState<string | undefined>();
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
          // network/other error: still enter the app; the list is empty and can be retried.
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
          if (!cancelled) mergeSessionMeta(s);
        })
        .catch(() => {
          // transient — keep the current list; the next tick retries.
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
          }
          setUpdateInfo(info);
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
  }, [phase, api, setUpdateInfo, setUpdateState]);

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
          if (!cancelled) setUsage(u);
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
        error: err instanceof ApiError ? err.message : "Couldn't start the update.",
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
    if (wasActive) {
      const remaining = sortSessionsByActivity(
        sessions.filter((s) => s.id !== id),
        lastActiveAt,
      );
      setActive(remaining[0]?.id);
    }
    removeSession(id);
    setCloseError(undefined);
    void api.deleteSession(id).catch((err: unknown) => {
      // The delete genuinely failed — undo the optimistic removal so the row reappears, and tell the
      // user. (An already-gone session is a 204 server-side, so it never lands here.)
      if (closing) {
        addSession(closing);
        if (wasActive) setActive(id);
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
      onSelect={(id) => {
        setActive(id);
        setSessionsOpen(false);
      }}
      onNew={() => openWizard("new")}
      onClose={closeSession}
      viewWireState={(id) => {
        // The list only renders ids that are in `sessions`, so a miss is unreachable; fall back to
        // "idle" rather than fabricating a fake SessionMeta to satisfy wireStateForSession.
        const meta = sessions.find((s) => s.id === id);
        return meta ? wireStateForSession(meta, views[id]) : "idle";
      }}
    />
  );

  return (
    <>
      <ConnectionBanner online={online} />
      {updateInfo && !updateBannerDismissed && updateState !== "updating" && (
        <UpdateBanner
          info={updateInfo}
          onWhatsNew={() => setUpdatePanelOpen(true)}
          onUpdate={() => setUpdatePanelOpen(true)}
          onDismiss={() => setUpdateBannerDismissed(true)}
        />
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
              width: 28px; height: 28px; border-radius: var(--radius-sm);
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
              width: 28px; height: 28px; border-radius: var(--radius-sm);
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
        needsYou={awaitingCount(sessions)}
        onShowSessions={() => setSessionsOpen(true)}
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
            // Resume is idempotent server-side: a session that's already live is returned as-is, so
            // dedupe by id rather than appending a duplicate rail row.
            setSessions(sessions.some((s) => s.id === session.id) ? sessions : [...sessions, session]);
            setActive(session.id);
            setWizardOpen(false);
            setSessionsOpen(false);
          }}
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
