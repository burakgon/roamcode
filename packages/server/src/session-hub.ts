import { randomUUID } from "node:crypto";
import { SessionManager } from "./session-manager.js";
import { ReplayBuffer } from "./replay-buffer.js";
import type { ServerFrame, ServerFrameKind } from "./replay-buffer.js";
import type { CreateSessionOptions } from "./session-manager.js";
import type {
  ClaudeProcess,
  PermissionEvent,
  QuestionEvent,
  DiagnosticEvent,
  RewindFilesResult,
} from "./claude-process.js";
import type { AttachmentPayload } from "./fs-service.js";
import type {
  ContentBlock,
  HookPermissionDecision,
  InboundEvent,
  QuestionSpec,
  ResultEvent,
} from "@remote-coder/protocol";
import type { SessionStore } from "./session-store.js";
import type { HistoryService } from "./history-service.js";

export type SessionStatus = "running" | "dormant" | "errored" | "stopped";

/**
 * Decide whether a claude process `exit` was clean (→ dormant, resumable) or a failure (→ errored),
 * from its `{ code, signal }`. Clean = a 0 exit code, OR a graceful kill signal (SIGTERM/SIGINT/
 * SIGHUP — what our own stop() and a host shutdown send). A non-zero exit code, or a crash signal
 * (SIGKILL/SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE), is a real failure. This only governs SELF-driven
 * exits; a stop we initiated (intentionalStop) bypasses this entirely.
 */
function isCleanExit(info: { code: number | null; signal: NodeJS.Signals | null }): boolean {
  if (info.signal) return info.signal === "SIGTERM" || info.signal === "SIGINT" || info.signal === "SIGHUP";
  // code === 0 → clean; non-zero → failure. A null code with no signal shouldn't happen, but treat
  // it as clean (no evidence of a crash) so a quirky-but-harmless exit doesn't flag red.
  return info.code === null || info.code === 0;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  model?: string;
  effort?: string;
  dangerouslySkip: boolean;
  status: SessionStatus;
  createdAt: number;
  permissionMode?: string;
  /**
   * TRUE while a permission OR AskUserQuestion is pending for this session and the user hasn't
   * answered/cancelled it yet. Lets the UI show a "needs you" badge for sessions the client isn't
   * actively connected to. Transient (never persisted): a session rehydrated from the store at boot
   * is always `awaiting:false`. Set when the hub emits a permission/question frame; cleared on the
   * answer/cancel paths and defensively on the next `result`/turn.
   */
  awaiting: boolean;
  /**
   * Wall-clock ms of the last real conversation activity (user send OR assistant/result frame),
   * mirrored from the store's `last_activity_at` so the client can sort by real activity. Monotonic
   * across a session's life.
   */
  lastActivityAt: number;
}

export interface LiveSettings {
  model?: string;
  /** Thinking-token budget (the PWA's effort maps onto this). */
  maxThinkingTokens?: number;
  /** Optional human label for the effort the maxThinkingTokens came from, mirrored into meta.effort. */
  effort?: string;
  permissionMode?: string;
}

export type FrameListener = (frame: ServerFrame) => void;

export interface Subscription {
  unsubscribe(): void;
}

/** A per-question answer map: question text -> a chosen label / custom "Other" text, or many (multi-select). */
export type AskAnswers = Record<string, string | string[]>;

/**
 * Result of an `ask_user` round-trip. `cancelled: true` (with no answers) means the user dismissed the
 * prompt, the ask timed out, or the session stopped while waiting; otherwise `answers` holds the user's
 * selections keyed by question text. The MCP tool maps this to a text tool-result for Claude.
 */
export type AskResult = { answers: AskAnswers } | { cancelled: true };

