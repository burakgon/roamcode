// Dev-only screenshot harness. Renders the REAL app shell + REAL chat components seeded with a
// realistic transcript so the captured PNGs show the built UI (not the static Task-1 mockup).
//
// It composes the same components the production App composes — AppLayout, SessionList, ChatHeader,
// MessageList, PermissionPrompt, Composer — reading from the REAL Zustand store. The only thing it
// does NOT use is ChatView's live WebSocket/REST plumbing (useSessionSocket + api.getSession), which
// would require a running server; instead the store is pre-seeded through the REAL frame reducer.
// Every visible pixel is produced by a shipped component with the real design tokens.

import { useStore } from "../store/store";
import { AppLayout } from "../AppLayout";
import { SessionList, awaitingCount } from "../session/SessionList";
import { wireStateForSession } from "../session/status";
import { ChatHeader } from "../chat/ChatHeader";
import { MessageList } from "../chat/MessageList";
import { PermissionPrompt } from "../chat/PermissionPrompt";
import { Composer } from "../chat/Composer";
import { emptyView } from "../store/frame-reducer";
import { ACTIVE_ID, COMPOSER_TEXT, COMPOSER_IMAGES } from "./seed";

/** A non-interactive mirror of ChatView's JSX (header + log + permission gate + composer). */
function ChatBody() {
  const sessions = useStore((s) => s.sessions);
  const views = useStore((s) => s.views);
  const session = sessions.find((s) => s.id === ACTIVE_ID)!;
  const view = views[ACTIVE_ID] ?? emptyView();
  const wireState = wireStateForSession(session, view);
  const pending = view.pendingPermission;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ChatHeader session={session} wireState={wireState} />
      <div aria-live="polite" style={{ flex: 1, overflowY: "auto" }}>
        <MessageList view={view} />
        {pending && (
          <div style={{ padding: "var(--sp-4)" }}>
            <PermissionPrompt permission={pending} onAnswer={() => {}} onAlwaysAllow={() => {}} />
          </div>
        )}
      </div>
      <Composer
        onSend={() => {}}
        onUploadFile={async () => {}}
        initialText={COMPOSER_TEXT}
        initialImages={COMPOSER_IMAGES}
      />
    </div>
  );
}

export function AppShot() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const views = useStore((s) => s.views);
  const lastActiveAt = useStore((s) => s.lastActiveAt);
  const setActive = useStore((s) => s.setActive);

  const list = (
    <SessionList
      sessions={sessions}
      activeId={activeId}
      lastActiveAt={lastActiveAt}
      now={Date.now()}
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

  return (
    <AppLayout sessionList={list} needsYou={awaitingCount(sessions)}>
      <ChatBody />
    </AppLayout>
  );
}
