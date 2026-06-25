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
import { useOnline } from "./pwa/online-status";
import { Icon } from "./ui/Icon";
import { MobileMenuButton } from "./ui/MobileMenuButton";

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
  } = useStore();
  const [wizardOpen, setWizardOpen] = useState(false);
  // A small, dismissible error surfaced when a close actually FAILS (so we don't silently pretend a
  // session is gone). Cleared on the next close attempt or when the user dismisses it.
  const [closeError, setCloseError] = useState<string | undefined>();
  // Which segment the wizard's New/Resume toggle opens on. The normal +/New affordances open "new"
  // (the directory picker); the in-chat `/resume` slash command opens straight to "resume".
  const [wizardMode, setWizardMode] = useState<"new" | "resume">("new");
  const [sessionsOpen, setSessionsOpen] = useState(false);

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
  // of GET /sessions every ~6s (and on window focus + when the connection comes back online, e.g. a WS
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
    const interval = setInterval(refresh, 6_000);
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
        <span
          aria-hidden="true"
          className="display"
          style={{ fontSize: "var(--fs-2xl)", color: "var(--text-faint)" }}
        >
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
                <div style={{ display: "flex", padding: "var(--sp-3) var(--sp-4)", flex: "none" }}>
                  <MobileMenuButton onShowSessions={() => setSessionsOpen(true)} needsYou={awaitingCount(sessions)} />
                </div>
                <div style={{ display: "grid", placeItems: "center", flex: 1, minHeight: 0, color: "var(--text-muted)" }}>
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
            <div style={{ display: "flex", padding: "var(--sp-3) var(--sp-4)", flex: "none" }}>
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
              {/* The landing mark — a clay-coral tile with a soft glow + inset top highlight (spec
                  .mark). The on-brand focal point; the ONE coral moment on the empty state. */}
            <span
              aria-hidden="true"
              style={{
                width: 64,
                height: 64,
                display: "grid",
                placeItems: "center",
                borderRadius: "var(--radius)",
                background: "var(--tile-bg)",
                color: "#fff3ea",
                boxShadow:
                  "inset 0 1px 0 rgba(255,240,230,.6), 0 8px 22px -8px rgba(247,124,68,.85), 0 0 20px -4px rgba(247,124,68,.45)",
              }}
            >
              <Icon name="terminal" size={28} />
            </span>
            <span className="display" style={{ fontSize: "var(--fs-lg)", color: "var(--text)" }}>
              Select or start a session
            </span>
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", maxWidth: "26ch", lineHeight: 1.5 }}>
              No active session. Tap{" "}
              <span aria-hidden="true" style={{ color: "var(--accent)", fontWeight: 600 }}>
                +
              </span>{" "}
              to start one and drive Claude from your phone.
            </span>
            {/* A landing-state CTA so a new session is reachable without first opening the mobile
                sessions sheet (the rail's "New session" is hidden until the sheet is open on mobile).
                The single coral primary — a clay-coral gradient with the liquid-glass glow halo + dark
                ink label. */}
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
                boxShadow: "var(--shadow-pop)",
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
    </>
  );
}
