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
  ModelOption,
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
import type { ImageStore } from "./image-store.js";
import type { FrameSpool } from "./frame-spool.js";
import { spoolFrameIdentity } from "./frame-spool.js";
import type { ClaudeVersionProbe } from "./diag.js";
import { slimImageBlocks } from "./transcript-images.js";
import { isLivePermissionMode } from "./config.js";

export type SessionStatus = "running" | "dormant" | "errored" | "stopped";

/**
 * How long a transcript-LESS session whose only content is its recovery spool is kept around. A crashed,
 * never-resumed session's spool clears only on a `result` (which never comes), so without a retention
 * bound each crash would leave a permanent rail row + spool file, accumulating unboundedly over months.
 * Past this window the session is dropped and its spool cleared on the next boot / GET /sessions prune;
 * recent ones are kept so a reopen still recovers the lost in-flight turn. 7 days.
 */
export const SPOOL_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Token usage for the context meter + whether a turn is currently in flight. Derived from the replay
 *  buffer so a (re)opened/switched chat can seed its wire state + meter immediately. */
export interface LiveState {
  /** True when a turn is mid-flight (assistant/stream/user activity after the last result/exit) — so a
   *  switched-to chat shows "working" instead of a wrong "idle" while Claude is between visible frames. */
  turnActive: boolean;
  /** `contextTokens` = CURRENT context occupancy from the newest assistant turn's per-turn usage (NOT the
   *  result's cumulative usage, which over-reads to many× the window on a long chat). `contextWindow` = the
   *  authoritative denominator from the newest result's modelUsage. Either may be absent if not in buffer. */
  usage?: { contextTokens?: number; outputTokens?: number; contextWindow?: number };
  /** The IN-FLIGHT turn's output tokens so far (the terminal's live counter) — summed from the retained
   *  assistant frames since the last result/exit, so a chat reopened mid-turn shows the right "Thinking…
   *  · N tok" instead of zero. Only present while `turnActive`; live `message_delta`s refine it after. */
  liveTokens?: number;
  /** A permission/question prompt STILL PENDING at (re)open. The buffer retains only unresolved prompt
   *  frames (resolvePrompt prunes answered ones) and the `?since=` resume skips them, so we hand the newest
   *  pending one to the client here — else a chat reopened mid-prompt is stuck "working" with no card. */
  pendingPermission?: unknown;
  pendingQuestion?: unknown;
  /** The HONEST in-flight phase for a chat reopened mid-turn (only present while `turnActive`). The buffer
   *  drops `stream_event` (so it can't tell thinking from streaming), but it retains the committed `tool_use`
   *  / `tool_result` blocks: an UNMATCHED `tool_use` (incl. a `Task`/`Agent` spawn whose subagent is still
   *  running) means a tool is genuinely executing → "running-tool"; otherwise the model is generating →
   *  "thinking". We NEVER default to "running-tool" (it would fabricate a tool during thinking/streaming);
   *  "thinking" is the honest, neutral "working" fallback. The live WS then refines it per `content_block`. */
  liveWire?: "running-tool" | "thinking";
}

/** Sum a Claude per-turn `message.usage` into current context occupancy (input + cache-read + cache-create
 *  + output). Mirror of the web reducer's `contextTokensFromUsage`. Undefined when no usage / all zero. */
function sumAssistantUsage(u: Record<string, unknown> | undefined): number | undefined {
  if (!u || typeof u !== "object") return undefined;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const total =
    n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
  return total > 0 ? total : undefined;
}

/**
 * Derive {@link LiveState} from a session's replay-buffer snapshot (newest→oldest). `turnActive` is true
 * iff there is turn activity (assistant/stream/user event, or a pending permission/question) AFTER the most
 * recent `result`/`exit` boundary. `contextTokens` comes from the newest MAIN assistant turn's per-turn
 * usage; `contextWindow`/`outputTokens` from the newest result. Pure; never throws.
 */
export function liveStateFromBuffer(frames: ServerFrame[]): LiveState {
  let turnActive = false;
  let boundaryHit = false; // hit the most recent result/exit — freezes turnActive but keeps scanning for usage
  let contextTokens: number | undefined;
  let contextWindow: number | undefined;
  let outputTokens: number | undefined;
  // For the honest reopen phase (liveWire): collect the CURRENT turn's committed tool_use ids and the
  // tool_result ids that close them. An unmatched tool_use ⇒ a tool is genuinely running. Only frames
  // newer than the last boundary (`!boundaryHit`) belong to the in-flight turn.
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (f.kind === "result") {
      boundaryHit = true;
      const u = (f.payload as { usage?: { contextWindow?: number; outputTokens?: number } }).usage;
      if (contextWindow === undefined && typeof u?.contextWindow === "number") contextWindow = u.contextWindow;
      if (outputTokens === undefined && typeof u?.outputTokens === "number") outputTokens = u.outputTokens;
    } else if (f.kind === "exit") {
      boundaryHit = true;
    } else if (f.kind === "permission" || f.kind === "question") {
      if (!boundaryHit) turnActive = true;
    } else if (f.kind === "event") {
      const p = f.payload as {
        type?: string;
        parentToolUseId?: string;
        message?: { usage?: Record<string, unknown>; content?: unknown };
      };
      if (!boundaryHit && (p.type === "assistant" || p.type === "stream_event" || p.type === "user")) turnActive = true;
      if (!boundaryHit && (p.type === "assistant" || p.type === "user")) {
        const content = p.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; id?: string; tool_use_id?: string };
            if (b.type === "tool_use" && typeof b.id === "string") toolUseIds.add(b.id);
            else if (b.type === "tool_result" && typeof b.tool_use_id === "string") toolResultIds.add(b.tool_use_id);
          }
        }
      }
      if (contextTokens === undefined && p.type === "assistant" && p.parentToolUseId === undefined) {
        contextTokens = sumAssistantUsage(p.message?.usage);
      }
    }
    if (boundaryHit && contextTokens !== undefined && contextWindow !== undefined) break;
  }
  // An unmatched tool_use ⇒ "running-tool"; otherwise the model is generating ⇒ "thinking" (never default
  // to "running-tool", which would lie about a tool during the thinking/streaming phases).
  const liveWire: LiveState["liveWire"] = !turnActive
    ? undefined
    : [...toolUseIds].some((id) => !toolResultIds.has(id))
      ? "running-tool"
      : "thinking";
  // NOTE: liveTokens is NOT derived here — the retained `assistant` frames only carry the INITIAL
  // output_tokens (~2); the accurate running count lives in the never-buffered `message_delta`. getHistory
  // sets LiveState.liveTokens from the live process's record counter (see accumulateLiveTokens) instead.
  const usage =
    contextTokens !== undefined || contextWindow !== undefined || outputTokens !== undefined
      ? {
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        }
      : undefined;
  return { turnActive, ...(liveWire ? { liveWire } : {}), ...(usage ? { usage } : {}) };
}

/**
 * Fold one inbound event into the per-session live-token counter (the terminal's "· N tok"). The accurate
 * running count is in the stream's `message_delta.usage.output_tokens` (the retained `assistant` frame only
 * has the initial value). `base` sums the turn's ALREADY-FINISHED messages (committed at each `message_start`)
 * so a multi-message/tool turn stays monotonic. Subagent stream events (parentToolUseId set) are ignored —
 * their tokens belong to the subagent card. Pure; returns the next {liveTokens, base}.
 */
