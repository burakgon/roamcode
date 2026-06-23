import { SessionManager } from "./session-manager.js";
import { ReplayBuffer } from "./replay-buffer.js";
import type { ServerFrame, ServerFrameKind } from "./replay-buffer.js";
import type { CreateSessionOptions } from "./session-manager.js";
import type { ClaudeProcess, PermissionEvent, QuestionEvent, DiagnosticEvent } from "./claude-process.js";
import type { ContentBlock, HookPermissionDecision, InboundEvent, ResultEvent } from "@remote-coder/protocol";

export type SessionStatus = "running" | "errored" | "stopped";

export interface SessionMeta {
  id: string;
  cwd: string;
  model?: string;
  effort?: string;
  dangerouslySkip: boolean;
  status: SessionStatus;
  createdAt: number;
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
}

export interface SessionHubOptions {
  replayCapacity?: number;
  now?: () => number;
}

export class SessionHub {
  private readonly manager: SessionManager;
  private readonly replayCapacity: number;
  private readonly now: () => number;
  private readonly records = new Map<string, SessionRecord>();

  constructor(manager: SessionManager, opts: SessionHubOptions = {}) {
    this.manager = manager;
    this.replayCapacity = opts.replayCapacity ?? 200;
    this.now = opts.now ?? Date.now;
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
    };
    const record: SessionRecord = {
      meta,
      buffer: new ReplayBuffer(this.replayCapacity),
      listeners: new Set(),
    };
    this.records.set(session.id, record);
    this.attach(session.process, record);
    return meta;
  }

  private attach(proc: ClaudeProcess, record: SessionRecord): void {
    const emit = (kind: ServerFrameKind, payload: unknown) => {
      const frame = record.buffer.push(kind, payload);
      for (const listener of record.listeners) listener(frame);
    };
    proc.on("event", (ev: InboundEvent) => emit("event", ev));
    proc.on("permission", (perm: PermissionEvent) => emit("permission", perm));
    proc.on("question", (q: QuestionEvent) => emit("question", q));
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

  getHistory(id: string): ServerFrame[] {
    return this.require(id).buffer.snapshot();
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

  sendMessage(id: string, content: string | ContentBlock[]): void {
    this.require(id);
    this.manager.sendMessage(id, content);
  }

  answerPermission(id: string, requestId: string, decision: HookPermissionDecision, reason?: string): void {
    this.require(id);
    this.manager.answerPermission(id, requestId, decision, reason);
  }

  answerQuestion(id: string, requestId: string, toolInput: unknown, answers: Record<string, string | string[]>): void {
    this.require(id);
    this.manager.answerQuestion(id, requestId, toolInput, answers);
  }

  /**
   * Apply live settings to a running session: send each provided control to the CLI and mirror the
   * change into the in-memory SessionMeta so a subsequent getSession reflects it.
   */
  applySettings(id: string, settings: LiveSettings): SessionMeta {
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
    }
    return record.meta;
  }

  stopSession(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.meta.status = "stopped";
    this.manager.stopSession(id);
  }

  /** Stop every live session — used by the server's onClose hook so no child `claude` is left running. */
  stopAll(): void {
    for (const id of this.records.keys()) this.stopSession(id);
  }

  private require(id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);
    return record;
  }
}
