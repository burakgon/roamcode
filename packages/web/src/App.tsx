import { useEffect, useMemo, useState } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { loadToken, saveToken, clearToken } from "./auth/token-store";
import { createApiClient, ApiError } from "./api/client";
import { API_BASE_URL } from "./config";
import { useStore } from "./store/store";
import { AppLayout } from "./AppLayout";
import { SessionList } from "./session/SessionList";
import { wireStateForSession } from "./session/status";
import { sessionIdFromLocation } from "./session/deep-link";
import { NewSessionWizard } from "./session/NewSessionWizard";
import { loadRecentDirs } from "./picker/recents";
import { ChatView } from "./chat/ChatView";
import { ConnectionBanner } from "./pwa/ConnectionBanner";
import { useOnline } from "./pwa/online-status";
import { Button } from "./ui/Button";

type Phase = "login" | "validating" | "ready";

export function App() {
  const [token, setTokenState] = useState<string | undefined>(() => loadToken());
  const [phase, setPhase] = useState<Phase>(token === undefined ? "login" : "validating");
  const [loginError, setLoginError] = useState<string | undefined>();
  const { sessions, setSessions, setToken, activeSessionId, setActive, views } = useStore();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const online = useOnline();

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
    return <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-muted)" }}>Connecting…</div>;
  }

  const list = (
    <SessionList
      sessions={sessions}
      activeId={activeSessionId}
      onSelect={(id) => {
        setActive(id);
        setSessionsOpen(false);
      }}
      onNew={() => setWizardOpen(true)}
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
              <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-muted)" }}>Session not found.</div>
            );
          })()
        ) : (
          <div style={{ display: "grid", placeItems: "center", gap: "var(--sp-4)", height: "100%", color: "var(--text-muted)", padding: "var(--sp-5)", textAlign: "center" }}>
            <span>Select or start a session.</span>
            {/* A landing-state CTA so a new session is reachable without first opening the mobile
                sessions sheet (the rail's "New session" is hidden until the sheet is open on mobile). */}
            <Button variant="primary" onClick={() => setWizardOpen(true)} aria-label="New session">
              + New session
            </Button>
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
