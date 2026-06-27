import { randomUUID } from "node:crypto";
import { ClaudeProcess } from "./claude-process.js";
import type { ServerConfig, AttachSpawnOptions } from "./config.js";
import type { ContentBlock, HookPermissionDecision } from "@remote-coder/protocol";

export interface CreateSessionOptions {
  cwd: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  dangerouslySkip?: boolean;
  /** Permission mode (default | acceptEdits | plan); ignored when dangerouslySkip. */
  permissionMode?: string;
  /**
   * Resume a PAST claude session instead of starting a fresh one. When set, the spawned `claude` uses
   * `--resume <resumeId>` (not `--session-id`) and the new session is registered under THIS id (so its
   * transcript keeps appending to the same file). When absent, a fresh random id is assigned.
   */
  resumeId?: string;
}

export interface Session {
  id: string;
  cwd: string;
  process: ClaudeProcess;
}

/** Test-only injection so the manager can drive the interactive mock instead of the real binary. */
export interface SessionManagerDeps {
  spawnPrefixArgs?: string[];
  baseEnv?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
}

export class SessionManager {
  private readonly config: ServerConfig;
  private readonly deps: SessionManagerDeps;
  private readonly sessions = new Map<string, Session>();
  /**
   * mcp-send wiring applied to every spawned/resumed claude (so it can send files to the chat). Set
   * late by start.ts AFTER listen() resolves the real loopback URL (port 0 → OS-chosen port). When
   * undefined, spawns are exactly as before — the feature is additive.
   */
  private attach?: AttachSpawnOptions;

  constructor(config: ServerConfig, deps: SessionManagerDeps = {}) {
    this.config = config;
    this.deps = deps;
  }

  /** Provide (or clear) the mcp-send spawn config used for all subsequent create/resume spawns. */
  setAttachConfig(attach: AttachSpawnOptions | undefined): void {
    this.attach = attach;
  }

  async createSession(opts: CreateSessionOptions): Promise<Session> {
    // Resume reuses the past session's id (so claude --resume <id> reopens the same transcript);
    // a fresh session assigns a new random id via --session-id.
    const id = opts.resumeId ?? randomUUID();
    const proc = new ClaudeProcess({
      claudeBin: this.config.claudeBin,
      cwd: opts.cwd,
      sessionId: id,
      model: opts.model ?? this.config.defaultModel,
      effort: opts.effort ?? this.config.defaultEffort,
      addDirs: opts.addDirs,
      dangerouslySkip: opts.dangerouslySkip,
      permissionMode: opts.permissionMode,
      resume: opts.resumeId !== undefined,
      startTimeoutMs: this.deps.startTimeoutMs,
      env: this.deps.baseEnv,
      attach: this.attach,
    });
    if (this.deps.spawnPrefixArgs) proc.setSpawnPrefixArgsForTest(this.deps.spawnPrefixArgs);

    const session: Session = { id, cwd: opts.cwd, process: proc };
    // Drop a dead session from the map automatically — but ONLY if it's still THIS session. A respawn
    // (resumeSession reuses the id) replaces the map entry, so the OLD process's late exit must not
    // delete the new live one (which would orphan an untracked claude child).
    proc.on("exit", () => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    });

    await proc.start();
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Re-attach to an existing (dormant/dead) session: spawn `claude --resume <id>` in the SAME cwd
   * and register the live process under the SAME id. Used by the hub when a message targets a
   * session whose process is gone (after a restart or crash). The caller supplies the real cwd
   * (stored alongside the session — never reverse-derived from the lossy transcript dir name).
   */
  async resumeSession(
    id: string,
    opts: {
      cwd: string;
      model?: string;
      effort?: string;
      dangerouslySkip?: boolean;
      /** Permission mode to re-apply on the re-attach (default | acceptEdits | plan). */
      permissionMode?: string;
      addDirs?: string[];
      /** REWIND (conversation/both): resume truncated at this checkpoint uuid (--resume-session-at). */
      resumeSessionAt?: string;
      /** REWIND (both): also one-shot rewind files to this checkpoint uuid on resume (--rewind-files). */
      rewindFilesAt?: string;
    },
  ): Promise<Session> {
    const proc = new ClaudeProcess({
      claudeBin: this.config.claudeBin,
      cwd: opts.cwd,
      sessionId: id,
      model: opts.model ?? this.config.defaultModel,
      effort: opts.effort ?? this.config.defaultEffort,
      dangerouslySkip: opts.dangerouslySkip,
      permissionMode: opts.permissionMode,
      addDirs: opts.addDirs,
      resume: true,
      resumeSessionAt: opts.resumeSessionAt,
      rewindFilesAt: opts.rewindFilesAt,
      startTimeoutMs: this.deps.startTimeoutMs,
      env: this.deps.baseEnv,
      attach: this.attach,
    });
    if (this.deps.spawnPrefixArgs) proc.setSpawnPrefixArgsForTest(this.deps.spawnPrefixArgs);
    const session: Session = { id, cwd: opts.cwd, process: proc };
    // Only drop THIS session on exit — a later respawn reuses the id, and the old proc's late exit must
    // not evict the new live session (orphaning an untracked claude child). See createSession.
    proc.on("exit", () => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    });
    await proc.start();
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  sendMessage(id: string, content: string | ContentBlock[]): void {
    this.require(id).process.sendUserMessage(content);
  }

  answerPermission(id: string, requestId: string, decision: HookPermissionDecision, reason?: string): void {
    this.require(id).process.answerPermission(requestId, decision, reason);
  }

  answerQuestion(id: string, requestId: string, toolInput: unknown, answers: Record<string, string | string[]>): void {
    this.require(id).process.answerQuestion(requestId, toolInput, answers);
  }

  setModel(id: string, model: string): void {
    this.require(id).process.setModel(model);
  }

  setMaxThinkingTokens(id: string, maxThinkingTokens: number | null): void {
    this.require(id).process.setMaxThinkingTokens(maxThinkingTokens);
  }

  setPermissionMode(id: string, mode: string): void {
    this.require(id).process.setPermissionMode(mode);
  }

  /** Interrupt (STOP) the current turn of a live session (does not kill the process). */
  interrupt(id: string): void {
    this.require(id).process.interrupt();
  }

  /** REWIND (code): live rewind tracked files to a checkpoint uuid. Resolves with the CLI's result. */
  rewindFiles(id: string, userMessageId: string, opts: { dryRun?: boolean } = {}) {
    return this.require(id).process.rewindFiles(userMessageId, opts);
  }

  stopSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.process.stop();
    this.sessions.delete(id);
  }

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown session: ${id}`);
    return session;
  }
}
