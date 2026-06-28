import { useCallback, useEffect, useRef, useState } from "react";
import { ChatHeader } from "./ChatHeader";
import { ChatTelemetry } from "./ChatTelemetry";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { RewindSheet } from "./RewindSheet";
import type { RewindMode } from "./RewindSheet";
import { PermissionPrompt } from "./PermissionPrompt";
import { QuestionPrompt } from "./QuestionPrompt";
import { AutoAllowChip } from "./AutoAllowChip";
import { Icon } from "../ui/Icon";
import { SubagentTray } from "./SubagentTray";
import { SubagentView } from "./SubagentView";
import { isSlashCommand } from "./slash";
import { useStore } from "../store/store";
import { useSessionSocket } from "../session/use-session-socket";
import { wireStateForSession } from "../session/status";
import { emptyView } from "../store/frame-reducer";
import { SettingsPanel } from "../settings/SettingsPanel";
import { loadDefaults, saveDefaults, EFFORT_THINKING_TOKENS } from "../settings/defaults";
import { enablePush, disablePush, currentPushState } from "../pwa/push";
import type { ApiClient } from "../api/client";
import type { ContentBlock, ModelInfo, QuestionPayload, SessionMeta } from "../types/server";

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
  /** Available models for the per-session model picker — fed from App's fetched list. */
  models?: ModelInfo[];
}

