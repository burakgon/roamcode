import { useEffect, useMemo, useState } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { loadToken, saveToken, clearToken, consumeTokenFromUrl } from "./auth/token-store";
import { createApiClient, ApiError } from "./api/client";
import { API_BASE_URL } from "./config";
import { useStore } from "./store/store";
import { AppLayout } from "./AppLayout";
import { SessionList } from "./session/SessionList";
import { wireStateForSession } from "./session/status";
import { sortSessionsByActivity } from "./session/order";
import { sessionIdFromLocation } from "./session/deep-link";
import { NewSessionWizard } from "./session/NewSessionWizard";
import { loadRecentDirs } from "./picker/recents";
import { ChatView } from "./chat/ChatView";
import { ConnectionBanner } from "./pwa/ConnectionBanner";
import { useOnline } from "./pwa/online-status";
import { Icon } from "./ui/Icon";

type Phase = "login" | "validating" | "ready";

export function App() {
  // Prefer a `?token=` in the connect URL (the link the server prints): persist it + strip it from
  // the address bar, so opening the printed link authenticates directly instead of prompting. Falls
  // back to a previously stored token.
  const [token, setTokenState] = useState<string | undefined>(() => consumeTokenFromUrl() ?? loadToken());
  const [phase, setPhase] = useState<Phase>(token === undefined ? "login" : "validating");
  const [loginError, setLoginError] = useState<string | undefined>();
  const { sessions, setSessions, setToken, activeSessionId, setActive, removeSession, views, lastActiveAt } =
    useStore();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
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

  // Close (= stop + remove) a session in one tap. The server's stop endpoint both kills the claude
  // process AND drops the session, so on success we mirror that by removing it client-side. If the
  // closed session was the active one, reselect the new top (most-recently-active) row, or fall back
  // to the empty/landing state when nothing remains.
  const closeSession = (id: string) => {
    void api
      .stopSession(id)
      .catch(() => {
        // Best-effort: even if the stop call errors (already gone, transient network), drop it from
        // the client so the rail declutters; GET /sessions only returns live sessions anyway.
      })
      .finally(() => {
        if (id === activeSessionId) {
          const remaining = sortSessionsByActivity(
            sessions.filter((s) => s.id !== id),
            lastActiveAt,
          );
          setActive(remaining[0]?.id);
        }
        removeSession(id);
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
      onNew={() => setWizardOpen(true)}
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
      <AppLayout
        sessionList={list}
        sessionsOpen={sessionsOpen}
        conversationActive={activeSessionId !== undefined}
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
              <ChatView key={active.id} session={active} api={api} token={token} />
            ) : (
              <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-muted)" }}>
                Session not found.
              </div>
            );
          })()
        ) : (
          <div
            style={{
              display: "grid",
              placeItems: "center",
              gap: "var(--sp-4)",
              height: "100%",
              color: "var(--text-muted)",
              padding: "var(--sp-5)",
              textAlign: "center",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 56,
                height: 56,
                display: "grid",
                placeItems: "center",
                borderRadius: "var(--radius)",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                color: "var(--text-faint)",
              }}
            >
              <Icon name="terminal" size={24} />
            </span>
            <span className="display" style={{ fontSize: "var(--fs-lg)", color: "var(--text)" }}>
              Select or start a session
            </span>
            {/* A landing-state CTA so a new session is reachable without first opening the mobile
                sessions sheet (the rail's "New session" is hidden until the sheet is open on mobile). */}
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              aria-label="New session"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--sp-2)",
                minHeight: "var(--tap-min)",
                padding: "0 var(--sp-5)",
                background: "var(--accent)",
                color: "var(--on-accent)",
                border: "1px solid var(--accent)",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                fontFamily: "var(--font-display)",
                fontWeight: 600,
              }}
            >
              <Icon name="plus" size={16} />
              New session
            </button>
          </div>
        )}
      </AppLayout>
      {wizardOpen && (
        <NewSessionWizard
          api={api}
          recents={loadRecentDirs()}
          onClose={() => setWizardOpen(false)}
          onCreated={(session) => {
            setSessions([...sessions, session]);
            setActive(session.id);
            setWizardOpen(false);
            setSessionsOpen(false);
          }}
        />
      )}
    </>
  );
}
