import { useCallback, useEffect, useRef, useState } from "react";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
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
import type { ContentBlock, SessionMeta } from "../types/server";

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
}

export function ChatView({ session, api, token, onSlashCommand, onClose }: ChatViewProps) {
  const applyFrames = useStore((s) => s.applyFrames);
  const resetSession = useStore((s) => s.resetSession);
  const view = useStore((s) => s.views[session.id]);
  const sessions = useStore((s) => s.sessions);
  const setSessions = useStore((s) => s.setSessions);
  const appendUserMessage = useStore((s) => s.appendUserMessage);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Reflect the device's current push-subscription state in Settings. No permission is requested
  // here — `currentPushState` only reads the existing subscription (the opt-in is a deliberate tap).
  const [pushState, setPushState] = useState<"subscribed" | "unsubscribed" | "unsupported">("unsubscribed");
  useEffect(() => {
    void currentPushState().then(setPushState);
  }, []);

  // Open the live socket (frames flow into the store via the hook).
  const { send } = useSessionSocket(session, token);

  // Load REST history once per session id, replaying frames through the same reducer in a single
  // store update (one re-render). The reducer's seq-dedup makes any overlap with live frames a no-op.
  useEffect(() => {
    let cancelled = false;
    resetSession(session.id);
    api
      .getSession(session.id)
      .then(({ history }) => {
        if (cancelled) return;
        applyFrames(session.id, history);
      })
      .catch(() => {
        // history load failure is non-fatal; live frames still arrive over WS
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, api, applyFrames, resetSession]);

  const wireState = wireStateForSession(session, view);
  const safeView = view ?? emptyView();

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

  // AskUserQuestion answering: answer the model's question (or skip, which denies the tool). Shares
  // the same `answered` set as permissions so the prompt hides optimistically and never double-sends.
  const answerQuestion = useCallback(
    (requestId: string, toolInput: unknown, answers: Record<string, string | string[]>) => {
      if (answeredRef.current.has(requestId)) return;
      answeredRef.current.add(requestId);
      setAnswered((prev) => new Set(prev).add(requestId));
      send({ type: "answer", requestId, toolInput, answers });
    },
    [send],
  );
  const cancelQuestion = useCallback(
    (requestId: string) => {
      if (answeredRef.current.has(requestId)) return;
      answeredRef.current.add(requestId);
      setAnswered((prev) => new Set(prev).add(requestId));
      send({ type: "permission", requestId, decision: "deny" });
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
      <ChatHeader session={session} wireState={wireState} onOpenSettings={() => setSettingsOpen(true)} />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        aria-live="polite"
        aria-relevant="additions text"
        style={{ flex: 1, overflowY: "auto" }}
      >
        <MessageList view={safeView} downloadUrl={(path) => api.downloadUrl(path)} />

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
              onAnswer={(answers) => answerQuestion(pendingQuestion.requestId, pendingQuestion.toolInput, answers)}
              onCancel={() => cancelQuestion(pendingQuestion.requestId)}
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
    </div>
  );
}