export function ChatView({
  session,
  api,
  token,
  onSlashCommand,
  onClose,
  onShowSessions,
  needsYou,
  models = [],
}: ChatViewProps) {
  const loadHistory = useStore((s) => s.loadHistory);
  const resetSession = useStore((s) => s.resetSession);
  const setCompacting = useStore((s) => s.setCompacting);
  const view = useStore((s) => s.views[session.id]);
  const sessions = useStore((s) => s.sessions);
  const setSessions = useStore((s) => s.setSessions);
  const appendUserMessage = useStore((s) => s.appendUserMessage);
  const clearPending = useStore((s) => s.clearPending);
  const markAwaitingReply = useStore((s) => s.markAwaitingReply);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // REWIND / CHECKPOINT: the checkpoint a user tapped "rewind to here" on (the user-message uuid). When
  // set, the confirm sheet is open for that checkpoint; confirming sends a `rewind` frame and the
  // server-emitted `rewound` frame drives the marker + (for conversation/both) the display truncation.
  const [rewindTarget, setRewindTarget] = useState<string | undefined>(undefined);
  // SUBAGENTS: the drill-in target (the Agent tool_use id == SubagentThread key). When set, the
  // SubagentView sheet navigation STACK (its live chat, task, and result). Opening a NESTED subagent
  // pushes; Back pops to the parent subagent (or closes when empty) instead of jumping straight to chat.
  const [subagentStack, setSubagentStack] = useState<string[]>([]);
  const openSubagentId = subagentStack.length > 0 ? subagentStack[subagentStack.length - 1]! : null;
  // Reflect the device's current push-subscription state in Settings. No permission is requested
  // here — `currentPushState` only reads the existing subscription (the opt-in is a deliberate tap).
  const [pushState, setPushState] = useState<"subscribed" | "unsubscribed" | "unsupported" | "denied">("unsubscribed");
  useEffect(() => {
    void currentPushState().then(setPushState);
  }, []);

  // Load the FULL transcript history BEFORE opening the live socket, so the socket resumes from the
  // server's `sinceSeq` (set as the view's lastSeq) rather than re-replaying the buffer. `historyLoaded`
  // gates the WS connect so the first connection already carries `?since=sinceSeq` — the buffer frames
  // (seq ≤ sinceSeq) are skipped and only NEW live frames (seq > sinceSeq) arrive, with no double
  // display and no dropped updates. A load failure still flips the gate so live frames flow over WS.
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // The server returns only the most-recent window by default (fast open); `truncated` means older turns
  // exist behind a "load earlier" tap. `loadingEarlier` covers the explicit full re-fetch.
  const [truncated, setTruncated] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Bumped when the socket reports a `resync` (the reconnect buffer rotated past us). It re-runs the
  // history-load effect below, refetching the authoritative transcript so a long-disconnect gap can never
  // leave the conversation silently missing frames.
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setHistoryLoaded(false);
    setTruncated(false);
    resetSession(session.id);
    api
      .getSession(session.id)
      .then(({ history, sinceSeq, truncated: more, live }) => {
        if (cancelled) return;
        // Seed wire state + context meter from the server's live tail so a switched-to chat shows the
        // real "working"/usage immediately instead of a wrong "idle" + a blank meter.
        loadHistory(session.id, history, sinceSeq, live);
        setTruncated(more);
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
  }, [session.id, api, loadHistory, resetSession, reloadNonce]);

  // Explicit "load earlier": re-fetch the FULL transcript (accepting the slower load only when the user
  // asks for it) and replace the windowed view. The WS resume seq is unchanged, so live frames are
  // unaffected. Guard against the session changing mid-fetch.
  const loadEarlier = useCallback(() => {
    setLoadingEarlier(true);
    const id = session.id;
    api
      .getSession(id, { full: true })
      .then(({ history, sinceSeq, truncated: more, live }) => {
        loadHistory(id, history, sinceSeq, live);
        setTruncated(more);
      })
      .catch(() => {
        // leave the windowed view in place on failure
      })
      .finally(() => setLoadingEarlier(false));
  }, [api, session.id, loadHistory]);

  // Open the live socket AFTER history loads (frames flow into the store via the hook). Gating on
  // `historyLoaded` guarantees the socket's `getSince` reads the lastSeq = sinceSeq we just set. A
  // `resync` from the server bumps `reloadNonce`, re-running the history effect (authoritative refetch).
  const { send, status } = useSessionSocket(session, token, historyLoaded, () => setReloadNonce((n) => n + 1));
  // Surface a live "Reconnecting…" state once the socket has been open at least once and then dropped —
  // the terminal shows connection state; without this a silently-dropped link looked like Claude had
  // just gone quiet. (The first connect is "connecting" but not yet "ever open", so it doesn't flash.)
  const everOpenRef = useRef(false);
  useEffect(() => {
    if (status === "open") {
      everOpenRef.current = true;
      // The socket just (re)opened and flushed any buffered sends → those bubbles are delivered now, so
      // clear their "Sending…" immediately rather than waiting for each CLI echo.
      clearPending(session.id);
    }
  }, [status, session.id, clearPending]);
  const reconnecting = everOpenRef.current && status !== "open";

  const wireState = wireStateForSession(session, view);
  const safeView = view ?? emptyView();

  // "Running" = a turn is actively in flight (thinking / streaming / running a tool), which swaps the
  // composer's Send for a Stop. It reads the META-AWARE wireState, NOT the raw view wireState: a
  // reopened DORMANT/stopped session whose last turn never settled with a `result` leaves the view
  // stuck at a running state — but the session isn't actually live, so it must NOT show Stop (and must
  // let the user type). `wireStateForSession` collapses dormant→"dormant", stopped→"idle",
  // awaiting→"awaiting" (none of which are "running"), and only defers to the live view's wire state
  // for a genuinely-running session — so a live turn still shows Stop.
  const running = wireState === "thinking" || wireState === "streaming" || wireState === "running-tool";

  // Client-side "Always allow" — a per-session set of tool names the user has chosen to auto-allow.
  // When a future permission for such a tool arrives we answer `allow` for the user (with a visible
  // indicator + a way to clear the rule). This lives in component state (this session, this device);
  // it is intentionally NOT persisted — the gate is a security boundary and a fresh load re-prompts.
  const [autoAllow, setAutoAllow] = useState<Set<string>>(() => new Set());
  // requestIds we've already answered. Tracked in state so answering hides the prompt immediately
  // (optimistic) rather than lingering until the next server frame clears `pendingPermission`; the
  // ref guards against double-sending the same decision across re-renders / auto-allow.
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  // answeredRef owns the SYNCHRONOUS dedup set — NEVER alias it to the React state object (mutating that
  // in place is a state-mutation footgun). markAnswered mutates the ref + mirrors it into state (for the
  // render); unmarkAnswered reverses it (the dropped-answer safety net re-shows a still-pending prompt).
  const answeredRef = useRef<Set<string>>(new Set());
  const markAnswered = useCallback((requestId: string) => {
    answeredRef.current.add(requestId);
    setAnswered(new Set(answeredRef.current));
  }, []);
  const unmarkAnswered = useCallback((requestId: string) => {
    answeredRef.current.delete(requestId);
    setAnswered(new Set(answeredRef.current));
  }, []);

  const answer = useCallback(
    (requestId: string, decision: "allow" | "deny") => {
      if (answeredRef.current.has(requestId)) return;
      markAnswered(requestId);
      send({ type: "permission", requestId, decision });
    },
    [send, markAnswered],
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
      markAnswered(q.requestId);
      if (q.askId) send({ type: "answer", askId: q.askId, answers });
      else send({ type: "answer", requestId: q.requestId, toolInput: q.toolInput, answers });
    },
    [send, markAnswered],
  );
  const cancelQuestion = useCallback(
    (q: QuestionPayload) => {
      if (answeredRef.current.has(q.requestId)) return;
      markAnswered(q.requestId);
      // ask_user: resolve the held request with an empty answer map (the server interprets "no
      // selection" as declined and the MCP tool returns "User answered (no selection)."), so the
      // long-poll never hangs. Legacy built-in path: deny the question (the CLI proceeds with denial).
      if (q.askId) send({ type: "answer", askId: q.askId, answers: {} });
      else send({ type: "permission", requestId: q.requestId, decision: "deny" });
    },
    [send, markAnswered],
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

  // Safety net for a DROPPED answer (question OR permission): when we optimistically mark a prompt
  // answered, the server normally clears it fast (a `resolve` frame). If it doesn't within the grace
  // window — a lost WS send, a server restart mid-answer — the prompt is STILL pending server-side, so
  // un-mark it and re-show it rather than leaving the user stuck on a silently-swallowed submit. A
  // re-answer is harmless (the server treats a duplicate as a no-op). The normal path clears the pending
  // prompt first, so this never fires then.
  useEffect(() => {
    const stuck = [pending?.requestId, pendingQuestion?.requestId].filter(
      (id): id is string => id !== undefined && answered.has(id),
    );
    if (stuck.length === 0) return;
    const t = setTimeout(() => stuck.forEach(unmarkAnswered), 8000);
    return () => clearTimeout(t);
  }, [pending, pendingQuestion, answered, unmarkAnswered]);

  // Keep `answered` BOUNDED: once nothing is pending (every prompt resolved), the accumulated requestIds
  // are dead weight — clear them. requestIds are unique uuids, so a future prompt is never falsely deduped
  // against a cleared one. Without this the set grows for the lifetime of a long-lived session view.
  useEffect(() => {
    if (!pending && !pendingQuestion && answeredRef.current.size > 0) {
      answeredRef.current.clear();
      setAnswered(new Set());
    }
  }, [pending, pendingQuestion]);

  // Auto-scroll the log to the newest content as turns/streaming text grow — unless the user has
  // scrolled up to read history (then we leave their position alone). A small slack avoids
  // sub-pixel jitter at the bottom counting as "scrolled up".
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  // Mirror the pinned state into render state so a "jump to latest" affordance can appear when the user
  // has scrolled up (and disappear once they're back at the bottom). Only flips on a real change so an
  // ordinary scroll doesn't churn renders.
  const [atBottom, setAtBottom] = useState(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distanceFromBottom < 64;
    pinnedToBottom.current = next;
    setAtBottom((prev) => (prev === next ? prev : next));
  }

  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedToBottom.current = true;
    setAtBottom(true);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
    // Include the pending prompts: a permission/question card appears WITHOUT a new turn, so without these
    // deps a gate could render below the fold and only show as "Awaiting you" in the telemetry strip.
  }, [
    safeView.turns.length,
    safeView.liveText,
    safeView.thinkingText,
    safeView.pendingPermission,
    safeView.pendingQuestion,
  ]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ChatHeader
        session={session}
        onOpenSettings={() => setSettingsOpen(true)}
        onShowSessions={onShowSessions}
        needsYou={needsYou}
      />
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          aria-live="polite"
          // "additions" only (not "text"): a completed turn announces ONCE as it's added; without this,
          // every stream delta re-announced the whole growing message token-by-token. The telemetry strip
          // (role=status) carries the live Thinking/Streaming state.
          aria-relevant="additions"
          style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}
        >
          {/* While the (windowed) history loads, show a quiet placeholder instead of a blank panel. */}
          {!historyLoaded && (
            <div
              role="status"
              style={{
                display: "grid",
                placeItems: "center",
                minHeight: 120,
                padding: "var(--sp-6) var(--sp-4)",
                color: "var(--text-faint)",
                fontSize: "var(--fs-sm)",
              }}
            >
              Loading conversation…
            </div>
          )}
          {/* Older turns were trimmed for a fast open — one tap pulls the full transcript. */}
          {historyLoaded && truncated && (
            <div style={{ display: "grid", placeItems: "center", padding: "var(--sp-3) var(--sp-4)" }}>
              <button
                type="button"
                onClick={loadEarlier}
                disabled={loadingEarlier}
                style={{
                  minHeight: "var(--tap-min)",
                  padding: "0 var(--sp-4)",
                  borderRadius: "var(--radius-pill)",
                  border: "1px solid var(--border)",
                  background: "var(--surface-2)",
                  color: "var(--text-muted)",
                  font: "inherit",
                  fontSize: "var(--fs-sm)",
                  cursor: loadingEarlier ? "default" : "pointer",
                  opacity: loadingEarlier ? 0.6 : 1,
                }}
              >
                {loadingEarlier ? "Loading earlier messages…" : "Load earlier messages"}
              </button>
            </div>
          )}
          <MessageList
            view={safeView}
            downloadUrl={(path) => api.downloadUrl(path)}
            imageUrl={(url) => api.mediaUrl(url)}
            onRewind={(checkpointId) => setRewindTarget(checkpointId)}
            onOpenSubagent={(id) => setSubagentStack([id])}
          />

          {/* The pending permission gate. Hidden once answered (optimistic) or while it is being
            auto-allowed (a rule already covers it). */}
          {pending && !isAutoAllowed && !pendingAnswered && (
            <div style={{ padding: "var(--sp-4)" }}>
              <PermissionPrompt
                permission={pending}
                permissionMode={session.permissionMode}
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
                key={pendingQuestion.requestId}
                question={pendingQuestion}
                onAnswer={(answers) => answerQuestion(pendingQuestion, answers)}
                onCancel={() => cancelQuestion(pendingQuestion)}
              />
            </div>
          )}
          {/* Jump to latest: when the user has scrolled up to read history, a floating pill returns them to
            the live tail (the terminal always shows the newest). Hidden while pinned to the bottom. */}
          {!atBottom && (
            <button
              type="button"
              onClick={jumpToLatest}
              aria-label="Jump to latest"
              style={{
                position: "absolute",
                bottom: "var(--sp-3)",
                left: "50%",
                transform: "translateX(-50%)",
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--sp-1)",
                minHeight: "36px",
                padding: "0 var(--sp-3)",
                borderRadius: "var(--radius-pill)",
                background: "var(--surface-2)",
                border: "1px solid var(--border-strong)",
                color: "var(--text)",
                fontSize: "var(--fs-sm)",
                fontFamily: "var(--font-display)",
                fontWeight: 600,
                cursor: "pointer",
                boxShadow: "var(--shadow-card)",
              }}
            >
              <Icon name="arrow-up" size={14} style={{ transform: "rotate(180deg)" }} />
              Latest
            </button>
          )}
        </div>
      </div>
      {/* SUBAGENT TRAY — a slim strip directly above the composer (renders nothing when there are no
          subagents). Tap a chip to open that subagent's drill-in view. */}
      <SubagentTray
        subagents={safeView.subagents}
        subagentOrder={safeView.subagentOrder}
        onOpen={(id) => setSubagentStack([id])}
      />
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
      {/* TELEMETRY STRIP — the live model state + the context meter, pinned right above the composer so
          a sent message visibly gets a reaction without looking up to the header. */}
      <ChatTelemetry
        wireState={wireState}
        // `view.usage` is the durable meter source: contextTokens is the CURRENT occupancy (per-turn
        // assistant usage), contextWindow the authoritative denominator — both seeded on switch and
        // updated live, so the meter shows immediately and reads correctly even on a long chat.
        contextTokens={safeView.usage?.contextTokens}
        contextWindow={safeView.usage?.contextWindow}
        model={session.model}
        // Show "Compacting…" the whole time a /compact is in flight. NOT gated on `running`: a /compact
        // emits no streaming/tool frames, so the wire never enters a working state — gating on it hid the
        // indicator. The flag is driven by the authoritative wire signal `system status:"compacting"` (set
        // in the reducer, fires for ANY trigger origin) and cleared when the compaction ends.
        compacting={safeView.compacting}
        // "Reconnecting…" while the live link is down (after having been up) — the session keeps running
        // on the host; this just tells the user the phone is re-establishing the stream.
        reconnecting={reconnecting}
        // Cumulative session cost (always-visible /cost parity), from the latest result.
        cost={safeView.lastResult?.totalCostUsd}
        // Bridge the send→first-frame gap with an instant "Thinking…" (cleared once Claude engages).
        awaitingReply={safeView.awaitingReply}
      />
      <Composer
        commands={safeView.commands}
        onSend={(frame) => {
          // Deliver FIRST so the bubble's state reflects whether the frame actually made the wire
          // (delivered) or had to be buffered (still "Sending…"). claude does not echo the typed user
          // text back as a render-able turn, so we also show it optimistically below.
          const delivered = send(frame);
          if (frame.type === "user") {
            const blocks: ContentBlock[] = [];
            if (frame.text) blocks.push({ type: "text", text: frame.text });
            // Images were uploaded to the store; the optimistic bubble renders them from `/images/<ref>`
            // (file-served, no base64) — same source the reopen history ships, so it stays consistent.
            for (const ref of frame.imageRefs ?? []) {
              blocks.push({ type: "image", source: { type: "url", url: `/images/${ref}` } });
            }
            // While Claude is BUSY (a turn running OR a /compact in progress) the CLI queues this for after
            // it finishes — mark the bubble `queued` so it renders BELOW the live stream (correct order) and
            // shows a "Queued" state until its echo reconciles it. EXCEPT a slash command (e.g. /compact):
            // the CLI never echoes it back, so a queued bubble would never reconcile and would stay stuck.
            const busy = running || safeView.compacting === true;
            const isSlash = isSlashCommand(frame.text);
            // queued = delivered to the server but Claude is busy (→ "Queued", below the live stream);
            // pending = NOT delivered yet, buffered for reconnect (→ "Sending…"). A delivered + idle send
            // shows NO per-message indicator — the bubble appears and the telemetry "Thinking…" is the
            // "Claude is on it" signal. This is the fix for the stuck "Sending…": the label no longer waits
            // for the CLI echo (which only arrives when Claude finishes the *previous* turn).
            if (blocks.length > 0)
              appendUserMessage(session.id, blocks, delivered && busy && !isSlash, !delivered && !isSlash);
            // A delivered, idle (not queued behind a turn), non-slash message → bridge the send→first-frame
            // gap with an instant "Thinking…" (the model is spinning up). Not for a slash (may never reply),
            // a buffered send (shows "Sending…"), or a queued one (the wire is already working).
            if (delivered && !isSlash && !busy && blocks.length > 0) markAwaitingReply(session.id);
            // Optimistic instant feedback for a composer-sent /compact: flag compacting right away so the
            // indicator shows before the wire's `status:"compacting"` arrives. The wire signal (reducer) is
            // the authoritative source that ALSO covers a /compact triggered outside the composer.
            if (frame.text?.trim() === "/compact") setCompacting(session.id, true);
          }
        }}
        onUploadFile={async (file) => {
          await api.uploadFile(session.cwd, file);
        }}
        onUploadImage={(file) => api.uploadImage(file)}
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
          onApplyLiveSettings={({ model, effort, permissionMode, dangerouslySkip }) => {
            const maxThinkingTokens = effort ? EFFORT_THINKING_TOKENS[effort] : undefined;
            send({ type: "settings", model, effort, maxThinkingTokens, permissionMode, dangerouslySkip });
            // Optimistically reflect into the session list so the header/meta update immediately.
            // effort (set_max_thinking_tokens) has no wire echo, so this is the only source of truth
            // for the displayed effort; model/permissionMode/dangerouslySkip would also reconcile on the
            // next system/init (a dangerouslySkip change respawns the session), but reflecting now keeps
            // the UI responsive.
            setSessions(
              sessions.map((s) =>
                s.id === session.id
                  ? {
                      ...s,
                      model: model ?? s.model,
                      effort: effort ?? s.effort,
                      permissionMode: permissionMode ?? s.permissionMode,
                      dangerouslySkip: dangerouslySkip ?? s.dangerouslySkip,
                    }
                  : s,
              ),
            );
            setSettingsOpen(false);
          }}
          pushState={pushState}
          onEnablePush={async () => {
            // enablePush can reject (denied permission, VAPID fetch, subscribe) — catch so it doesn't
            // become an unhandled rejection and the toggle reflects the real (unsubscribed) state.
            try {
              const result = await enablePush(api);
              // Surface "denied" (not just "unsubscribed") so the panel explains the blocked state.
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
          models={models}
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
      {/* SUBAGENT DRILL-IN — the full-bleed sheet for the open subagent. Guarded on the thread still
          existing (a vanished registry entry closes the sheet rather than rendering empty). */}
      {openSubagentId !== null && safeView.subagents[openSubagentId] && (
        <SubagentView
          // key per subagent: drilling into a NESTED subagent (or Back) REMOUNTS the sheet, so the focus
          // trap re-runs (focus moves into the new view, not stranded on body) and the body scroll resets
          // to the top instead of inheriting the previous view's position.
          key={openSubagentId}
          thread={safeView.subagents[openSubagentId]!}
          subagents={safeView.subagents}
          onOpenSubagent={(id) => setSubagentStack((s) => [...s, id])}
          onClose={() => setSubagentStack((s) => s.slice(0, -1))}
          downloadUrl={(path) => api.downloadUrl(path)}
        />
      )}
    </div>
  );
}