export function accumulateLiveTokens(
  prev: { liveTokens: number; turnTokenBase: number },
  ev: { type?: string; parentToolUseId?: string; event?: unknown },
): { liveTokens: number; turnTokenBase: number } {
  if (ev.type !== "stream_event" || ev.parentToolUseId !== undefined) return prev;
  const inner = ev.event as
    | { type?: string; usage?: { output_tokens?: number }; message?: { usage?: { output_tokens?: number } } }
    | undefined;
  if (inner?.type === "message_start") {
    const base = prev.liveTokens; // the just-finished message's deltas are already in liveTokens → commit them
    const out = inner.message?.usage?.output_tokens;
    return { turnTokenBase: base, liveTokens: base + (typeof out === "number" ? out : 0) };
  }
  if (inner?.type === "message_delta") {
    const out = inner.usage?.output_tokens;
    if (typeof out === "number") return { turnTokenBase: prev.turnTokenBase, liveTokens: prev.turnTokenBase + out };
  }
  return prev;
}

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
  /**
   * The model's authoritative context window (tokens), captured from a result's modelUsage and PERSISTED.
   * It's the context meter's denominator on reopen/after a restart — when no result is in the replay
   * buffer and the model name can't reveal it (e.g. opus-4-8 running a 1M window with no "1m" marker).
   */
  contextWindow?: number;
  /** The account's available models (from the live process's init handshake) so the client can render a
   *  real model picker instead of a free-text box. Transient (re-captured per spawn; not persisted). */
  availableModels?: ModelOption[];
  /** The `claude` CLI version this session SPAWNED with (e.g. "2.1.187"), so the UI can show which Claude a
   *  chat is running on. Captured from the version probe at create/resume; a long-running session keeps its
   *  spawn-time version even after the server's claude auto-updates. Transient (re-stamped per spawn). */
  claudeVersion?: string;
}

export interface LiveSettings {
  model?: string;
  /** Thinking-token budget (the PWA's effort maps onto this). */
  maxThinkingTokens?: number;
  /** Optional human label for the effort the maxThinkingTokens came from, mirrored into meta.effort. */
  effort?: string;
  permissionMode?: string;
  /**
   * Flip --dangerously-skip-permissions on the RUNNING session. The permission boundary + the PreToolUse
   * hook are fixed at claude SPAWN, so a CHANGE here can't be a control_request — applySettings RESPAWNS
   * (resume the same conversation with the new flag). Unchanged → no-op.
   */
  dangerouslySkip?: boolean;
}

export type FrameListener = (frame: ServerFrame) => void;

export interface Subscription {
  unsubscribe(): void;
  /**
   * FOREGROUND-GATING: flip this subscription's foreground flag. The WS connection (a subscriber) is
   * "foreground" when its PWA tab is VISIBLE; the client signals it via a `visibility` frame on
   * document.visibilitychange. `hasForegroundSubscriber` reads the per-session OR of these so a push is
   * suppressed only while the user is genuinely LOOKING at that session. Defaults to foreground on
   * connect (opening/connecting means foreground).
   */
  setForeground(foreground: boolean): void;
}

/** One live subscriber to a session (a WS connection). `foreground` is whether its PWA tab is visible. */
interface SubscriberEntry {
  listener: FrameListener;
  foreground: boolean;
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

/** Default time (ms) the server holds an `ask_user` request open before giving up and cancelling it.
 *  Kept UNDER the MCP client's (undici) ~300s headersTimeout: a longer hold meant the mcp-send fetch
 *  aborted at ~5min while the server still waited, so an answer given between ~5–10min resolved to a
 *  dead socket and never reached Claude. 4min keeps a comfortable margin with no silent dead zone. */
export const ASK_TIMEOUT_MS = 4 * 60 * 1000;

interface SessionRecord {
  meta: SessionMeta;
  buffer: ReplayBuffer;
  /**
   * Live subscribers (WS connections). Each carries a mutable `foreground` flag (whether its PWA tab is
   * visible) so the push seam can suppress a notification while the user is genuinely LOOKING at the
   * session — see {@link SessionHub.hasForegroundSubscriber}.
   */
  listeners: Set<SubscriberEntry>;
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
  /**
   * Monotonic attach generation. A respawn (applySettings dangerouslySkip / rewind) bumps this BEFORE
   * killing the old process; each `attach` captures the value, so the OLD process's late events + exit
   * (which still fire on the superseded ClaudeProcess) become no-ops instead of emitting a spurious
   * `exit` frame or flipping the freshly-resumed session to dormant.
   */
  generation: number;
  /**
   * The IN-FLIGHT turn's output tokens so far (the live "· N tok" counter), tracked from the stream's
   * `message_delta`/`message_start` usage as frames pass through — `message_delta` carries the accurate
   * running count (the retained `assistant` frame only has the initial ~2, so the buffer CAN'T derive it).
   * `turnTokenBase` sums the turn's already-finished messages so a multi-message turn stays monotonic.
   * Both reset on a `result`. Reported in getHistory's LiveState so a reopen-mid-turn shows the right count.
   */
  liveTokens: number;
  turnTokenBase: number;
  /**
   * TRUE from the instant a user message is SENT until the turn's `result` (or process exit). The buffer's
   * `turnActive` only flips true once the CLI ECHOES the message back, so without this an early reopen — in
   * the spin-up / first-thinking window before any frame is buffered — wrongly read "Ready". getHistory ORs
   * this in so a chat reopened at ANY point of a live turn honestly shows "working", not idle.
   */
  turnInFlight: boolean;
}

export interface SessionHubOptions {
  replayCapacity?: number;
  now?: () => number;
  store?: SessionStore;
  history?: HistoryService;
  /** Content-addressed image store. When set, getHistory moves each transcript's inline base64 image
   *  into it and ships a `/images/<ref>` url ref instead (small payload, file-served, lazy). */
  imageStore?: ImageStore;
  /**
   * Append-only per-session critical-frame spool (durability seam). When set, the hub spools a session's
   * content-bearing frames so a restart can recover content the transcript hadn't yet captured; on boot /
   * getHistory the spool is MERGED in when the transcript is missing/short. Cleared on each turn `result`
   * (it only holds the in-flight tail). Injectable so it's unit-testable with an in-memory double; the
   * default is files under the data dir (see openFrameSpool). Absent → no spooling (current behavior).
   */
  spool?: FrameSpool;
  /**
   * Observe every emitted frame (push-trigger seam). Invoked AFTER the WS listener fan-out so a push
   * dispatcher sees result/permission/question frames without coupling to the WS layer. Must never
   * throw (it is wrapped in a try/catch here so a push failure can't unwind the claude emit).
   */
  onFrame?: (sessionId: string, frame: ServerFrame) => void;
  /** Cached `claude --version` probe — used to stamp each session's `claudeVersion` at spawn. Optional;
   *  when absent the field is simply left unset (the UI hides the version). */
  claudeVersionProbe?: ClaudeVersionProbe;
}

export class SessionHub {
  private readonly manager: SessionManager;
  private readonly replayCapacity: number;
  private readonly now: () => number;
  private readonly store?: SessionStore;
  private readonly history?: HistoryService;
  private readonly imageStore?: ImageStore;
  private readonly spool?: FrameSpool;
  private readonly onFrame?: (sessionId: string, frame: ServerFrame) => void;
  private readonly claudeVersionProbe?: ClaudeVersionProbe;
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
    this.imageStore = opts.imageStore;
    this.spool = opts.spool;
    this.onFrame = opts.onFrame;
    this.claudeVersionProbe = opts.claudeVersionProbe;
  }

