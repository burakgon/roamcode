import { useCallback, useEffect, useRef, useState } from "react";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { PermissionPrompt } from "./PermissionPrompt";
import { QuestionPrompt } from "./QuestionPrompt";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { useStore } from "../store/store";
import { useSessionSocket } from "../session/use-session-socket";
import { wireStateForSession } from "../session/status";
import { emptyView } from "../store/frame-reducer";
import { SettingsPanel } from "../settings/SettingsPanel";
import { loadDefaults, saveDefaults, EFFORT_THINKING_TOKENS } from "../settings/defaults";
import type { ApiClient } from "../api/client";
import type { SessionMeta } from "../types/server";

export interface ChatViewProps {
  session: SessionMeta;
  api: ApiClient;
  token: string | undefined;
}

export function ChatView({ session, api, token }: ChatViewProps) {
  const applyFrames = useStore((s) => s.applyFrames);
  const resetSession = useStore((s) => s.resetSession);
  const view = useStore((s) => s.views[session.id]);
  const sessions = useStore((s) => s.sessions);
  const setSessions = useStore((s) => s.setSessions);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

        {/* Active client-side auto-allow rules (per session) with a way to clear each one. */}
        {autoAllow.size > 0 && (
          <div
            style={{
              padding: "var(--sp-3) var(--sp-4)",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "var(--sp-3)",
              color: "var(--text-muted)",
              fontSize: "var(--fs-sm)",
            }}
          >
            <span>Auto-allow (this session):</span>
            {[...autoAllow].map((tool) => (
              <span key={tool} style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
                <Mono>{tool}</Mono>
                <Button
                  variant="ghost"
                  aria-label={`Clear auto-allow for ${tool}`}
                  onClick={() =>
                    setAutoAllow((prev) => {
                      const next = new Set(prev);
                      next.delete(tool);
                      return next;
                    })
                  }
                >
                  Clear
                </Button>
              </span>
            ))}
          </div>
        )}

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
      <Composer
        onSend={(frame) => send(frame)}
        onUploadFile={async (file) => {
          await api.uploadFile(session.cwd, file);
        }}
      />
      {settingsOpen && (
        <SettingsPanel
          session={session}
          defaults={loadDefaults()}
          onSaveDefaults={(d) => {
            saveDefaults(d);
            setSettingsOpen(false);
          }}
          onStopSession={async (id) => {
            await api.stopSession(id);
            setSessions(sessions.map((s) => (s.id === id ? { ...s, status: "stopped" } : s)));
            setSettingsOpen(false);
          }}
          onApplyLiveSettings={({ model, effort, permissionMode }) => {
            const maxThinkingTokens = effort ? EFFORT_THINKING_TOKENS[effort] : undefined;
            send({ type: "settings", model, effort, maxThinkingTokens, permissionMode });
            // Optimistically reflect into the session list so the header/meta update immediately.
            // effort (set_max_thinking_tokens) has no wire echo, so this is the only source of truth
            // for the displayed effort; model/permissionMode would also reconcile on the next
            // system/init, but reflecting now keeps the UI responsive.
            setSessions(
              sessions.map((s) => (s.id === session.id ? { ...s, model: model ?? s.model, effort: effort ?? s.effort } : s)),
            );
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
