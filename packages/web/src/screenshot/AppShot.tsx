// Dev-only screenshot harness. Renders the REAL app shell + REAL chat components seeded with a
// realistic transcript so the captured PNGs show the built UI (not a static mockup).
//
// It composes the same components the production App composes — AppLayout, SessionList, ChatHeader,
// MessageList, PermissionPrompt, Composer, QuestionPrompt, NewSessionWizard, ResumePicker, RewindSheet,
// LoginScreen — reading from the REAL Zustand store / shipped prop contracts. The only thing it does
// NOT use is ChatView's live WebSocket/REST plumbing (useSessionSocket + api.getSession), which would
// require a running server; instead the store is pre-seeded through the REAL frame reducer and the
// overlay components get static fixtures. Every visible pixel is a shipped component with real tokens.
//
// A `?scene=<name>` query selects which surface to capture (one PNG per scene): chat | question |
// wizard | resume | rewind | login. Default is the chat. The scene switch is the ONLY harness-specific
// addition; it never touches the production bundle (this module is imported only by screenshot.tsx).

import { useStore } from "../store/store";
import { AppLayout } from "../AppLayout";
import { SessionList, awaitingCount } from "../session/SessionList";
import { wireStateForSession } from "../session/status";
import { ChatHeader } from "../chat/ChatHeader";
import { MessageList } from "../chat/MessageList";
import { PermissionPrompt } from "../chat/PermissionPrompt";
import { QuestionPrompt } from "../chat/QuestionPrompt";
import { Composer } from "../chat/Composer";
import { ChatTelemetry } from "../chat/ChatTelemetry";
import { RewindSheet } from "../chat/RewindSheet";
import { NewSessionWizard } from "../session/NewSessionWizard";
import { ResumePicker } from "../session/ResumePicker";
import { LoginScreen } from "../auth/LoginScreen";
import { SettingsPanel } from "../settings/SettingsPanel";
import { SubagentTray } from "../chat/SubagentTray";
import { SubagentView } from "../chat/SubagentView";
import { TerminalView } from "../chat/TerminalView";
import { makeFakeTerminalSocket } from "./fakeTerminalSocket";
import { loadDefaults } from "../settings/defaults";
import { emptyView } from "../store/frame-reducer";
import type { SessionMeta } from "../types/server";
import {
  ACTIVE_ID,
  AGENTS_ID,
  AGENTS_SESSION,
  CHECKPOINT_ID,
  COMPOSER_TEXT,
  COMPOSER_IMAGES,
  DIR_LISTING,
  PICKER_RECENTS,
  QUESTION,
  RESUMABLE,
  SESSIONS,
  USAGE,
  screenshotDownloadUrl,
} from "./seed";

type Scene =
  | "chat"
  | "question"
  | "wizard"
  | "resume"
  | "rewind"
  | "login"
  | "settings"
  | "subagents"
  | "subagentview"
  | "sessions"
  | "terminal";

function currentScene(): Scene {
  const s = new URLSearchParams(window.location.search).get("scene");
  if (
    s === "question" ||
    s === "wizard" ||
    s === "resume" ||
    s === "rewind" ||
    s === "login" ||
    s === "settings" ||
    s === "subagents" ||
    s === "subagentview" ||
    s === "sessions" ||
    s === "terminal"
  )
    return s;
  return "chat";
}

// One stable fake socket for the terminal scene (a fresh ref each render would remount TerminalView).
const TERMINAL_SOCKET = makeFakeTerminalSocket();

/** A non-interactive mirror of ChatView's JSX (header + log + subagent tray + permission/question gate
 *  + composer). `sessionId`/`sessionOverride` let the subagent scenes render a dedicated session. */
function ChatBody({
  scene,
  sessionId = ACTIVE_ID,
  sessionOverride,
}: {
  scene: Scene;
  sessionId?: string;
  sessionOverride?: SessionMeta;
}) {
  const sessions = useStore((s) => s.sessions);
  const views = useStore((s) => s.views);
  const session = sessionOverride ?? sessions.find((s) => s.id === sessionId)!;
  const view = views[sessionId] ?? emptyView();
  const wireState = wireStateForSession(session, view);
  const pending = view.pendingPermission;
  const isActive = sessionId === ACTIVE_ID;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ChatHeader session={session} needsYou={awaitingCount(sessions)} />
      <div aria-live="polite" style={{ flex: 1, overflowY: "auto" }}>
        {/* Pass downloadUrl so Claude's sent chart previews inline, onRewind so user turns carry the
            rewind affordance, and onOpenSubagent so subagent cards render as the live (tappable) look. */}
        <MessageList view={view} downloadUrl={screenshotDownloadUrl} onRewind={() => {}} onOpenSubagent={() => {}} />
        {scene === "question" ? (
          <div style={{ padding: "var(--sp-4)" }}>
            <QuestionPrompt question={QUESTION} onAnswer={() => {}} onCancel={() => {}} />
          </div>
        ) : (
          pending && (
            <div style={{ padding: "var(--sp-4)" }}>
              <PermissionPrompt permission={pending} onAnswer={() => {}} onAlwaysAllow={() => {}} />
            </div>
          )
        )}
      </div>
      {/* The subagent tray sits directly above the composer (renders nothing without subagents). */}
      <SubagentTray subagents={view.subagents} subagentOrder={view.subagentOrder} onOpen={() => {}} />
      {/* The telemetry strip — live model state + context meter, pinned above the composer. */}
      <ChatTelemetry wireState={wireState} contextTokens={92000} model={session.model} />
      <Composer
        onSend={() => {}}
        onUploadFile={async () => {}}
        initialText={isActive ? COMPOSER_TEXT : ""}
        initialImages={isActive ? COMPOSER_IMAGES : []}
      />
    </div>
  );
}

