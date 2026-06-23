import { SessionManager } from "./session-manager.js";
import { ReplayBuffer } from "./replay-buffer.js";
import type { ServerFrame, ServerFrameKind } from "./replay-buffer.js";
import type { CreateSessionOptions } from "./session-manager.js";
import type { ClaudeProcess, PermissionEvent, QuestionEvent, DiagnosticEvent } from "./claude-process.js";
import type { ContentBlock, HookPermissionDecision, InboundEvent, ResultEvent } from "@remote-coder/protocol";
import type { SessionStore } from "./session-store.js";
import type { HistoryService } from "./history-service.js";

export type SessionStatus = "running" | "dormant" | "errored" | "stopped";

export interface SessionMeta {
  id: string;
  cwd: string;
  model?: string;
  effort?: string;
  dangerouslySkip: boolean;
  status: SessionStatus;
  createdAt: number;
  permissionMode?: string;
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
    const meta: SessionMeta = {
      id: session.id,
      cwd: session.cwd,
      model: opts.model,
      effort: opts.effort,
      dangerouslySkip: opts.dangerouslySkip ?? false,
      status: "running",
      createdAt: this.now(),
      permissionMode: opts.dangerouslySkip ? "bypassPermissions" : "default",
    };
    const record: SessionRecord = {
      meta,
      buffer: new ReplayBuffer(this.replayCapacity),
      listeners: new Set(),
      questionToolInputs: new Map(),
    };
    this.records.set(session.id, record);
    this.attach(session.process, record);
    this.persist(meta);
    return meta;
  }

  private attach(proc: ClaudeProcess, record: SessionRecord): void {
    const emit = (kind: ServerFrameKind, payload: unknown) => {
      const frame = record.buffer.push(kind, payload);
      for (const listener of record.listeners) listener(frame);
      if (this.onFrame) {
        try {
          this.onFrame(record.meta.id, frame);
        } catch {
          // a push-dispatch error must never unwind the claude process emit (spec §10)
        }
      }
    };
    proc.on("event", (ev: InboundEvent) => emit("event", ev));
    proc.on("permission", (perm: PermissionEvent) => emit("permission", perm));
    proc.on("question", (q: QuestionEvent) => {
      // SECURITY: remember the CLI's original tool_input for this requestId so answerQuestion
      // replays IT (not a client-echoed value) back into the CLI.
      record.questionToolInputs.set(q.requestId, q.toolInput);
      emit("question", q);
    });
    proc.on("result", (result: ResultEvent) => emit("result", result));
    proc.on("diagnostic", (diag: DiagnosticEvent) => emit("diagnostic", diag));
    // CRITICAL: Node's EventEmitter throws on an "error" event with no listener.
    // ClaudeProcess.write() emits "error" on write-after-teardown, so every managed
    // process MUST have an "error" listener. Fold it into a diagnostic frame (spec §10).
    proc.on("error", (err: Error) => {
      record.meta.status = "errored";
      emit("diagnostic", { source: "parser", message: err.message } satisfies DiagnosticEvent);
    });
    proc.on("exit", (info) => {
      if (record.meta.status !== "stopped") record.meta.status = "errored";
      emit("exit", info);
    });
  }

  listSessions(): SessionMeta[] {
    return [...this.records.values()].map((r) => r.meta);
  }

  getSession(id: string): SessionMeta | undefined {
    return this.records.get(id)?.meta;
  }

  /**
   * Conversation history for a session. Live/buffered frames win; for a dormant session whose
   * buffer is empty (e.g. just rehydrated after a restart) project the on-disk jsonl transcript
   * into event-kind frames so history survives a process restart.
   */
  async getHistory(id: string): Promise<ServerFrame[]> {
    const record = this.require(id);
    const buffered = record.buffer.snapshot();
    if (buffered.length > 0 || !this.history) return buffered;
    const turns = await this.history.read(record.meta.cwd, id);
    return turns.map((t, i) => ({
      seq: i + 1,
      kind: "event" as const,
      payload: { type: t.type, message: t.message, raw: t },
    }));
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
    this.store?.touch(id, this.now());
  }

  async answerPermission(id: string, requestId: string, decision: HookPermissionDecision, reason?: string): Promise<void> {
    await this.ensureLive(id);
    this.manager.answerPermission(id, requestId, decision, reason);
    // A skipped/denied AskUserQuestion routes through here (the web client sends a `deny`
    // permission for "Skip"), so the remembered tool_input would otherwise leak for the session
    // lifetime — answerQuestion deletes it on the answer path, mirror that on the cancel path.
    this.records.get(id)?.questionToolInputs.delete(requestId);
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

  stopSession(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.meta.status = "stopped";
    this.persist(record.meta);
    this.manager.stopSession(id);
  }

  /** Stop every live session — used by the server's onClose hook so no child `claude` is left running. */
  stopAll(): void {
    for (const id of this.records.keys()) this.stopSession(id);
  }

  /** Write the session's current meta to the durable store (no-op when no store is configured). */
  private persist(meta: SessionMeta): void {
    this.store?.upsert({
      id: meta.id,
      cwd: meta.cwd,
      model: meta.model,
      effort: meta.effort,
      dangerouslySkip: meta.dangerouslySkip,
      status: meta.status,
      createdAt: meta.createdAt,
      lastActivityAt: this.now(),
      permissionMode: meta.permissionMode,
    });
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
      };
      this.records.set(s.id, {
        meta,
        buffer: new ReplayBuffer(this.replayCapacity),
        listeners: new Set(),
        questionToolInputs: new Map(),
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