  /** Best-effort: stamp `meta.claudeVersion` from the cached `claude --version` probe. Never throws and
   *  never blocks meaningfully (the probe is cached) — a failure just leaves the version unset. */
  private async stampClaudeVersion(meta: SessionMeta): Promise<void> {
    try {
      const v = await this.claudeVersionProbe?.get();
      if (v?.version) meta.claudeVersion = v.version;
    } catch {
      /* leave unset */
    }
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
      // dangerouslySkip forces bypass; otherwise honor an explicit creation permission mode (acceptEdits/
      // plan) so a session can START in that posture — the flag is already emitted by buildClaudeArgs.
      permissionMode: opts.dangerouslySkip ? "bypassPermissions" : (opts.permissionMode ?? "default"),
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
      generation: 0,
      liveTokens: 0,
      turnTokenBase: 0,
      turnInFlight: false,
    };
    this.records.set(session.id, record);
    this.attach(session.process, record);
    await this.stampClaudeVersion(meta);
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
    /** Extra --add-dir roots to grant the resumed process (else a resumed session loses them). */
    addDirs?: string[];
    frames: ServerFrame[];
  }): Promise<SessionMeta> {
    const existing = this.records.get(opts.sessionId);
    if (existing && this.manager.getSession(opts.sessionId)) return existing.meta;

    const session = await this.manager.createSession({
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      dangerouslySkip: opts.dangerouslySkip,
      addDirs: opts.addDirs,
      resumeId: opts.sessionId,
    });
    // If the record was deleted (deleteSession/stopAll) WHILE we were spawning, don't attach to a dead
    // record — stop the just-spawned child so it isn't orphaned (mirror ensureLive's guard). Stop the
    // EXACT session we spawned only if it's still the one registered under this id.
    if (existing && this.records.get(opts.sessionId) !== existing) {
      if (this.manager.getSession(opts.sessionId) === session) this.manager.stopSession(opts.sessionId);
      return existing.meta;
    }
    const now = this.now();
    const permissionMode = opts.dangerouslySkip ? "bypassPermissions" : "default";

    // Seed a buffer with the prior conversation (each push assigns a contiguous seq), so any client that
    // connects replays the full history BEFORE live continuation frames. On REUSE, continue the existing
    // buffer's seq space (start past its maxSeq) so a still-connected client never sees seqs go backwards.
    const buffer = new ReplayBuffer(this.replayCapacity, existing ? existing.buffer.maxSeq() + 1 : 1);
    for (const frame of opts.frames) buffer.push(frame.kind, frame.payload);

    if (existing) {
      // REUSE the dormant record IN PLACE — rebuilding it (records.set with a new record) orphaned any
      // WS client still subscribed to the old record and leaked its pending asks/timers. Drain the old
      // asks, refresh meta + buffer, bump the attach generation (stale listeners no-op), then attach.
      this.cancelAllAsks(existing);
      existing.meta.cwd = session.cwd;
      existing.meta.model = opts.model;
      existing.meta.effort = opts.effort;
      existing.meta.dangerouslySkip = opts.dangerouslySkip ?? false;
      existing.meta.permissionMode = permissionMode;
      existing.meta.status = "running";
      existing.meta.awaiting = false;
      existing.meta.lastActivityAt = now;
      existing.buffer = buffer;
      existing.generation += 1;
      existing.intentionalStop = false;
      this.clearAllAwaiting(existing);
      this.attach(session.process, existing);
      this.persist(existing.meta);
      return existing.meta;
    }

    const meta: SessionMeta = {
      id: session.id,
      cwd: session.cwd,
      model: opts.model,
      effort: opts.effort,
      dangerouslySkip: opts.dangerouslySkip ?? false,
      status: "running",
      createdAt: now,
      permissionMode,
      awaiting: false,
      lastActivityAt: now,
    };
    const record: SessionRecord = {
      meta,
      buffer,
      listeners: new Set(),
      questionToolInputs: new Map(),
      pending: new Set(),
      pendingAsks: new Map(),
      intentionalStop: false,
      generation: 0,
      liveTokens: 0,
      turnTokenBase: 0,
      turnInFlight: false,
    };
    this.records.set(session.id, record);
    this.attach(session.process, record);
    await this.stampClaudeVersion(meta);
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
    // DURABILITY: append content-bearing frames to the on-disk spool so a crash/restart can recover the
    // in-flight turn the transcript hasn't fsynced yet. `append` self-filters to spoolable frames and is
    // best-effort (never throws), so this can't unwind the claude emit. Cleared on each `result`.
    this.spool?.append(record.meta.id, frame);
    for (const entry of record.listeners) entry.listener(frame);
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
  askUser(id: string, questions: QuestionSpec[], signal?: AbortSignal): Promise<AskResult> {
    const record = this.require(id);
    const askId = `ask-${randomUUID()}`;
    return new Promise<AskResult>((resolve) => {
      const settle = (result: AskResult): void => {
        if (record.pendingAsks.delete(askId)) this.setAwaiting(record, askId, false);
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        // Timed out: the user never answered. Drop the pending entry and report cancellation so the
        // held POST /ask responds and the MCP tool returns rather than hanging forever.
        settle({ cancelled: true });
      }, ASK_TIMEOUT_MS);
      // Don't let a pending ask-timer keep the process alive on shutdown (the timer is cleared on
      // answer/cancel anyway). `unref` is unavailable on some timer mocks — guard it.
      timer.unref?.();
      // The long-poll client (mcp-send) disconnected before the user answered — cancel the ask so its
      // timer + pending entry + the user's now-moot prompt don't linger until the timeout.
      if (signal) signal.addEventListener("abort", () => settle({ cancelled: true }), { once: true });
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

  /** Cancel every pending `ask_user` for a session (stop/delete/exit) so no held request leaks. Also
   *  drops each askId from the awaiting set (an ask is in BOTH pendingAsks and `pending`) and recomputes
   *  meta.awaiting; the exit/reuse paths additionally run clearAllAwaiting, which emits the `resolve`
   *  frames for any still-connected client. */
  private cancelAllAsks(record: SessionRecord): void {
    for (const [askId, pending] of record.pendingAsks) {
      clearTimeout(pending.timer);
      pending.resolve({ cancelled: true });
      record.pending.delete(askId);
    }
    record.pendingAsks.clear();
    record.meta.awaiting = record.pending.size > 0;
  }

  private attach(proc: ClaudeProcess, record: SessionRecord): void {
    // Capture the account's model list (from this process's init handshake) onto the meta so GET /sessions
    // (+ :id) hands it to the client for a real model picker. Set per spawn (attach runs for every spawn).
    if (proc.availableModels && proc.availableModels.length > 0) record.meta.availableModels = proc.availableModels;
    // This attach's generation. A respawn bumps record.generation BEFORE killing the old process, so a
    // superseded ClaudeProcess (which still fires its late events/exit) is `stale()` here and no-ops —
    // no spurious `exit` frame, no flipping the freshly-resumed session to dormant.
    const gen = record.generation;
    const stale = () => record.generation !== gen;
    const emit = (kind: ServerFrameKind, payload: unknown) => this.emitFrame(record, kind, payload);
    proc.on("event", (ev: InboundEvent) => {
      if (stale()) return;
      // Assistant activity (the CLI streams events as it works) counts as conversation activity for
      // sorting; bump lastActivityAt so a session that's actively responding sorts above an idle one.
      // PERSIST only on real message events (user/assistant) — NOT on the flood of stream_event token
      // deltas — so a long answer doesn't fire a synchronous sqlite write per token (in-memory still bumps).
      const isMessage = ev.type === "user" || ev.type === "assistant";
      this.markActivity(record, isMessage);
      // Track the in-flight turn's live output-token count from the stream usage (the buffer can't derive
      // it — only message_delta carries the running number). Reported in getHistory for reopen-mid-turn.
      const t = accumulateLiveTokens({ liveTokens: record.liveTokens, turnTokenBase: record.turnTokenBase }, ev);
      record.liveTokens = t.liveTokens;
      record.turnTokenBase = t.turnTokenBase;
      emit("event", ev);
    });
    proc.on("permission", (perm: PermissionEvent) => {
      if (stale()) return;
      this.setAwaiting(record, perm.requestId, true);
      emit("permission", perm);
    });
    proc.on("question", (q: QuestionEvent) => {
      if (stale()) return;
      // SECURITY: remember the CLI's original tool_input for this requestId so answerQuestion
      // replays IT (not a client-echoed value) back into the CLI.
      record.questionToolInputs.set(q.requestId, q.toolInput);
      this.setAwaiting(record, q.requestId, true);
      emit("question", q);
    });
    proc.on("result", (result: ResultEvent) => {
      if (stale()) return;
      // A turn finished: nothing is pending anymore (defensive clear in case an answer frame was
      // dropped), and this is real conversation activity.
      this.clearAllAwaiting(record);
      this.markActivity(record);
      record.liveTokens = 0; // the turn ended → reset the live token counter for the next turn
      record.turnTokenBase = 0;
      record.turnInFlight = false; // turn done → a later reopen reads "Ready"/"Done", not a phantom "working"
      // Remember + PERSIST the authoritative context window (from the result's modelUsage) so the context
      // meter has the right denominator on a later reopen / after a restart, when no result is in the
      // buffer and the model name can't reveal it. Only persist when it actually changes (rare).
      const window = (result as { usage?: { contextWindow?: number } }).usage?.contextWindow;
      if (typeof window === "number" && window > 0 && window !== record.meta.contextWindow) {
        record.meta.contextWindow = window;
        this.persist(record.meta);
      }
      emit("result", result);
      // The turn COMPLETED — its content is now in the buffer (live) and Claude is transcribing it to its
      // durable `.jsonl`. Clear the spool so it only ever holds the IN-FLIGHT tail; the result is a clean
      // recovery boundary (a crash after this point recovers from the transcript, not the spool). Done
      // AFTER emit so the result is appended-then-dropped atomically from the consumer's view.
      this.spool?.clear(record.meta.id);
    });
    proc.on("diagnostic", (diag: DiagnosticEvent) => {
      if (stale()) return;
      emit("diagnostic", diag);
    });
    // CRITICAL: Node's EventEmitter throws on an "error" event with no listener. ClaudeProcess.write()
    // emits "error" on write-after-teardown, so every managed process MUST keep an "error" listener —
    // a stale one stays registered (so it never throws) but no-ops on the record.
    proc.on("error", (err: Error) => {
      if (stale()) return;
      record.meta.status = "errored";
      this.persist(record.meta);
      emit("diagnostic", { source: "parser", message: err.message } satisfies DiagnosticEvent);
    });
    proc.on("exit", (info) => {
      if (stale()) return;
      // A deliberate stop (deleteSession/stopAll) is being torn down separately — don't fight it by
      // flipping to errored. For a self-driven exit: a clean exit (code 0, or a kill signal from a
      // graceful stop) leaves the session DORMANT (resumable, not an error); a non-zero exit code or
      // an unexpected crash signal is a real failure → errored.
      if (!record.intentionalStop && record.meta.status !== "errored") {
        record.meta.status = isCleanExit(info) ? "dormant" : "errored";
        // Resolve every pending prompt (a live `resolve` per id + prune) so a connected client doesn't
        // keep showing a prompt whose process just died; clears the set + recomputes awaiting too.
        this.clearAllAwaiting(record);
        this.persist(record.meta);
      }
      // The child is gone: any `ask_user` still waiting can never be answered now — cancel them so the
      // held POST /ask requests (and the MCP tools) return instead of hanging. (A deliberate stop already
      // drained them in delete/stopAll; this covers a self-driven exit/crash mid-question.)
      this.cancelAllAsks(record);
      record.turnInFlight = false; // the process is gone → no turn is in flight; a reopen reads idle/error
      emit("exit", info);
    });
  }

  /**
   * Fully resolve a pending prompt (question/permission): prune its retained frame from the buffer, drop
   * the remembered tool_input, and fan a live `resolve` so connected clients clear the prompt NOW. The
   * `resolve` frame is RETAINED (replay-buffer), so a `?since=` delta reconnect also learns it's gone —
   * without this the prompt lingered until the turn's `result` (and re-showed on a reconnect/OTA reload).
   */
  private resolveFrame(record: SessionRecord, requestId: string): void {
    record.buffer.resolvePrompt(requestId);
    record.questionToolInputs.delete(requestId);
    this.emitFrame(record, "resolve", { requestId });
  }

  /** Mark a request pending/answered and recompute `meta.awaiting` (true iff anything is pending). */
  private setAwaiting(record: SessionRecord, requestId: string, awaiting: boolean): void {
    if (awaiting) {
      record.pending.add(requestId);
    } else if (record.pending.delete(requestId)) {
      this.resolveFrame(record, requestId);
    }
    record.meta.awaiting = record.pending.size > 0;
  }

  /** Clear every pending prompt for a session (turn boundary / exit / respawn). Each pending prompt is
   *  RESOLVED (pruned + a live `resolve`) so a reconnecting client never re-shows a now-moot prompt and
   *  no stale question/permission frame is retained in the buffer forever. */
  private clearAllAwaiting(record: SessionRecord): void {
    for (const requestId of [...record.pending]) this.resolveFrame(record, requestId);
    record.pending.clear();
    record.meta.awaiting = false;
  }

  /**
   * Bump lastActivityAt to mark conversation activity. The in-memory meta is ALWAYS updated (cheap; it's
   * the source of truth for live rail ordering). The durable store write is gated by `persist`: it is a
   * SYNCHRONOUS sqlite UPDATE, and with `--include-partial-messages` the CLI emits one `stream_event` per
   * token, so persisting on every event would block the event loop on a disk write per token. We persist
   * only on real turn boundaries (user/assistant messages + result), where the in-memory stamp has also
   * moved meaningfully — a restart loses at most the last sub-turn of ordering, which the next message
   * corrects. The store write is best-effort: a killed child can flush buffered events AFTER the onClose
   * hook closed the store ("database connection is not open"), and a touch failing must never unwind emit.
   */
  private markActivity(record: SessionRecord, persist = true): void {
    const at = this.now();
    record.meta.lastActivityAt = at;
    if (!persist) return;
    try {
      this.store?.touch(record.meta.id, at);
    } catch {
      // store closed/unavailable — in-memory lastActivityAt already updated; ignore (spec §10)
    }
  }

  listSessions(): SessionMeta[] {
    return [...this.records.values()].map((r) => r.meta);
  }

  /**
   * Number of LIVE sessions/processes — the count the concurrency cap (REMOTE_CODER_MAX_SESSIONS) gates
   * POST /sessions on. "Live" means an actual `claude` child is running (status `running` AND a registered
   * manager process), so dormant/errored records (no host process) don't count against the cap — reopening
   * a dormant session within the cap stays unaffected, and only genuine new spawns are bounded.
   */
  liveSessionCount(): number {
    let n = 0;
    for (const [id, record] of this.records) {
      if (record.meta.status === "running" && this.manager.getSession(id)) n += 1;
    }
    return n;
  }

  /**
   * APP BADGE: how many sessions are currently AWAITING the user (a pending permission/question, i.e.
   * meta.awaiting). The push dispatcher carries this in each payload so the SW sets the home-screen badge
   * even when the app is closed; it mirrors the web's own `awaitingCount(views/metas)` so the two agree.
   */
  awaitingSessionCount(): number {
    let n = 0;
    for (const record of this.records.values()) if (record.meta.awaiting) n += 1;
    return n;
  }

  /**
   * Evict DEAD sessions LIVE — no restart needed. A session whose claude process is gone and that has
   * no resumable transcript can't be revived (`claude --resume` would fail), so it must not linger in
   * the rail. Called on every GET /sessions, so a chat that died on the host (its process killed, its
   * transcript removed) disappears within one ~6s poll. Conservative by construction: only `dormant`/
   * `errored` records are even considered — a `running`/fresh session (a live process, or one just
   * created before its first turn) is never touched, and a dormant session WITH a transcript is kept
   * (it's resumable). A session with no transcript but RECOVERABLE spooled content (an in-flight turn the
   * transcript hadn't fsynced before a crash) is ALSO kept — its reopen still shows the recovered content,
   * so evicting it would silently lose that turn. Reuses deleteSession so the record + the durable store
   * row are both dropped.
   */
  pruneDeadSessions(): void {
    for (const [id, record] of [...this.records]) {
      const { status, cwd, createdAt, lastActivityAt } = record.meta;
      if (status !== "dormant" && status !== "errored") continue; // never touch running/fresh sessions
      if (this.manager.getSession(id)) continue; // a live process → not dead
      if (this.hasResumableTranscript(cwd, id)) continue; // resumable → keep
      // RETENTION (zombie bound): a transcript-less session aged past the recovery window — or never used —
      // is dropped even if its spool still has content (the window to recover the lost turn has expired).
      // deleteSession also clears its spool, so the file stops accumulating.
      if (this.isStaleTranscriptless(createdAt, lastActivityAt)) {
        this.deleteSession(id);
        continue;
      }
      // DURABILITY: a RECENT session with no transcript but RECOVERABLE spooled content (an in-flight turn
      // the transcript hadn't fsynced before a crash) is kept — its reopen still shows that turn, so
      // evicting it would silently lose content.
      if (this.hasRecoverableContent(id)) continue;
      this.deleteSession(id); // dead: no live process + no transcript + nothing spooled → drop everywhere
    }
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
  /**
   * Reopen history for a session. `limit` (when set) returns only the LAST N transcript turns — the
   * default on open, so a huge "headquarters" session loads fast instead of shipping its entire MB-scale
   * transcript over the tunnel and folding/rendering thousands of turns on a phone. `truncated` tells the
   * client older turns were omitted (it offers "load earlier", which re-requests with no limit). Passing
   * no `limit` returns the full history (the explicit load-earlier path).
   */
  async getHistory(
    id: string,
    limit?: number,
  ): Promise<{ history: ServerFrame[]; sinceSeq: number; truncated: boolean; total?: number; live: LiveState }> {
    const record = this.require(id);
    const sinceSeq = record.buffer.maxSeq();
    // LIVE STATE: the transcript carries only user/assistant turns, and the WS resumes from `sinceSeq` —
    // so neither the in-flight wire state nor the last result's usage reaches a (re)opened/switched chat,
    // which is why a switched-to chat showed "idle" while Claude was still working and lost its context
    // meter. Derive both from the replay buffer (the authoritative live tail) so the client can seed them.
    const snapshot = record.buffer.snapshot();
    const live = liveStateFromBuffer(snapshot);
    // EARLY-TURN reopen honesty: the buffer's `turnActive` only flips true once the CLI echoes a frame back,
    // so a reopen during spin-up / first thinking (before anything is buffered) read a wrong "idle". The
    // record KNOWS a turn is in flight from the instant of send — OR it in (only for a LIVE process). The
    // buffer had no tool frames yet in that window, so `liveWire` stays undefined → the client seeds the
    // honest neutral "thinking" (never a fabricated "running-tool").
    if (this.manager.getSession(id) && record.turnInFlight) live.turnActive = true;
    // The buffer rarely has a result right after a (re)open/restart, so fall back to the PERSISTED context
    // window (captured from an earlier result) — without it the meter divides by a wrong model-name guess.
    if (record.meta.contextWindow !== undefined && live.usage?.contextWindow === undefined) {
      live.usage = { ...live.usage, contextWindow: record.meta.contextWindow };
    }
    // Live token counter for reopen-mid-turn: only meaningful while a process is LIVE and a turn is in
    // flight (a dormant session has no in-flight turn). Sourced from the record (tracked off message_delta),
    // since the buffer can't derive it from the initial-only assistant usage.
    if (this.manager.getSession(id) && live.turnActive && record.liveTokens > 0) {
      live.liveTokens = record.liveTokens;
    }
    // Hand the client any STILL-PENDING prompt so a chat reopened mid-permission/question shows the card to
    // answer (the transcript has no prompt frame and the ?since resume skips the retained one). The buffer
    // keeps only UNRESOLVED prompt frames (resolvePrompt prunes answered ones), so the newest of each is it.
    for (let i = snapshot.length - 1; i >= 0; i--) {
      const f = snapshot[i]!;
      if (live.pendingPermission === undefined && f.kind === "permission") live.pendingPermission = f.payload;
      if (live.pendingQuestion === undefined && f.kind === "question") live.pendingQuestion = f.payload;
      if (live.pendingPermission !== undefined && live.pendingQuestion !== undefined) break;
    }
    if (this.history) {
      const turns = await this.history.read(record.meta.cwd, id);
      if (turns.length > 0) {
        const windowed = limit !== undefined && turns.length > limit ? turns.slice(-limit) : turns;
        // Also restore each subagent's INNER turns (stored out of the main transcript by this CLI), tagged
        // with the spawning Agent tool_use id so the reducer routes them into the right subagent thread.
        // Appended AFTER the main window so the Agent tool_use that seeds the thread is folded first. ONLY
        // restore subagents whose spawn (Agent/Task tool_use) is IN the loaded window — else a scrolled-out
        // subagent's file would create an orphan thread stuck "running" forever in the tray.
        const anchored = new Set<string>();
        for (const t of windowed) {
          const content = (t.message as { content?: unknown } | null)?.content;
          if (Array.isArray(content)) {
            for (const b of content as Array<{ type?: string; name?: string; id?: string }>) {
              if (b?.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && typeof b.id === "string") {
                anchored.add(b.id);
              }
            }
          }
        }
        const subagentTurns = this.history.readSubagents?.(record.meta.cwd, id, anchored) ?? [];
        const allTurns = [...windowed, ...subagentTurns];
        const history = await Promise.all(
          allTurns.map<Promise<ServerFrame>>(async (t, i) => ({
            // Display seqs are 1-based and contiguous, DISTINCT from the buffer/WS seq space: the client
            // renders these as history but resumes the WS from `sinceSeq` (the buffer's max), so the two
            // seq spaces never collide.
            seq: i + 1,
            kind: "event",
            // `raw` is SLIM ({uuid, isMeta, isCompactSummary}) — the full turn was a verbatim duplicate of
            // `message` (the client only reads those flags), so shipping it doubled the payload for nothing.
            // `isCompactSummary` lets a reopened compaction render the clean marker (not a giant "YOU" bubble).
            // `parentToolUseId` carries subagent linkage so reopened subagent (sidechain) turns route into
            // their thread instead of leaking into the main chat.
            // LAZY IMAGES: move every inline base64 image into the content-addressed image store and ship a
            // tiny `/images/<ref>` url ref instead (file-served, lazy, deduped). A user-uploaded screenshot
            // is ~MB of base64 inline; shipping it made a long chat take 15–20s to load on a phone.
            payload: {
              type: t.type,
              message: this.imageStore ? await slimImageBlocks(t.message, this.imageStore) : t.message,
              uuid: t.uuid,
              parentToolUseId: t.parentToolUseId,
              raw: { uuid: t.uuid, isMeta: t.isMeta, isCompactSummary: t.isCompactSummary },
            },
          })),
        );
        // DURABILITY: merge any spooled in-flight frames the transcript hasn't captured (a crash before
        // Claude fsynced the turn). Reconciled by identity, so a frame already in the transcript is not
        // duplicated; `sinceSeq` bounds it to frames the WS replay WON'T re-deliver (no double-count).
        const merged = this.mergeSpool(id, history, sinceSeq);
        return { history: merged, sinceSeq, truncated: windowed.length < turns.length, total: turns.length, live };
      }
    }
    // No transcript (brand-new session, or no HistoryService configured): the buffer is all we have.
    // Its frames already carry real WS seqs, so the client resumes the WS from the same `sinceSeq`. After
    // a restart the buffer is empty but the spool may hold the lost in-flight turn — merge it so a reopen
    // shows the recovered content (deduped by identity against whatever the buffer already has).
    const fallback = this.mergeSpool(id, record.buffer.snapshot(), sinceSeq);
    return { history: fallback, sinceSeq, truncated: false, live };
  }

  /** Live subscriber count for a session (0 if unknown). Lets the WS layer assert no leak. */
  subscriberCount(id: string): number {
    return this.records.get(id)?.listeners.size ?? 0;
  }

  /**
   * FOREGROUND-GATING: TRUE iff ≥1 live subscriber for this session is in the FOREGROUND (its PWA tab is
   * visible). The push seam consults this to SUPPRESS a notification while the user is genuinely looking
   * at that session — a push fires only when no foreground subscriber exists (backgrounded, viewing a
   * DIFFERENT session, or disconnected). A subscriber defaults to foreground on connect; the client flips
   * it via a `visibility` frame on document.visibilitychange. Unknown id → false (no foreground viewer).
   */
  hasForegroundSubscriber(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    for (const entry of record.listeners) if (entry.foreground) return true;
    return false;
  }

  subscribe(id: string, listener: FrameListener, sinceSeq?: number): Subscription {
    const record = this.require(id);
    // GAP CHECK: if a `?since=` reconnect would miss frames the buffer has since evicted (a long turn
    // streamed >capacity non-critical frames while the client was away), a delta replay would render an
    // INCOMPLETE conversation. Signal the client to refetch full REST history instead. Emitted before
    // the (now-partial) delta; the client consumes it at the socket layer and rebuilds from the refetch.
    if (sinceSeq !== undefined && record.buffer.hasGap(sinceSeq)) {
      listener({ seq: 0, kind: "resync", payload: {} });
    }
    // Replay first (spec §10), then go live.
    const replay = sinceSeq === undefined ? record.buffer.snapshot() : record.buffer.since(sinceSeq);
    for (const frame of replay) listener(frame);
    // Default FOREGROUND on connect: opening/connecting a chat means the user is looking at it. The client
    // sends the current visibility state right after connect and on every visibilitychange to refine this.
    const entry: SubscriberEntry = { listener, foreground: true };
    record.listeners.add(entry);
    return {
      unsubscribe: () => {
        record.listeners.delete(entry);
      },
      setForeground: (foreground: boolean) => {
        entry.foreground = foreground;
      },
    };
  }

  async sendMessage(id: string, content: string | ContentBlock[]): Promise<void> {
    await this.ensureLive(id);
    this.manager.sendMessage(id, content);
    // User send is conversation activity: bump lastActivityAt (in-memory meta + durable store).
    const record = this.records.get(id);
    if (record) {
      this.markActivity(record);
      // The turn is in flight NOW — before the CLI echoes anything — so a reopen during spin-up/first
      // thinking honestly shows "working" (see SessionRecord.turnInFlight). Reset on the turn's result/exit.
      record.turnInFlight = true;
    }
  }

  async answerPermission(
    id: string,
    requestId: string,
    decision: HookPermissionDecision,
    reason?: string,
  ): Promise<void> {
    const record = this.require(id);
    // Stale/duplicate answer for an already-resolved prompt (e.g. double-tap Allow) — drop it so we never
    // write a second control response to the CLI.
    if (!record.pending.has(requestId)) return;
    // Do NOT resurrect a dead session to deliver an answer: the requestId belongs to the gone process, so
    // a fresh `claude --resume` would just get a control response it never issued (and the answer is
    // lost). Only forward to a LIVE process; otherwise clear the prompt locally + tell clients (resolve).
    if (this.manager.getSession(id)) {
      this.manager.answerPermission(id, requestId, decision, reason);
    }
    // The prompt is resolved: drop it from pending + prune/resolve (this also drops the remembered
    // tool_input — a skipped/denied AskUserQuestion routes through here, so it cleans that up too).
    this.setAwaiting(record, requestId, false);
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
    const record = this.require(id);
    // Stale/duplicate answer for an already-resolved prompt — drop it (no second control response).
    if (!record.pending.has(requestId)) return;
    // Only forward to a LIVE process — never resurrect a dead session for an answer the gone process
    // can't consume (the answer would be lost while the UI believed it landed).
    if (this.manager.getSession(id)) {
      const remembered = record.questionToolInputs.has(requestId)
        ? record.questionToolInputs.get(requestId)
        : _clientToolInput;
      this.manager.answerQuestion(id, requestId, remembered, answers);
    }
    // Resolve the prompt: drop from pending + prune/resolve + drop the remembered tool_input.
    this.setAwaiting(record, requestId, false);
  }

  /**
   * Apply live settings to a running session: send each provided control to the CLI and mirror the
   * change into the in-memory SessionMeta so a subsequent getSession reflects it.
   */
  async applySettings(id: string, settings: LiveSettings): Promise<SessionMeta> {
    await this.ensureLive(id);
    const record = this.require(id);
    // Update the metadata model/effort first so a respawn (below) carries the latest values.
    if (settings.model !== undefined) record.meta.model = settings.model;
    if (settings.maxThinkingTokens !== undefined && settings.effort !== undefined) record.meta.effort = settings.effort;

    // Local const so the `!== undefined` check narrows it to `boolean` for the whole branch (a property
    // access would re-widen after the await).
    const nextSkip = settings.dangerouslySkip;

    if (nextSkip !== undefined && nextSkip !== record.meta.dangerouslySkip) {
      // The permission boundary + the PreToolUse hook are fixed at SPAWN, so flipping dangerouslySkip
      // can't be a control_request — RESPAWN: stop the live process and resume the SAME conversation
      // with the new flag (mirrors the rewind conversation/both respawn). The resume carries the
      // latest model/effort, so no separate control_request is needed for those.
      // Registered in resumeInFlight so a concurrent ensureLive (e.g. a message sent during the restart
      // window, when no process is live) AWAITS this respawn instead of spawning a second --resume.
      const respawn = (async () => {
        if (this.manager.getSession(id)) {
          // Invalidate the old process's attach listeners (generation bump) so its imminent exit can't
          // emit a spurious `exit` frame or flip the freshly-resumed session to dormant.
          record.generation += 1;
          record.intentionalStop = true;
          this.manager.stopSession(id);
        }
        const session = await this.manager.resumeSession(id, {
          cwd: record.meta.cwd,
          model: record.meta.model,
          effort: record.meta.effort,
          dangerouslySkip: nextSkip,
        });
        record.meta.status = "running";
        record.meta.dangerouslySkip = nextSkip;
        record.meta.permissionMode = nextSkip ? "bypassPermissions" : "default";
        record.intentionalStop = false;
        this.clearAllAwaiting(record);
        this.attach(session.process, record);
      })();
      this.resumeInFlight.set(id, respawn);
      try {
        await respawn;
      } catch {
        record.meta.status = "errored";
        record.intentionalStop = false;
      } finally {
        this.resumeInFlight.delete(id);
      }
    } else {
      // No permission-boundary change → apply live via control_requests (no restart).
      if (settings.model !== undefined) this.manager.setModel(id, settings.model);
      if (settings.maxThinkingTokens !== undefined) this.manager.setMaxThinkingTokens(id, settings.maxThinkingTokens);
      if (settings.permissionMode !== undefined) {
        // SECURITY: ALLOW-LIST the live permission mode. The spawn path already allow-lists modes, but
        // forwarding a client `permissionMode` string straight to the CLI's setPermissionMode let a crafted
        // `{type:"settings",permissionMode:"bypassPermissions"}` frame silently DISABLE the permission gate
        // without going through the explicit dangerouslySkip respawn (the only sanctioned bypass path). So we
        // refuse anything outside LIVE_PERMISSION_MODES (default/acceptEdits/plan) here — `bypassPermissions`
        // is rejected live and reachable ONLY via dangerouslySkip. IGNORE the bad frame (keep the current
        // mode + gate intact) and emit a diagnostic so a connected client gets honest feedback.
        if (isLivePermissionMode(settings.permissionMode)) {
          this.manager.setPermissionMode(id, settings.permissionMode);
          record.meta.permissionMode = settings.permissionMode;
        } else {
          this.emitFrame(record, "diagnostic", {
            source: "parser",
            message: `ignored unsupported live permission mode "${settings.permissionMode}" (use dangerouslySkip for bypassPermissions)`,
          } satisfies DiagnosticEvent);
        }
      }
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
  async rewind(id: string, checkpointId: string, mode: "code" | "conversation" | "both"): Promise<RewindFilesResult> {
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

    // conversation / both: STOP the live turn/process, then RESUME truncated to BEFORE the checkpoint. The
    // CLI rejects --resume together with a live process for the same id, so we kill the current one first.
    //
    // EDIT & RESEND: to truly DROP the rewound message M (so it can return to the composer for editing), we
    // resume at M's PARENT uuid (the line right before M) — `--resume-session-at <parent>` keeps that line
    // and drops M + everything after (verified against real claude 2.1.187). Resolve the parent from the
    // transcript; if it can't be resolved yet (the --replay echo not fsynced, no HistoryService, an old
    // format), FALL BACK to resuming at M itself (the prior behavior — keeps M) so a rewind never hard-fails.
    // The emitted `rewound` frame ALWAYS carries the ORIGINAL checkpointId (M) so the client reducer
    // truncates the displayed thread to BEFORE M regardless of which uuid we resumed at.
    const resumeAt =
      (this.history
        ? await this.history.parentUuidOf(record.meta.cwd, id, checkpointId).catch(() => undefined)
        : undefined) ?? checkpointId;
    // BOTH = conversation rewind + file revert. We do the file revert as a LIVE `rewind_files(M)` on the
    // CURRENT process FIRST — that's the verified code-mode mechanism, and it needs M's live checkpoint
    // (which exists now, before we stop the process). The resume-time `--rewind-files` flag can't be used
    // here: it requires a file checkpoint consistent with the resume point, and we resume at M's PARENT
    // (to drop M) — neither M nor the parent is valid there, so claude exits before the init handshake.
    // Sequencing it before the respawn reverts the files, then the conversation resume drops M.
    if (mode === "both") {
      try {
        await this.ensureLive(id);
        await this.manager.rewindFiles(id, checkpointId);
      } catch {
        // file revert is best-effort — still perform the conversation rewind below.
      }
    }
    // DURABILITY: a conversation rewind DROPS every turn from the checkpoint on — so the spool's in-flight
    // tail (post-checkpoint by construction) is now stale. Clear it BEFORE the respawn so a reopen before
    // the next `result` can't resurrect pre-rewind content the conversation no longer has.
    this.spool?.clear(id);
    // The respawn is registered in resumeInFlight so a concurrent ensureLive awaits it (no double-spawn).
    const respawn = (async () => {
      if (this.manager.getSession(id)) {
        // Invalidate the old process's attach listeners (generation bump) so its imminent exit can't
        // emit a spurious `exit` frame or flip the resumed session to dormant.
        record.generation += 1;
        record.intentionalStop = true;
        this.manager.stopSession(id);
      }
      const session = await this.manager.resumeSession(id, {
        cwd: record.meta.cwd,
        model: record.meta.model,
        effort: record.meta.effort,
        dangerouslySkip: record.meta.dangerouslySkip,
        permissionMode: record.meta.permissionMode,
        resumeSessionAt: resumeAt,
      });
      record.meta.status = "running";
      record.intentionalStop = false;
      this.clearAllAwaiting(record);
      this.attach(session.process, record);
    })();
    this.resumeInFlight.set(id, respawn);
    try {
      await respawn;
      this.persist(record.meta);
      this.emitFrame(record, "rewound", { checkpointId, mode, ok: true });
      return { ok: true };
    } catch (err) {
      const error = (err as Error).message;
      record.meta.status = "errored";
      this.persist(record.meta);
      this.emitFrame(record, "rewound", { checkpointId, mode, ok: false, error });
      return { ok: false, error };
    } finally {
      this.resumeInFlight.delete(id);
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
    // The session is closed for good — drop its recovery spool too (nothing left to recover into).
    this.spool?.clear(id);
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
        contextWindow: meta.contextWindow,
      });
    } catch {
      // best-effort: an exit/error frame can land AFTER onClose closed the store; the in-memory meta
      // is authoritative for live reads and the store already holds the last good state. (spec §10)
    }
  }

  /**
   * Rehydrate session metas from the store at boot (no live process is spawned).
   *
   * DURABILITY (never silently lose a session): a turn's streamed content lives only in the in-memory
   * ReplayBuffer until Claude transcribes it to its own `.jsonl` (whose fsync timing we don't control).
   * If the process dies before that — a crash / OTA restart / sleep-kill caught the turn mid-flight — the
   * transcript can be empty/missing even though the user definitely had a session with activity. The old
   * code HARD-DELETED any stored session without a transcript at boot, so that session vanished from the
   * rail entirely: the user lost not just the in-flight content but the very fact the session existed.
   *
   * So we keep a transcript-less session that had ANY activity as `dormant` (visible + resumable —
   * `claude --resume` may still revive it, and even if it can't the user must SEE it existed). The
   * critical-frame spool (see {@link mergeSpool}) then recovers the in-flight content on getHistory. The
   * ONE narrow case we still drop: a session CREATED-BUT-NEVER-USED (no transcript AND no recorded
   * activity, i.e. `lastActivityAt <= createdAt`) — a stray create whose turn was never sent has nothing
   * to show and nothing to resume, so it's pruned to avoid cluttering the rail with dead rows.
   *
   * Status is NOT the signal: an `errored` session is rehydrated as `dormant` (a transient crash gets
   * another chance). pruneDeadSessions still LIVE-evicts a transcript-less session later, but only when
   * its spool is also empty (so recoverable content is never thrown away) — see pruneDeadSessions.
   *
   * RETENTION (zombie bound): a transcript-less session is dropped (and its spool cleared) once it is
   * STALE — never used, or its last activity is older than {@link SPOOL_RECOVERY_TTL_MS}. Without this a
   * crashed-then-never-resumed session would linger forever (its spool only clears on a `result` that
   * never comes), accumulating a rail row + spool file per crash over months.
   */
  loadFromStore(): void {
    if (!this.store) return;
    for (const s of this.store.list()) {
      if (this.records.has(s.id)) continue;
      if (!this.hasResumableTranscript(s.cwd, s.id) && this.isStaleTranscriptless(s.createdAt, s.lastActivityAt)) {
        // No transcript AND stale (never used, or aged past the recovery window): a true dead row. Drop it
        // from the store AND clear any leftover spool so it stops accumulating. A transcript-less session
        // that is RECENT keeps its spool and rehydrates below (durability — the reopen recovers its tail).
        this.store.delete(s.id);
        this.spool?.clear(s.id);
        continue;
      }
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
        // The persisted context window survives the restart, so the meter has its denominator immediately.
        contextWindow: s.contextWindow,
      };
      this.records.set(s.id, {
        meta,
        buffer: new ReplayBuffer(this.replayCapacity),
        listeners: new Set(),
        questionToolInputs: new Map(),
        pending: new Set(),
        pendingAsks: new Map(),
        intentionalStop: false,
        generation: 0,
        liveTokens: 0,
        turnTokenBase: 0,
        turnInFlight: false,
      });
    }
  }

  /**
   * True when a session has a non-empty transcript on disk, i.e. `claude --resume` could actually
   * revive it. Used to prune "dead" sessions (created but never produced a turn) at boot. Mirrors the
   * exact path HistoryService reads from, so it agrees with what the chat would show. With no
   * HistoryService configured we can't check — keep the session (never prune what we can't verify).
   */
  private hasResumableTranscript(cwd: string, id: string): boolean {
    if (!this.history) return true;
    // Tolerant of encodeProjectDir lossiness: resolveTranscriptPath falls back to a scan, so a genuinely
    // resumable session is never deleted at boot / on prune just because its encoded path didn't match.
    return this.history.resolveTranscriptPath(cwd, id) !== undefined;
  }

  /**
   * True when a session has spooled in-flight content we could recover (crash-safe survival). A
   * transcript-less session with a non-empty spool MUST NOT be pruned at boot / on the live prune — that
   * spool holds the very turn the transcript hadn't fsynced before the crash. Prefers the in-memory
   * record's buffer when present (already loaded), else asks the on-disk spool. With no spool configured
   * there is nothing to recover.
   */
  private hasRecoverableContent(id: string): boolean {
    if (this.records.get(id)?.buffer.snapshot().length) return true;
    return (this.spool?.read(id).length ?? 0) > 0;
  }

  /**
   * RETENTION bound for a transcript-LESS session (its only content is a recovery spool that clears only
   * on a `result` that may never come). True — drop it — when it was NEVER used (no recorded activity,
   * `lastActivityAt <= createdAt`) OR its last activity is older than {@link SPOOL_RECOVERY_TTL_MS}. A
   * recent, used-but-transcript-less session is NOT stale: its reopen still recovers the lost in-flight
   * turn from the spool, so it's kept.
   */
  private isStaleTranscriptless(createdAt: number, lastActivityAt: number): boolean {
    if (lastActivityAt <= createdAt) return true; // created-but-never-used → a dead row
    return this.now() - lastActivityAt > SPOOL_RECOVERY_TTL_MS; // aged past the recovery window
  }

  /**
   * Merge a session's spooled critical frames into the history we're about to return, so a reopen after a
   * crash/restart shows the IN-FLIGHT content the transcript hadn't yet captured. Reconciles by IDENTITY
   * (uuid for events, requestId/id/checkpointId for prompt/attachment/rewound frames — see
   * spoolFrameIdentity) so a spooled frame the transcript ALREADY has is dropped (no double-count). The
   * surviving spool frames are appended AFTER `history` (they are the newest tail by construction) with
   * continued 1-based display seqs. A spool frame with no stable identity is kept (we prefer recovering
   * content over dropping it). Returns `history` unchanged when no spool is configured / it's empty.
   *
   * RACE GUARD (`sinceSeq`): getHistory captures `sinceSeq = buffer.maxSeq()` and then AWAITS the
   * transcript read / image slimming. A LIVE process can emit frames during those awaits — those carry
   * seq > sinceSeq, get spooled, and ALSO arrive via the `?since=sinceSeq` WS replay the client connects
   * with. Merging them too would double-deliver (the assistant path has no client-side uuid dedup). So we
   * contribute ONLY spooled frames with `seq <= sinceSeq`: a frame seq > sinceSeq is recovered by the WS
   * replay, and a spooled seq <= sinceSeq frame the transcript lacks is the genuine lost tail.
   */
  private mergeSpool(id: string, history: ServerFrame[], sinceSeq: number): ServerFrame[] {
    const spooled = (this.spool?.read(id) ?? []).filter((f) => f.seq <= sinceSeq);
    if (spooled.length === 0) return history;
    // Identities the returned history already covers — both its event uuids and prompt/etc ids — so a
    // spooled frame already represented by the transcript is not appended a second time.
    const seen = new Set<string>();
    for (const f of history) {
      const ident = spoolFrameIdentity(f);
      if (ident) seen.add(ident);
    }
    let seq = history.length;
    const extra: ServerFrame[] = [];
    for (const f of spooled) {
      const ident = spoolFrameIdentity(f);
      if (ident && seen.has(ident)) continue; // transcript already has it → don't duplicate
      if (ident) seen.add(ident);
      extra.push({ seq: ++seq, kind: f.kind, payload: f.payload });
    }
    return extra.length > 0 ? [...history, ...extra] : history;
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
        permissionMode: record.meta.permissionMode,
      });
      // If the session was closed (deleteSession/stopAll) WHILE we were spawning, the record is no longer
      // tracked — don't attach to a dead record; stop the just-spawned child so it isn't orphaned.
      if (this.records.get(id) !== record) {
        // The orphan never went through attach(), so it has no "error" listener — add a no-op one so a
        // stray write-after-teardown error can't throw, then stop the EXACT child we spawned (only if
        // it's still the one registered, so we never kill a newer legitimate process under the same id).
        session.process.on("error", () => {});
        if (this.manager.getSession(id) === session) this.manager.stopSession(id);
        return;
      }
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