// A mock API for the wizard / resume scenes: resolves the seeded directory listing + resumable list so
// the REAL DirectoryPicker / ResumePicker render from shipped code, no server.
const mockApi = {
  listDir: async () => DIR_LISTING,
  getResumable: async () => RESUMABLE,
  createSession: async () => SESSIONS[0]!,
};

export function AppShot() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const views = useStore((s) => s.views);
  const lastActiveAt = useStore((s) => s.lastActiveAt);
  const setActive = useStore((s) => s.setActive);
  const scene = currentScene();

  // Login is a full-screen surface with no shell — render it standalone, exactly as App does pre-auth.
  if (scene === "login") {
    return <LoginScreen onAuthenticated={() => {}} />;
  }

  const list = (
    <SessionList
      sessions={sessions}
      activeId={activeId}
      lastActiveAt={lastActiveAt}
      now={Date.now()}
      usage={USAGE}
      version="v2026.06.26 · ebe4bd3"
      updateAvailable
      onShowUpdate={() => {}}
      onSelect={(id) => setActive(id)}
      onNew={() => {}}
      onClose={() => {}}
      viewWireState={(id) =>
        wireStateForSession(
          sessions.find((s) => s.id === id) ?? { id, cwd: "", dangerouslySkip: false, status: "running", createdAt: 0 },
          views[id],
        )
      }
    />
  );

  // Terminal mode renders TerminalView (which owns its own header) inside the shell, exactly as App.tsx.
  // The fake socket feeds a controlled glyph + edge-fit test frame; every pixel here is shipped code.
  if (scene === "terminal") {
    const termSession = { ...sessions.find((s) => s.id === ACTIVE_ID)!, mode: "terminal" as const };
    return (
      <AppLayout sessionList={list} sessionsOpen={false} onHideSessions={() => {}}>
        <TerminalView session={termSession} onShowSessions={() => {}} onClose={() => {}} createSocket={TERMINAL_SOCKET} />
      </AppLayout>
    );
  }

  return (
    <>
      <AppLayout sessionList={list} sessionsOpen={scene === "sessions"} onHideSessions={() => {}}>
        <ChatBody
          scene={scene}
          sessionId={scene === "subagents" || scene === "subagentview" ? AGENTS_ID : ACTIVE_ID}
          sessionOverride={scene === "subagents" || scene === "subagentview" ? AGENTS_SESSION : undefined}
        />
      </AppLayout>
      {/* Overlays render on top of the live chat, exactly as App mounts them. */}
      {scene === "wizard" && (
        <NewSessionWizard
          api={mockApi}
          recents={PICKER_RECENTS}
          now={Date.now()}
          initialMode="new"
          onCreated={() => {}}
          onClose={() => {}}
        />
      )}
      {scene === "resume" && (
        <ResumePicker
          getResumable={mockApi.getResumable}
          now={Date.now()}
          onResume={async () => {}}
          onCancel={() => {}}
        />
      )}
      {scene === "rewind" && <RewindSheet checkpointId={CHECKPOINT_ID} onConfirm={() => {}} onCancel={() => {}} />}
      {scene === "settings" && (
        <SettingsPanel
          session={sessions.find((s) => s.id === ACTIVE_ID)}
          defaults={loadDefaults()}
          onSaveDefaults={() => {}}
          onApplyLiveSettings={() => {}}
          onStopSession={() => {}}
          onClose={() => {}}
        />
      )}
      {/* The subagent drill-in sheet — opened over the agents session for the completed Explore agent. */}
      {scene === "subagentview" && views[AGENTS_ID]?.subagents["sa-1"] && (
        <SubagentView
          thread={views[AGENTS_ID]!.subagents["sa-1"]!}
          subagents={views[AGENTS_ID]!.subagents}
          onOpenSubagent={() => {}}
          onClose={() => {}}
          downloadUrl={screenshotDownloadUrl}
        />
      )}
    </>
  );
}
