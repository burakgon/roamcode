import { useCallback, useEffect, useRef, useState } from "react";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { RewindSheet } from "./RewindSheet";
import type { RewindMode } from "./RewindSheet";
import { PermissionPrompt } from "./PermissionPrompt";
import { QuestionPrompt } from "./QuestionPrompt";
import { AutoAllowChip } from "./AutoAllowChip";
import { useStore } from "../store/store";
import { useSessionSocket } from "../session/use-session-socket";
import { wireStateForSession } from "../session/status";
import { emptyView } from "../store/frame-reducer";
import { SettingsPanel } from "../settings/SettingsPanel";
import { loadDefaults, saveDefaults, EFFORT_THINKING_TOKENS } from "../settings/defaults";
import { enablePush, disablePush, currentPushState } from "../pwa/push";
import type { ApiClient } from "../api/client";
import type { ContentBlock, QuestionPayload, SessionMeta } from "../types/server";

export interface ChatViewProps {
  session: SessionMeta;
  api: ApiClient;
  token: string | undefined;
  /** A client-action slash command was picked in the composer (e.g. `/resume`). Threaded up to the
   * app, which runs the UI action (opening the resume picker). Nothing is sent to claude. */
  onSlashCommand?: (name: string) => void;
  /** Close (= delete) this session — same one-tap close as the rail's ✕: the server removes it from
   * the list while keeping the transcript (resumable). The app owns it so the chat disappears for good
   * and the active selection moves on. Used by Settings' "Stop session". */
  onClose?: (id: string) => void;
  /** Open the mobile sessions sheet — threaded down to the header's top-left menu button (mobile-only;
   * the desktop rail is always visible). */
  onShowSessions?: () => void;
  /** Sessions awaiting a permission/question — drives the header menu button's iris "needs you" pip. */
  needsYou?: number;
}