/** Pending `ask_user` request awaiting a web answer: how to resolve it, and the timer to clear on resolve. */
interface PendingAsk {
  resolve: (result: AskResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Default time (ms) the server holds an `ask_user` request open before giving up and cancelling it. */
export const ASK_TIMEOUT_MS = 10 * 60 * 1000;

interface SessionRecord {
  meta: SessionMeta;
  buffer: ReplayBuffer;
  listeners: Set<FrameListener>;
  /**
   * SECURITY: the original `tool_input` the CLI sent with each AskUserQuestion, keyed by requestId,
   * captured when the hub emitted the "question" frame. answerQuestion uses THIS value — never a
   * client-echoed one — so a client cannot smuggle a tampered tool_input back into the CLI.
   */
  questionToolInputs: Map<string, unknown>;
  /**
   * RequestIds of permissions/questions currently awaiting a user answer for this session. `awaiting`
   * is `pending.size > 0`; tracking the set (not a bare counter) keeps it correct when several
   * prompts are open at once and one is answered. Cleared wholesale on a `result`/turn boundary.
   */
  pending: Set<string>;
  /**
   * In-flight `ask_user` requests for this session, keyed by askId. Each is a Promise the POST /ask
   * route awaits; it resolves when a matching WS answer arrives, when the ask times out, or when the
   * session stops (cancelled). Rejected/leaked timers are why deleteSession/stopAll drain this map.
   */
  pendingAsks: Map<string, PendingAsk>;
  /**
   * Set TRUE by deleteSession/stopAll BEFORE the child is killed, so the `exit` handler can tell a
   * deliberate stop (→ dormant/removed, NOT an error) from a real crash. Reset on a fresh resume.
   */
  intentionalStop: boolean;
}

export interface SessionHubOptions {
  replayCapacity?: number;
  now?: () => number;
  store?: SessionStore;
  history?: HistoryService;
  /**
   * Observe every emitted frame (push-trigger seam). Invoked AFTER the WS listener fan-out so a push
   * dispatcher sees result/permission/question frames without coupling to the WS layer. Must never
   * throw (it is wrapped in a try/catch here so a push failure can't unwind the claude emit).
   */
  onFrame?: (sessionId: string, frame: ServerFrame) => void;
}

export class SessionHub {
  private readonly manager: SessionManager;
  private readonly replayCapacity: number;
  private readonly now: () => number;
  private readonly store?: SessionStore;
  private readonly history?: HistoryService;
  private readonly onFrame?: (sessionId: string, frame: ServerFrame) => void;
  private readonly records = new Map<string, SessionRecord>();
  /**
   * Per-id in-flight resume promises (mirrors transport.ts's idempotency `inFlight` map). Guards the
   * resume window: between the moment ensureLive sees the session as dormant and the moment the
   * manager registers the live process, two overlapping ensureLive(id) calls would BOTH spawn
   * `claude --resume <id>` — leaking one process and double-registering listeners. Memoizing the
   * promise per id collapses concurrent callers onto a single resume; the key is released in a
   * `finally` so a FAILED resume can be retried by a later message.
   */
  private readonly resumeInFlight = new Map<string, Promise<void>>();

  constructor(manager: SessionManager, opts: SessionHubOptions = {}) {
    this.manager = manager;
    this.replayCapacity = opts.replayCapacity ?? 200;
    this.now = opts.now ?? Date.now;
    this.store = opts.store;
    this.history = opts.history;
    this.onFrame = opts.onFrame;
  }

  async createSession(opts: CreateSessionOptions): Promise<SessionMeta> {
    const session = await this.manager.createSession(opts);
    const now = this.now();
    const meta: SessionMeta = {
      id: session.id,
      cwd: session.cwd,
      model: opts.model,
      effort: opts.effort,
      dangerouslySkip: opts.dangerouslySkip ?? false,
      status: "running",
      createdAt: now,
      permissionMode: opts.dangerouslySkip ? "bypassPermissions" : "default",
      awaiting: false,
      lastActivityAt: now,
    };
    const record: SessionRecord = {
      meta,
      buffer: new ReplayBuffer(this.replayCapacity),
      listeners: new Set(),
      questionToolInputs: new Map(),
      pending: new Set(),
      pendingAsks: new Map(),
      intentionalStop: false,
    };
    this.records.set(session.id, record);
    this.attach(session.process, record);
    this.persist(meta);
    return meta;
  }

  /**
   * Resume a PAST claude session (the `claude --resume` equivalent). Spawns `claude --resume <id>` in
   * `opts.cwd` registered under the SAME id, and PRE-LOADS the parsed transcript frames into that
   * session's replay buffer so a WS client connecting sees the full prior conversation; live
   * continuation then appends after it. The transcript frames seed the buffer ONLY (they are not
   * fanned out to the push seam — there is nothing new to notify about) so reconnecting clients replay
   * exactly-once history.
   *
   * Dup-history guard: a `claude --resume` in stream-json mode does NOT re-emit the prior transcript as
   * events — it emits only the synthetic warm-up pair (already suppressed in claude-process.ts) and then
   * live continuation. So injecting the parsed transcript here yields history EXACTLY ONCE.
   *
   * Idempotency: resuming an already-live id just returns its existing meta (no second spawn, no
   * re-seeded buffer).
   */
  async resumeFromTranscript(opts: {
    sessionId: string;
    cwd: string;
    model?: string;
    effort?: string;
    dangerouslySkip?: boolean;
    frames: ServerFrame[];
  }): Promise<SessionMeta> {
    const existing = this.records.get(opts.sessionId);
    if (existing && this.manager.getSession(opts.sessionId)) return existing.meta;

    const session = await this.manager.createSession({
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      dangerouslySkip: opts.dangerouslySkip,
      resumeId: opts.sessionId,
    });
    const now = this.now();
    const meta: SessionMeta = {
      id: session.id,
      cwd: session.cwd,
      model: opts.model,
      effort: opts.effort,
      dangerouslySkip: opts.dangerouslySkip ?? false,
      status: "running",
      createdAt: now,
      permissionMode: opts.dangerouslySkip ? "bypassPermissions" : "default",
      awaiting: false,
      lastActivityAt: now,
    };
    const buffer = new ReplayBuffer(this.replayCapacity);
    // Seed the buffer with the prior conversation (each push assigns a contiguous seq), so any client
    // that connects replays the full history BEFORE live continuation frames.
    for (const frame of opts.frames) buffer.push(frame.kind, frame.payload);
    const record: SessionRecord = {
      meta,
      buffer,
      listeners: new Set(),
      questionToolInputs: new Map(),
      pending: new Set(),
      pendingAsks: new Map(),
      intentionalStop: false,
    };
    this.records.set(session.id, record);
    this.attach(session.process, record);
    this.persist(meta);
    return meta;
  }

  /**
   * Push a frame into a session's buffer and fan it out to live subscribers + the onFrame seam.
   * The single seq/emit/replay path shared by claude-driven frames AND server-injected ones
   * (e.g. an attachment): a frame pushed here is delivered live AND buffered for reconnect.
   */
  private emitFrame(record: SessionRecord, kind: ServerFrameKind, payload: unknown): ServerFrame {
    const frame = record.buffer.push(kind, payload);
    for (const listener of record.listeners) listener(frame);
    if (this.onFrame) {
      try {
        this.onFrame(record.meta.id, frame);
      } catch {
        // a push-dispatch error must never unwind the claude process emit (spec §10)
      }
    }
    return frame;
  }

  /**
   * Inject an `attachment` frame (Claude sent a file to the chat via the mcp-send tool, relayed by
   * POST /sessions/:id/attach). Goes through the SAME seq/emit/replay-buffer path as claude frames,
   * so connected clients get it live AND it survives a WS reconnect (attachment is a critical kind).
   */
  pushAttachment(id: string, payload: AttachmentPayload): ServerFrame {
    const record = this.require(id);
    return this.emitFrame(record, "attachment", payload);
  }

  /**
   * Surface an `ask_user` multiple-choice question to the web UI and WAIT for the user's answer. This
   * backs the `mcp__remote-coder__ask_user` tool (POST /sessions/:id/ask, held open by the caller).
   *
   * Generates an `askId`, records a pending {askId → resolve} on the session, then emits a `question`
   * frame carrying that askId + the questions (reusing the existing critical/replayable `question` kind
   * so the web QuestionPrompt renders it and it survives a WS reconnect). The returned Promise resolves
   * when the web answers (answerAsk, matched by askId), after a {@link ASK_TIMEOUT_MS} timeout, or when
   * the session stops (cancelAllAsks) — always to an AskResult, never rejects, so the held HTTP request
   * and the MCP tool can always complete. `requestId` mirrors `askId` so the unchanged web reducer (which
   * keys pendingQuestion on `requestId`) renders it; the explicit `askId` routes the answer back here.
   */
  askUser(id: string, questions: QuestionSpec[]): Promise<AskResult> {
    const record = this.require(id);
    const askId = `ask-${randomUUID()}`;
    return new Promise<AskResult>((resolve) => {
      const timer = setTimeout(() => {
        // Timed out: the user never answered. Drop the pending entry and report cancellation so the
        // held POST /ask responds and the MCP tool returns rather than hanging forever.
        if (record.pendingAsks.delete(askId)) this.setAwaiting(record, askId, false);
        resolve({ cancelled: true });
      }, ASK_TIMEOUT_MS);
      // Don't let a pending ask-timer keep the process alive on shutdown (the timer is cleared on
      // answer/cancel anyway). `unref` is unavailable on some timer mocks — guard it.
      timer.unref?.();
      record.pendingAsks.set(askId, { resolve, timer });
      this.setAwaiting(record, askId, true);
      this.emitFrame(record, "question", { requestId: askId, askId, toolInput: { questions }, questions });
    });
  }

  /**
   * Resolve a pending `ask_user` with the user's selections (the WS inbound `answer` path routes here
   * when the message carries a matching `askId`). Clears the timeout + pending entry and recomputes
   * `awaiting`. Returns false for an unknown/already-resolved askId (stale or duplicate answer) so the
   * caller can fall through to the legacy built-in-question path.
   */
  answerAsk(id: string, askId: string, answers: AskAnswers): boolean {
    const record = this.records.get(id);
    const pending = record?.pendingAsks.get(askId);
    if (!record || !pending) return false;
    clearTimeout(pending.timer);
    record.pendingAsks.delete(askId);
    this.setAwaiting(record, askId, false);
    pending.resolve({ answers });
    return true;
  }

  /** Cancel every pending `ask_user` for a session (stop/delete/exit) so no held request leaks. */
  private cancelAllAsks(record: SessionRecord): void {
    for (const [, pending] of record.pendingAsks) {
      clearTimeout(pending.timer);
      pending.resolve({ cancelled: true });
    }
    record.pendingAsks.clear();
  }

  private attach(proc: ClaudeProcess, record: SessionRecord): void {
    const emit = (kind: ServerFrameKind, payload: unknown) => this.emitFrame(record, kind, payload);
    proc.on("event", (ev: InboundEvent) => {
      // Assistant activity (the CLI streams events as it works) counts as conversation activity for
      // sorting; bump lastActivityAt so a session that's actively responding sorts above an idle one.
      this.markActivity(record);
      emit("event", ev);
    });
    proc.on("permission", (perm: PermissionEvent) => {
      this.setAwaiting(record, perm.requestId, true);
      emit("permission", perm);
    });
    proc.on("question", (q: QuestionEvent) => {
      // SECURITY: remember the CLI's original tool_input for this requestId so answerQuestion
      // replays IT (not a client-echoed value) back into the CLI.
      record.questionToolInputs.set(q.requestId, q.toolInput);
      this.setAwaiting(record, q.requestId, true);
      emit("question", q);
    });
    proc.on("result", (result: ResultEvent) => {
      // A turn finished: nothing is pending anymore (defensive clear in case an answer frame was
      // dropped), and this is real conversation activity.
      this.clearAllAwaiting(record);
      this.markActivity(record);
      emit("result", result);
    });
    proc.on("diagnostic", (diag: DiagnosticEvent) => emit("diagnostic", diag));
    // CRITICAL: Node's EventEmitter throws on an "error" event with no listener.
    // ClaudeProcess.write() emits "error" on write-after-teardown, so every managed
    // process MUST have an "error" listener. Fold it into a diagnostic frame (spec §10).
    proc.on("error", (err: Error) => {
      record.meta.status = "errored";
      this.persist(record.meta);
      emit("diagnostic", { source: "parser", message: err.message } satisfies DiagnosticEvent);
    });
    proc.on("exit", (info) => {
      // A deliberate stop (deleteSession/stopAll) is being torn down separately — don't fight it by
      // flipping to errored. For a self-driven exit: a clean exit (code 0, or a kill signal from a
      // graceful stop) leaves the session DORMANT (resumable, not an error); a non-zero exit code or
      // an unexpected crash signal is a real failure → errored.
      if (!record.intentionalStop && record.meta.status !== "errored") {
        record.meta.status = isCleanExit(info) ? "dormant" : "errored";
        record.meta.awaiting = false;
        record.pending.clear();
        this.persist(record.meta);
      }
      // The child is gone: any `ask_user` still waiting can never be answered now — cancel them so the
      // held POST /ask requests (and the MCP tools) return instead of hanging. (A deliberate stop already
      // drained them in delete/stopAll; this covers a self-driven exit/crash mid-question.)
      this.cancelAllAsks(record);
      emit("exit", info);
    });
  }

  /** Mark a request pending/answered and recompute `meta.awaiting` (true iff anything is pending). */
  private setAwaiting(record: SessionRecord, requestId: string, awaiting: boolean): void {
    if (awaiting) record.pending.add(requestId);
    else record.pending.delete(requestId);
    record.meta.awaiting = record.pending.size > 0;
  }

  /** Clear every pending prompt for a session (turn boundary / exit). */
  private clearAllAwaiting(record: SessionRecord): void {
    record.pending.clear();
    record.meta.awaiting = false;
  }

  /**
   * Bump lastActivityAt (in-memory meta + durable store) to mark real conversation activity.
   * The store write is best-effort: a killed child can flush buffered stdout events AFTER the
   * onClose hook has closed the store ("database connection is not open"), and a touch failing
   * must never unwind the process emit — the in-memory meta is the source of truth for live reads.
   */
  private markActivity(record: SessionRecord): void {
    const at = this.now();
    record.meta.lastActivityAt = at;
    try {
      this.store?.touch(record.meta.id, at);
    } catch {
      // store closed/unavailable — in-memory lastActivityAt already updated; ignore (spec §10)
    }
  }

  listSessions(): SessionMeta[] {
    return [...this.records.values()].map((r) => r.meta);
  }

  getSession(id: string): SessionMeta | undefined {
    return this.records.get(id)?.meta;
  }

  /**
   * Conversation history for a session, plus the seq to resume the live WS from.
   *
   * The on-disk jsonl transcript is the SOURCE OF TRUTH for a reopen: it holds BOTH the user's typed
   * messages (`type:"user"`) and Claude's (`type:"assistant"`), complete and correctly attributed.
   * The in-memory replay buffer does NOT — it's capacity-bounded (older content is evicted) and, in
   * `--input-format stream-json`, Claude never echoes the user's own messages back as events, so they
   * are NOWHERE in the buffer. Reading the buffer as history therefore truncated long conversations
   * and dropped every user message. So:
   *
   *  - When a transcript exists, `history` is built from the FULL transcript (1-based display seqs,
   *    independent of the WS seq space) — every turn, in order, correctly typed.
   *  - `sinceSeq` is the buffer's CURRENT max seq. The client connects the WS with `?since=sinceSeq`
   *    so it replays only NEW frames (seq > sinceSeq) — nothing already shown in the transcript history
   *    is re-rendered, and live frames apply cleanly with no double-display and no dropped updates.
   *  - When there is NO transcript yet (a brand-new session), fall back to the buffer snapshot, whose
   *    frames already carry real WS seqs, so `sinceSeq` is the buffer's max seq.
   */
  async getHistory(id: string): Promise<{ history: ServerFrame[]; sinceSeq: number }> {
    const record = this.require(id);
    const sinceSeq = record.buffer.maxSeq();
    if (this.history) {
      const turns = await this.history.read(record.meta.cwd, id);
      if (turns.length > 0) {
        const history = turns.map<ServerFrame>((t, i) => ({
          // Display seqs are 1-based and contiguous, DISTINCT from the buffer/WS seq space: the client
          // renders these as history but resumes the WS from `sinceSeq` (the buffer's max), so the two
          // seq spaces never collide.
          seq: i + 1,
          kind: "event",
          payload: { type: t.type, message: t.message, uuid: t.uuid, raw: t },
        }));
        return { history, sinceSeq };
      }
    }
    // No transcript (brand-new session, or no HistoryService configured): the buffer is all we have.
    // Its frames already carry real WS seqs, so the client resumes the WS from the same `sinceSeq`.
    return { history: record.buffer.snapshot(), sinceSeq };
  }

  /** Live subscriber count for a session (0 if unknown). Lets the WS layer assert no leak. */
  subscriberCount(id: string): number {
    return this.records.get(id)?.listeners.size ?? 0;
  }

  subscribe(id: string, listener: FrameListener, sinceSeq?: number): Subscription {
    const record = this.require(id);
    // Replay first (spec §10), then go live.
    const replay = sinceSeq === undefined ? record.buffer.snapshot() : record.buffer.since(sinceSeq);
    for (const frame of replay) listener(frame);
    record.listeners.add(listener);
    return {
      unsubscribe: () => {
        record.listeners.delete(listener);
      },
    };
  }

  async sendMessage(id: string, content: string | ContentBlock[]): Promise<void> {
    await this.ensureLive(id);
    this.manager.sendMessage(id, content);
    // User send is conversation activity: bump lastActivityAt (in-memory meta + durable store).
    const record = this.records.get(id);
    if (record) this.markActivity(record);
  }

  async answerPermission(
    id: string,
    requestId: string,
    decision: HookPermissionDecision,
    reason?: string,
  ): Promise<void> {
    await this.ensureLive(id);
    this.manager.answerPermission(id, requestId, decision, reason);
    const record = this.records.get(id);
    // A skipped/denied AskUserQuestion routes through here (the web client sends a `deny`
    // permission for "Skip"), so the remembered tool_input would otherwise leak for the session
    // lifetime — answerQuestion deletes it on the answer path, mirror that on the cancel path.
    record?.questionToolInputs.delete(requestId);
    // The prompt is answered: drop it from the pending set and recompute `awaiting`.
    if (record) this.setAwaiting(record, requestId, false);
  }

  /**
   * Answer an AskUserQuestion. SECURITY: the `_clientToolInput` argument is IGNORED — we replay the
   * tool_input the CLI originally sent for this requestId (remembered in `record.questionToolInputs`)
   * so a client cannot tamper with what goes back to the CLI. Falls back to the client value only if
   * (impossibly) no remembered input exists for the requestId.
   */
  async answerQuestion(
    id: string,
    requestId: string,
    _clientToolInput: unknown,
    answers: Record<string, string | string[]>,
  ): Promise<void> {
    await this.ensureLive(id);
    const record = this.require(id);
    const remembered = record.questionToolInputs.has(requestId)
      ? record.questionToolInputs.get(requestId)
      : _clientToolInput;
    this.manager.answerQuestion(id, requestId, remembered, answers);
    record.questionToolInputs.delete(requestId);
    // The question is answered: drop it from the pending set and recompute `awaiting`.
    this.setAwaiting(record, requestId, false);
  }

  /**
   * Apply live settings to a running session: send each provided control to the CLI and mirror the
   * change into the in-memory SessionMeta so a subsequent getSession reflects it.
   */
  async applySettings(id: string, settings: LiveSettings): Promise<SessionMeta> {
    await this.ensureLive(id);
    const record = this.require(id);
    if (settings.model !== undefined) {
      this.manager.setModel(id, settings.model);
      record.meta.model = settings.model;
    }
    if (settings.maxThinkingTokens !== undefined) {
      this.manager.setMaxThinkingTokens(id, settings.maxThinkingTokens);
      if (settings.effort !== undefined) record.meta.effort = settings.effort;
    }
    if (settings.permissionMode !== undefined) {
      this.manager.setPermissionMode(id, settings.permissionMode);
      record.meta.permissionMode = settings.permissionMode;
    }
    this.persist(record.meta);
    return record.meta;
  }

  /**
   * Interrupt (STOP) the current turn of a session WITHOUT killing the process. Only meaningful while a
   * turn is actually running, so it targets the LIVE process only: a dormant/dead session has nothing to
   * abort and is a no-op (we never resume just to interrupt). The CLI ends the aborted turn with a
   * `result` (terminal_reason "aborted_streaming") that flows through the normal `result` path, so the
   * wire settles to idle/stopped and the session stays open for the next message.
   */
  interrupt(id: string): void {
    this.require(id); // throw for an unknown id (consistent with the other hub ops)
    if (this.manager.getSession(id)) this.manager.interrupt(id);
  }

  /**
   * REWIND / CHECKPOINT — go back to a turn's checkpoint (its user-message uuid), optionally reverting code
   * and/or the conversation. Mirrors Claude Code's ESC-ESC, made tappable on mobile. Three modes:
   *
   *  - `code`         — LIVE, no respawn: send the `rewind_files` control_request so Write/Edit/NotebookEdit
   *                     changes made AFTER the checkpoint are restored (created files deleted, modified files
   *                     reverted). Bash-made changes are NOT tracked. The conversation is unchanged.
   *  - `conversation` — STOP the live process, then RESUME it truncated at the checkpoint
   *                     (`--resume-session-at <uuid>`) so every turn after it is dropped. Files unchanged.
   *  - `both`         — like `conversation`, and ALSO one-shot rewind files on the resume (`--rewind-files`).
   *
   * Emits a `rewound` frame (critical, replayable) carrying the checkpointId + mode so the UI shows the
   * "↩ Rewound to here" marker and, for conversation/both, truncates the displayed thread to that point.
   * Returns the `rewind_files` result for `code` (the live one we can report on); conversation/both report
   * the respawn outcome. NEVER throws into the WS handler — failures resolve to `{ ok:false, error }`.
   */
  async rewind(
    id: string,
    checkpointId: string,
    mode: "code" | "conversation" | "both",
  ): Promise<RewindFilesResult> {
    const record = this.require(id);
    if (mode === "code") {
      // Live rewind needs a running process (the checkpoint backups live in the live CLI). Ensure one.
      try {
        await this.ensureLive(id);
        const result = await this.manager.rewindFiles(id, checkpointId);
        this.emitFrame(record, "rewound", { checkpointId, mode, ...result });
        return result;
      } catch (err) {
        const error = (err as Error).message;
        this.emitFrame(record, "rewound", { checkpointId, mode, ok: false, error });
        return { ok: false, error };
      }
    }

    // conversation / both: STOP the live turn/process, then RESUME truncated at the checkpoint. The CLI
    // rejects --resume together with a live process for the same id, so we kill the current one first.
    try {
      if (this.manager.getSession(id)) {
        record.intentionalStop = true;
        this.manager.stopSession(id);
      }
      const session = await this.manager.resumeSession(id, {
        cwd: record.meta.cwd,
        model: record.meta.model,
        effort: record.meta.effort,
        dangerouslySkip: record.meta.dangerouslySkip,
        resumeSessionAt: checkpointId,
        ...(mode === "both" ? { rewindFilesAt: checkpointId } : {}),
      });
      record.meta.status = "running";
      record.intentionalStop = false;
      this.clearAllAwaiting(record);
      this.attach(session.process, record);
      this.persist(record.meta);
      this.emitFrame(record, "rewound", { checkpointId, mode, ok: true });
      return { ok: true };
    } catch (err) {
      const error = (err as Error).message;
      record.meta.status = "errored";
      this.persist(record.meta);
      this.emitFrame(record, "rewound", { checkpointId, mode, ok: false, error });
      return { ok: false, error };
    }
  }

  /**
   * Close a session: stop its live `claude` process (if any), then REMOVE it from the in-memory list
   * AND the durable store. Idempotent — closing an unknown id is a no-op. The claude transcript
   * `.jsonl` is NOT touched (claude owns it; the session stays resumable via the /resume flow +
   * GET /resumable). Both the chat ✕ and the Settings "Stop session" converge here.
   */
  deleteSession(id: string): void {
    const record = this.records.get(id);
    if (!record) return; // unknown id → no-op (idempotent)
    // Mark BEFORE killing so the `exit` handler treats this as a deliberate stop, not a crash.
    record.intentionalStop = true;
    // Cancel any in-flight ask_user BEFORE killing the child so its held POST /ask requests (and the
    // waiting MCP tools) resolve as cancelled instead of leaking timers / hanging forever.
    this.cancelAllAsks(record);
    if (this.manager.getSession(id)) this.manager.stopSession(id);
    // Drop every trace from the hub + store; the transcript on disk is intentionally left alone.
    this.records.delete(id);
    this.resumeInFlight.delete(id);
    record.listeners.clear();
    record.questionToolInputs.clear();
    record.pending.clear();
    this.store?.delete(id);
  }

  /**
   * Stop a session. Now an alias for {@link deleteSession}: both the chat ✕ and the Settings
   * "Stop session" must make the session disappear from the list (stop the process AND remove the
   * record + store row), keeping the transcript resumable. A subsequent GET /sessions — even after a
   * server restart that reconstructs the hub from the store — will not include it.
   */
  stopSession(id: string): void {
    this.deleteSession(id);
  }

  /**
   * Stop every LIVE session's child `claude` for a graceful server shutdown (onClose hook) WITHOUT
   * removing the records: a deploy/restart must leave sessions DORMANT (resumable) in the store, not
   * delete them. Each live process is killed (intentionalStop, so the exit handler won't flag it
   * errored) and its meta written back as dormant so it rehydrates correctly after the restart.
   */
  stopAll(): void {
    for (const [id, record] of this.records) {
      if (this.manager.getSession(id)) {
        record.intentionalStop = true;
        this.manager.stopSession(id);
      }
      // Cancel pending ask_user requests so a graceful shutdown doesn't leave held HTTP requests (and
      // their MCP tools) hanging while the child is killed out from under them.
      this.cancelAllAsks(record);
      record.meta.status = "dormant";
      record.meta.awaiting = false;
      record.pending.clear();
      this.persist(record.meta);
    }
  }

  /**
   * Write the session's current meta to the durable store (no-op when no store is configured).
   * `lastActivityAt` carries the meta's own value (kept fresh by markActivity) so persisting a
   * status/settings change can't clobber the real last-activity time — `awaiting` is transient and
   * deliberately NOT persisted (a rehydrated session is always awaiting:false).
   */
  private persist(meta: SessionMeta): void {
    try {
      this.store?.upsert({
        id: meta.id,
        cwd: meta.cwd,
        model: meta.model,
        effort: meta.effort,
        dangerouslySkip: meta.dangerouslySkip,
        status: meta.status,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        permissionMode: meta.permissionMode,
      });
    } catch {
      // best-effort: an exit/error frame can land AFTER onClose closed the store; the in-memory meta
      // is authoritative for live reads and the store already holds the last good state. (spec §10)
    }
  }

  /** Rehydrate DORMANT session metas from the store at boot (no live process is spawned). */
  loadFromStore(): void {
    if (!this.store) return;
    for (const s of this.store.list()) {
      if (this.records.has(s.id)) continue;
      const meta: SessionMeta = {
        id: s.id,
        cwd: s.cwd,
        model: s.model,
        effort: s.effort,
        dangerouslySkip: s.dangerouslySkip,
        status: "dormant",
        createdAt: s.createdAt,
        permissionMode: s.permissionMode,
        // A rehydrated session has no live process and no pending prompt: never awaiting on boot.
        awaiting: false,
        lastActivityAt: s.lastActivityAt,
      };
      this.records.set(s.id, {
        meta,
        buffer: new ReplayBuffer(this.replayCapacity),
        listeners: new Set(),
        questionToolInputs: new Map(),
        pending: new Set(),
        pendingAsks: new Map(),
        intentionalStop: false,
      });
    }
  }

  /** Ensure a record has a LIVE process; resume a dormant/dead one in its stored cwd. */
  private async ensureLive(id: string): Promise<void> {
    const record = this.require(id);
    if (this.manager.getSession(id)) return; // already live
    // A concurrent ensureLive is already resuming this id — await ITS promise instead of spawning a
    // second `claude --resume`. NOTE: the has()-check and the set() below must stay synchronous (no
    // await between them) so two overlapping callers can never both miss and both spawn.
    const pending = this.resumeInFlight.get(id);
    if (pending) return pending;

    const resume = (async () => {
      const session = await this.manager.resumeSession(id, {
        cwd: record.meta.cwd,
        model: record.meta.model,
        effort: record.meta.effort,
        dangerouslySkip: record.meta.dangerouslySkip,
      });
      record.meta.status = "running";
      // Fresh live process: clear the deliberate-stop guard so its eventual exit is judged on its own
      // merits (clean → dormant, crash → errored), and start from a clean awaiting state.
      record.intentionalStop = false;
      this.clearAllAwaiting(record);
      this.attach(session.process, record);
      this.persist(record.meta);
    })();
    this.resumeInFlight.set(id, resume);
    try {
      await resume;
    } finally {
      // Release the key whether the resume succeeded or FAILED — a failed resume must not wedge the
      // session forever; a later message can retry rather than awaiting a settled-rejected promise.
      this.resumeInFlight.delete(id);
    }
  }

  private require(id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);
    return record;
  }
}