export function ChatView({ session, api, token, onSlashCommand, onClose, onShowSessions, needsYou }: ChatViewProps) {
  const loadHistory = useStore((s) => s.loadHistory);
  const resetSession = useStore((s) => s.resetSession);
  const view = useStore((s) => s.views[session.id]);
  const sessions = useStore((s) => s.sessions);
  const setSessions = useStore((s) => s.setSessions);
  const appendUserMessage = useStore((s) => s.appendUserMessage);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // REWIND / CHECKPOINT: the checkpoint a user tapped "rewind to here" on (the user-message uuid). When
  // set, the confirm sheet is open for that checkpoint; confirming sends a `rewind` frame and the
  // server-emitted `rewound` frame drives the marker + (for conversation/both) the display truncation.
  const [rewindTarget, setRewindTarget] = useState<string | undefined>(undefined);
  // Reflect the device's current push-subscription state in Settings. No permission is requested
  // here — `currentPushState` only reads the existing subscription (the opt-in is a deliberate tap).
  const [pushState, setPushState] = useState<"subscribed" | "unsubscribed" | "unsupported">("unsubscribed");
  useEffect(() => {
    void currentPushState().then(setPushState);
  }, []);

  // Load the FULL transcript history BEFORE opening the live socket, so the socket resumes from the
  // server's `sinceSeq` (set as the view's lastSeq) rather than re-replaying the buffer. `historyLoaded`
  // gates the WS connect so the first connection already carries `?since=sinceSeq` — the buffer frames
  // (seq ≤ sinceSeq) are skipped and only NEW live frames (seq > sinceSeq) arrive, with no double
  // display and no dropped updates. A load failure still flips the gate so live frames flow over WS.
  const [historyLoaded, setHistoryLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setHistoryLoaded(false);
    resetSession(session.id);
    api
      .getSession(session.id)
      .then(({ history, sinceSeq }) => {
        if (cancelled) return;
        loadHistory(session.id, history, sinceSeq);
      })
      .catch(() => {
        // history load failure is non-fatal; live frames still arrive over WS (full replay)
      })
      .finally(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, api, loadHistory, resetSession]);

  // Open the live socket AFTER history loads (frames flow into the store via the hook). Gating on
  // `historyLoaded` guarantees the socket's `getSince` reads the lastSeq = sinceSeq we just set.
  const { send } = useSessionSocket(session, token, historyLoaded);

  const wireState = wireStateForSession(session, view);
  const safeView = view ?? emptyView();

  // "Running" = a turn is actively in flight (thinking / streaming / running a tool). This drives the
  // composer's Stop button. It reads the live VIEW wire state (the session's own activity), NOT the
  // meta-derived wireState — an `awaiting` permission/question is deliberately NOT "running" (the user
  // should answer, not stop), and it must work even for the live session you're connected to.
  const running =
    safeView.wireState === "thinking" ||
    safeView.wireState === "streaming" ||
    safeView.wireState === "running-tool";

  // Client-side "Always allow" — a per-session set of tool names the user has chosen to auto-allow.
  // When a future permission for such a tool arrives we answer `allow` for the user (with a visible
  // indicator + a way to clear the rule). This lives in component state (this session, this device);
  // it is intentionally NOT persisted — the gate is a security boundary and a fresh load re-prompts.
  const [autoAllow, setAutoAllow] = useState<Set<string>>(() => new Set());
  // requestIds we've already answered. Tracked in state so answering hides the prompt immediately
  // (optimistic) rather than lingering until the next server frame clears `pendingPermission`; the
  // ref guards against double-sending the same decision across re-renders / auto-allow.
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const answeredRef = useRef<Set<string>>(answered);
  answeredRef.current = answered;

  const answer = useCallback(
    (requestId: string, decision: "allow" | "deny") => {
      if (answeredRef.current.has(requestId)) return;
      answeredRef.current.add(requestId);
      setAnswered((prev) => new Set(prev).add(requestId));
      send({ type: "permission", requestId, decision });
    },
    [send],
  );

  // AskUserQuestion answering: answer the model's question (or skip). For an `ask_user` MCP question
  // (askId present) we send `{ type:"answer", askId, answers }` so the server resolves the matching
  // held POST /ask long-poll (answerAsk, routed by askId). For the legacy built-in path (no askId) we
  // keep the `{ requestId, toolInput, answers }` shape routed back into the CLI. Both dedupe on the
  // pending question's requestId (which mirrors askId), sharing the `answered` set with permissions so
  // the prompt hides optimistically and never double-sends.
  const answerQuestion = useCallback(
    (q: QuestionPayload, answers: Record<string, string | string[]>) => {
      if (answeredRef.current.has(q.requestId)) return;
      answeredRef.current.add(q.requestId);
      setAnswered((prev) => new Set(prev).add(q.requestId));
      if (q.askId) send({ type: "answer", askId: q.askId, answers });
      else send({ type: "answer", requestId: q.requestId, toolInput: q.toolInput, answers });
    },
    [send],
  );
  const cancelQuestion = useCallback(
    (q: QuestionPayload) => {
      if (answeredRef.current.has(q.requestId)) return;
      answeredRef.current.add(q.requestId);
      setAnswered((prev) => new Set(prev).add(q.requestId));
      // ask_user: resolve the held request with an empty answer map (the server interprets "no
      // selection" as declined and the MCP tool returns "User answered (no selection)."), so the
      // long-poll never hangs. Legacy built-in path: deny the question (the CLI proceeds with denial).
      if (q.askId) send({ type: "answer", askId: q.askId, answers: {} });
      else send({ type: "permission", requestId: q.requestId, decision: "deny" });
    },
    [send],
  );

  const pending = safeView.pendingPermission;
  const pendingTool = pending?.toolName;
  const pendingAnswered = pending !== undefined && answered.has(pending.requestId);
  // Auto-allow a pending permission whose tool is covered by an active rule (run as an effect so the
  // send happens after render, not during it).
  const isAutoAllowed = pending !== undefined && pendingTool !== undefined && autoAllow.has(pendingTool);

  const pendingQuestion = safeView.pendingQuestion;
  const questionAnswered = pendingQuestion !== undefined && answered.has(pendingQuestion.requestId);
  useEffect(() => {
    if (pending && isAutoAllowed) answer(pending.requestId, "allow");
  }, [pending, isAutoAllowed, answer]);

  // Auto-scroll the log to the newest content as turns/streaming text grow — unless the user has
  // scrolled up to read history (then we leave their position alone). A small slack avoids
  // sub-pixel jitter at the bottom counting as "scrolled up".
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottom.current = distanceFromBottom < 64;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [safeView.turns.length, safeView.liveText, safeView.thinkingText]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ChatHeader
        session={session}
        wireState={wireState}
        onOpenSettings={() => setSettingsOpen(true)}
        onShowSessions={onShowSessions}
        needsYou={needsYou}
      />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        aria-live="polite"
        aria-relevant="additions text"
        style={{ flex: 1, overflowY: "auto" }}
      >
        <MessageList
          view={safeView}
          downloadUrl={(path) => api.downloadUrl(path)}
          onRewind={(checkpointId) => setRewindTarget(checkpointId)}
        />

        {/* The pending permission gate. Hidden once answered (optimistic) or while it is being
            auto-allowed (a rule already covers it). */}
        {pending && !isAutoAllowed && !pendingAnswered && (
          <div style={{ padding: "var(--sp-4)" }}>
            <PermissionPrompt
              permission={pending}
              onAnswer={(decision) => answer(pending.requestId, decision)}
              onAlwaysAllow={(tool) => setAutoAllow((prev) => new Set(prev).add(tool))}
            />
          </div>
        )}

        {/* The pending AskUserQuestion. Hidden once answered (optimistic). Submitting sends an
            `answer` frame; Skip denies the tool so the model proceeds with the denial. */}
        {pendingQuestion && !questionAnswered && (
          <div style={{ padding: "var(--sp-4)" }}>
            <QuestionPrompt
              question={pendingQuestion}
              onAnswer={(answers) => answerQuestion(pendingQuestion, answers)}
              onCancel={() => cancelQuestion(pendingQuestion)}
            />
          </div>
        )}
      </div>
      {/* Compact auto-allow chip near the composer — taps open into the active rules, each clearable.
          Presentation only; the auto-allow set + isAutoAllowed effect (above) are unchanged. */}
      <AutoAllowChip
        tools={[...autoAllow]}
        onClear={(tool) =>
          setAutoAllow((prev) => {
            const next = new Set(prev);
            next.delete(tool);
            return next;
          })
        }
      />
      <Composer
        onSend={(frame) => {
          // Optimistically show the user's own message: claude does not echo the typed user text
          // back as a render-able turn, so without this the sender never sees what they sent.
          if (frame.type === "user") {
            const blocks: ContentBlock[] = [];
            if (frame.text) blocks.push({ type: "text", text: frame.text });
            for (const img of frame.images ?? []) {
              blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 } });
            }
            if (blocks.length > 0) appendUserMessage(session.id, blocks);
          }
          send(frame);
        }}
        onUploadFile={async (file) => {
          await api.uploadFile(session.cwd, file);
        }}
        onSlashCommand={onSlashCommand}
        running={running}
        onStop={() => send({ type: "interrupt" })}
      />
      {settingsOpen && (
        <SettingsPanel
          session={session}
          defaults={loadDefaults()}
          onSaveDefaults={(d) => {
            saveDefaults(d);
            setSettingsOpen(false);
          }}
          onStopSession={(id) => {
            // Stop session now CLOSES it for good (delete) — same as the rail's ✕ — so the chat
            // disappears and the app reselects the new top. Delegated to the app's close handler; falls
            // back to a direct stop call if no handler is wired (defensive — always provided by App).
            setSettingsOpen(false);
            if (onClose) onClose(id);
            else void api.stopSession(id);
          }}
          onApplyLiveSettings={({ model, effort, permissionMode }) => {
            const maxThinkingTokens = effort ? EFFORT_THINKING_TOKENS[effort] : undefined;
            send({ type: "settings", model, effort, maxThinkingTokens, permissionMode });
            // Optimistically reflect into the session list so the header/meta update immediately.
            // effort (set_max_thinking_tokens) has no wire echo, so this is the only source of truth
            // for the displayed effort; model/permissionMode would also reconcile on the next
            // system/init, but reflecting now keeps the UI responsive.
            setSessions(
              sessions.map((s) =>
                s.id === session.id ? { ...s, model: model ?? s.model, effort: effort ?? s.effort } : s,
              ),
            );
            setSettingsOpen(false);
          }}
          pushState={pushState}
          onEnablePush={async () => {
            const result = await enablePush(api);
            setPushState(
              result === "subscribed" ? "subscribed" : result === "unsupported" ? "unsupported" : "unsubscribed",
            );
          }}
          onDisablePush={async () => {
            await disablePush(api);
            setPushState("unsubscribed");
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {rewindTarget !== undefined && (
        <RewindSheet
          checkpointId={rewindTarget}
          onCancel={() => setRewindTarget(undefined)}
          onConfirm={(mode: RewindMode) => {
            send({ type: "rewind", checkpointId: rewindTarget, mode });
            setRewindTarget(undefined);
          }}
        />
      )}
    </div>
  );
}
