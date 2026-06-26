import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  parseLine,
  serializeInitialize,
  serializeUserMessage,
  serializeHookPermissionResponse,
  serializeCanUseToolResponse,
  classifyPermissionRequest,
  classifyQuestionRequest,
  serializeHookQuestionAnswer,
  serializeSetModel,
  serializeSetMaxThinkingTokens,
  serializeSetPermissionMode,
  serializeInterrupt,
  serializeRewindFiles,
  ProtocolParseError,
} from "@remote-coder/protocol";
import type {
  InboundEvent,
  ResultEvent,
  ControlRequestEvent,
  ContentBlock,
  HookPermissionDecision,
  CanUseToolResult,
  QuestionSpec,
} from "@remote-coder/protocol";
import { buildClaudeArgs, buildMcpConfigDocument, mcpConfigPathFor } from "./config.js";
import type { AttachSpawnOptions } from "./config.js";

export interface ClaudeProcessOptions {
  claudeBin: string;
  cwd: string;
  sessionId: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  dangerouslySkip?: boolean;
  /** Resume an existing session via --resume <id> (re-attach after process death). Default false. */
  resume?: boolean;
  /** REWIND (conversation/both): resume the session truncated at this checkpoint uuid (--resume-session-at). */
  resumeSessionAt?: string;
  /** REWIND (both): also one-shot rewind files to this checkpoint uuid on resume (--rewind-files). */
  rewindFilesAt?: string;
  /** Milliseconds to wait for the init control_response before rejecting start(). Default 30000. */
  startTimeoutMs?: number;
  /** Base environment to spawn with. ANTHROPIC_API_KEY is always deleted from a copy. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** When set, load the mcp-send server so claude can send files/images to the chat. */
  attach?: AttachSpawnOptions;
}

export interface PermissionEvent {
  requestId: string;
  kind: "hook_callback" | "can_use_tool";
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
}

export interface QuestionEvent {
  requestId: string;
  toolUseId?: string;
  toolInput: unknown;
  questions: QuestionSpec[];
}

export interface DiagnosticEvent {
  source: "stderr" | "parser";
  message: string;
}

/**
 * Result of a `rewind_files` control_request. `ok:false` means the CLI rejected the rewind (e.g. file
 * checkpointing wasn't enabled) with an `error`. `ok:true` carries the CLI's structured outcome: `canRewind`
 * plus optional file-change stats (the @anthropic-ai/claude-agent-sdk `RewindFilesResult` shape).
 */
export interface RewindFilesResult {
  ok: boolean;
  canRewind?: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ClaudeProcess extends EventEmitter {
  readonly sessionId: string;
  private readonly opts: ClaudeProcessOptions;
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private started = false;
  private initRequestId?: string;
  private spawnPrefixArgs: string[] = [];
  private suppressWarmup: boolean;
  /** Path of the per-session 0600 MCP config file written for this spawn, removed on exit/stop. */
  private mcpConfigPath?: string;
  /** Per-requestId kind + toolInput for an OUTSTANDING permission, so a MANUAL answer uses the right wire
   *  shape — a `can_use_tool` request must get a CanUseToolResult, not a PreToolUse-hook response. */
  private readonly pendingPermissions = new Map<string, { kind: PermissionEvent["kind"]; toolInput: unknown }>();

  constructor(opts: ClaudeProcessOptions) {
    super();
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.suppressWarmup = opts.resume === true;
  }

  /** TEST ONLY: extra argv inserted before the claude args (used to run the mock script via node). */
  setSpawnPrefixArgsForTest(args: string[]): void {
    this.spawnPrefixArgs = args;
  }

  /** TEST ONLY: push a raw stdout line through the same path the child uses. */
  ingestLineForTest(line: string): void {
    this.handleLine(line);
  }

  start(): Promise<void> {
    if (this.started) throw new Error("ClaudeProcess already started");
    this.started = true;

    // Stability first: write the per-session 0600 MCP config file BEFORE building args. If the write
    // fails, degrade gracefully — log a diagnostic and spawn WITHOUT --mcp-config (the session still
    // works, just without the send-file tool) rather than failing the whole spawn. The token thus
    // lives only inside that 0600 file and never enters any process's argv.
    const mcpConfigPath = this.opts.attach ? this.writeMcpConfigFile(this.opts.attach) : undefined;

    const claudeArgs = buildClaudeArgs({
      sessionId: this.opts.sessionId,
      model: this.opts.model,
      effort: this.opts.effort,
      addDirs: this.opts.addDirs,
      dangerouslySkip: this.opts.dangerouslySkip,
      resume: this.opts.resume,
      resumeSessionAt: this.opts.resumeSessionAt,
      rewindFilesAt: this.opts.rewindFilesAt,
      mcpConfigPath,
    });
    const args = [...this.spawnPrefixArgs, ...claudeArgs];

    // Subscription auth only: never pass an API key to the child.
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env) };
    delete env.ANTHROPIC_API_KEY;
    // REWIND/CHECKPOINT enable: file checkpointing is gated by an ENV VAR on the spawned CLI, NOT a CLI
    // flag, a --settings field, or an initialize field. Found by deobfuscating @anthropic-ai/claude-agent-sdk
    // 0.3.191: its `enableFileCheckpointing` option maps to `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING="true"`
    // on the child env (`if(cn)ut.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING="true"`). LIVE-VALIDATED: with
    // this set, the `rewind_files` control_request restores files (without it the CLI replies
    // `{subtype:"error",error:"File rewinding is not enabled."}`). Always-on so every session is rewindable.
    env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "true";

    const child = spawn(this.opts.claudeBin, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.onStderrChunk(chunk));
    child.on("error", (err) => this.emit("error", err));
    child.on("exit", (code, signal) => {
      // Best-effort cleanup so per-session config files don't accumulate. A leftover file after a
      // crash is harmless (0600, overwritten on the next spawn), but the normal exit path removes it.
      this.cleanupMcpConfigFile();
      this.emit("exit", { code, signal });
    });

    const timeoutMs = this.opts.startTimeoutMs ?? 30000;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.stop();
        reject(new Error(`claude did not respond to initialize within ${timeoutMs}ms`));
      }, timeoutMs);

      const onEvent = (ev: InboundEvent) => {
        if (ev.type === "control_response" && ev.requestId === this.initRequestId) {
          cleanup();
          resolve();
        }
      };
      const onEarlyExit = () => {
        cleanup();
        reject(new Error("claude exited before completing the initialize handshake"));
      };
      const onEarlyError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("event", onEvent);
        this.off("exit", onEarlyExit);
        this.off("error", onEarlyError);
      };
      this.on("event", onEvent);
      this.once("exit", onEarlyExit);
      this.once("error", onEarlyError);

      // Send the initialize handshake (registers the PreToolUse hook).
      this.initRequestId = `init-${this.opts.sessionId}`;
      this.write(serializeInitialize({ requestId: this.initRequestId }));
    });
  }

  sendUserMessage(content: string | ContentBlock[]): void {
    this.write(serializeUserMessage(content));
  }

  answerPermission(requestId: string, decision: HookPermissionDecision, reason?: string): void {
    const pending = this.pendingPermissions.get(requestId);
    this.pendingPermissions.delete(requestId);
    // A `can_use_tool` request (e.g. an MCP tool gate) MUST be answered with a CanUseToolResult — the
    // PreToolUse-hook shape would be malformed for it and could stall the turn. Mirror the auto-allow.
    if (pending?.kind === "can_use_tool") {
      this.answerCanUseTool(
        requestId,
        decision === "allow"
          ? { behavior: "allow", updatedInput: pending.toolInput }
          : { behavior: "deny", message: reason ?? "Denied by the user." },
      );
      return;
    }
    this.write(serializeHookPermissionResponse(requestId, decision, reason));
  }

  answerCanUseTool(requestId: string, result: CanUseToolResult): void {
    this.write(serializeCanUseToolResponse(requestId, result));
  }

  /** Answer an AskUserQuestion: allow + the chosen answers merged into the tool input. */
  answerQuestion(requestId: string, toolInput: unknown, answers: Record<string, string | string[]>): void {
    this.write(serializeHookQuestionAnswer(requestId, toolInput, answers));
  }

  setModel(model: string): void {
    this.write(serializeSetModel(model));
  }

  setMaxThinkingTokens(maxThinkingTokens: number | null, thinkingDisplay?: "summarized" | "omitted" | null): void {
    this.write(
      serializeSetMaxThinkingTokens(maxThinkingTokens, thinkingDisplay === undefined ? {} : { thinkingDisplay }),
    );
  }

  setPermissionMode(mode: string): void {
    this.write(serializeSetPermissionMode(mode));
  }

  /**
   * Interrupt (STOP) the current turn without killing the process. Writes an `interrupt` control_request
   * on the CLI's stdin; the CLI aborts the in-flight turn and ends it with a `result` whose
   * `terminal_reason` is `aborted_streaming` (which already flows through the existing `result` handler,
   * settling state). The session stays open and accepts the next user message.
   */
  interrupt(): void {
    this.write(serializeInterrupt());
  }

  /**
   * Rewind tracked FILES to their state at a checkpoint (a user-message uuid). Sends the LIVE-VALIDATED
   * `rewind_files` control_request and resolves with the CLI's structured result. Files created after the
   * checkpoint are deleted, files modified are restored (Bash changes are NOT tracked, and the conversation
   * is NOT touched — that's the resume-respawn path). Requires file checkpointing, which is enabled via the
   * `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` env var the start() spawn sets; without it the CLI replies
   * with `{ subtype:"error", error:"File rewinding is not enabled." }`, surfaced here as `ok:false`.
   *
   * Resolves when the matching control_response arrives, or rejects after `timeoutMs` (default 30s).
   */
  rewindFiles(userMessageId: string, opts: { dryRun?: boolean; timeoutMs?: number } = {}): Promise<RewindFilesResult> {
    const requestId = `rewind-${randomUUID()}`;
    const timeoutMs = opts.timeoutMs ?? 30000;
    return new Promise<RewindFilesResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`rewind_files did not get a control_response within ${timeoutMs}ms`));
      }, timeoutMs);
      const onEvent = (ev: InboundEvent) => {
        if (ev.type !== "control_response" || ev.requestId !== requestId) return;
        cleanup();
        // Success: the inner `response` is the RewindFilesResult `{ canRewind, filesChanged?, ... }`.
        // Error: the CLI sends `{ subtype:"error", error }` (e.g. checkpointing disabled).
        if (ev.subtype === "error") {
          const error = typeof ev.response.error === "string" ? ev.response.error : "rewind failed";
          resolve({ ok: false, error });
          return;
        }
        const inner = (ev.response.response ?? {}) as Record<string, unknown>;
        resolve({
          ok: true,
          canRewind: inner.canRewind === true,
          ...(typeof inner.error === "string" ? { error: inner.error } : {}),
          ...(Array.isArray(inner.filesChanged) ? { filesChanged: inner.filesChanged as string[] } : {}),
          ...(typeof inner.insertions === "number" ? { insertions: inner.insertions } : {}),
          ...(typeof inner.deletions === "number" ? { deletions: inner.deletions } : {}),
        });
      };
      const onExit = () => {
        cleanup();
        reject(new Error("claude exited before answering rewind_files"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("event", onEvent);
        this.off("exit", onExit);
      };
      this.on("event", onEvent);
      this.once("exit", onExit);
      this.write(serializeRewindFiles(userMessageId, { dryRun: opts.dryRun, requestId }));
    });
  }

  stop(): void {
    // A never-started or already-exited process emits no further "exit" event, so clean up the config
    // file here too (idempotent — the exit handler may have already removed it).
    this.cleanupMcpConfigFile();
    if (!this.child || this.child.killed) return;
    // Keep-alive teardown: close stdin first so the child can exit cleanly, then kill.
    if (this.child.stdin.writable) this.child.stdin.end();
    this.child.kill();
  }

  /**
   * Write the per-session MCP config to `<dataDir>/mcp-config-<id>.json` with mode 0600 and return its
   * path. The `mode` arg to writeFileSync is honored only when CREATING the file; a chmod afterwards
   * unconditionally enforces 0600 even when overwriting (mirrors the token-file pattern in data-dir.ts)
   * so the access token inside can never land in a too-permissive file. On any failure, log a
   * diagnostic and return undefined so the caller spawns without --mcp-config (graceful degrade).
   *
   * SECURITY (known limitation): the config embeds the FULL RC access token, and `claude` runs as the
   * same user, so a prompt-injected/compromised model could read this file (or the mcp-send child's env)
   * and exfiltrate the token for persistent remote API access. This is largely inherent (claude already
   * runs host commands), but the token is a stronger credential than a single session. Hardening it
   * properly needs a dedicated feature — a SHORT-LIVED, session-SCOPED token accepted only for this
   * session's /attach + /ask — which is tracked separately rather than rushed into the auth layer here.
   */
  private writeMcpConfigFile(attach: AttachSpawnOptions): string | undefined {
    const path = mcpConfigPathFor(attach.dataDir, this.opts.sessionId);
    try {
      const doc = buildMcpConfigDocument(this.opts.sessionId, attach);
      writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
      chmodSync(path, 0o600);
      this.mcpConfigPath = path;
      return path;
    } catch (err) {
      this.emit("diagnostic", {
        source: "parser",
        message: `failed to write mcp-config for session ${this.sessionId}; spawning without attachments: ${
          (err as Error).message
        }`,
      });
      this.mcpConfigPath = undefined;
      return undefined;
    }
  }

  /** Remove the per-session MCP config file. Best-effort + idempotent (clears the tracked path). */
  private cleanupMcpConfigFile(): void {
    if (!this.mcpConfigPath) return;
    const path = this.mcpConfigPath;
    this.mcpConfigPath = undefined;
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort: a leftover 0600 file is harmless and overwritten on the next spawn.
    }
  }

  private write(line: string): void {
    if (!this.child || !this.child.stdin.writable) {
      // Write after teardown: surface a clear error, never crash (spec §10).
      this.emit("error", new Error(`write after teardown (session ${this.sessionId})`));
      return;
    }
    this.child.stdin.write(line + "\n");
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      this.handleLine(line);
    }
    // Guard a pathological no-newline stream (a malformed/runaway frame) from growing the buffer without
    // bound: well past the largest legitimate single-line frame, drop it + surface a diagnostic.
    if (this.stdoutBuffer.length > 64 * 1024 * 1024) {
      this.stdoutBuffer = "";
      this.emit("diagnostic", {
        source: "parser",
        message: "dropped an over-long stdout line (exceeded 64MB with no newline)",
      });
    }
  }

  private onStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk;
    let nl: number;
    while ((nl = this.stderrBuffer.indexOf("\n")) !== -1) {
      const line = this.stderrBuffer.slice(0, nl);
      this.stderrBuffer = this.stderrBuffer.slice(nl + 1);
      if (line.trim()) this.emit("diagnostic", { source: "stderr", message: line });
    }
  }

  private handleLine(line: string): void {
    let ev: InboundEvent | null;
    try {
      ev = parseLine(line);
    } catch (err) {
      if (err instanceof ProtocolParseError) {
        // Malformed line: surface as a diagnostic + skip, never crash (spec §10).
        this.emit("diagnostic", { source: "parser", message: err.message });
        return;
      }
      throw err;
    }
    if (!ev) return;

    if (this.suppressWarmup && this.isWarmupTurn(ev)) {
      // --resume injects a synthetic "Continue from where you left off." user turn and a
      // "No response requested." assistant reply (docs/protocol-notes.md §B). Drop both so
      // they never reach subscribers. After the assistant half, the suppression window closes.
      if (ev.type === "assistant") this.suppressWarmup = false;
      return;
    }

    this.emit("event", ev);

    if (ev.type === "control_request") {
      const question = classifyQuestionRequest(ev as ControlRequestEvent);
      if (question) {
        this.emit("question", {
          requestId: question.requestId,
          toolUseId: question.toolUseId,
          toolInput: question.toolInput,
          questions: question.questions,
        } satisfies QuestionEvent);
        return;
      }
      const info = classifyPermissionRequest(ev as ControlRequestEvent);
      if (info) {
        const requestId = (ev as ControlRequestEvent).requestId;
        // --dangerously-skip-permissions only bypasses claude's OWN interactive prompt; the SDK's
        // canUseTool callback / our PreToolUse hook still fire and reach us as a control_request. For
        // a dangerouslySkip session the user explicitly opted out of approving tools, so auto-allow
        // every request HERE (answering with the same shape a manual "Allow" would) instead of
        // surfacing a permission prompt to the client. Questions (AskUserQuestion) are handled above
        // and are NOT auto-answered — those are genuine asks, not a tool gate.
        if (this.opts.dangerouslySkip) {
          if (info.kind === "can_use_tool") {
            this.answerCanUseTool(requestId, { behavior: "allow", updatedInput: info.toolInput });
          } else {
            this.answerPermission(requestId, "allow");
          }
          return;
        }
        const perm: PermissionEvent = {
          requestId,
          kind: info.kind,
          toolName: info.toolName,
          toolInput: info.toolInput,
          toolUseId: info.toolUseId,
        };
        // Remember the kind + toolInput so a later MANUAL answerPermission picks the correct wire shape.
        this.pendingPermissions.set(requestId, { kind: info.kind, toolInput: info.toolInput });
        this.emit("permission", perm);
      }
      return;
    }

    if (ev.type === "result") {
      // Multi-turn keep-alive: `result` only marks turn completion. The process
      // stays alive for the next sendUserMessage; stdin is closed only in stop().
      this.emit("result", ev as ResultEvent);
    }
  }

  private isWarmupTurn(ev: InboundEvent): boolean {
    const text = this.soleText(ev);
    if (text === undefined) return false;
    return text === "Continue from where you left off." || text === "No response requested.";
  }

  /** Extract the single text-block string of a user/assistant message, else undefined. */
  private soleText(ev: InboundEvent): string | undefined {
    if (ev.type !== "user" && ev.type !== "assistant") return undefined;
    const message = (ev as { message?: { content?: unknown } }).message;
    const content = message?.content;
    if (!Array.isArray(content) || content.length !== 1) return undefined;
    const block = content[0] as { type?: string; text?: string };
    return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
  }
}

// Typed event overloads.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ClaudeProcess {
  on(event: "event", listener: (ev: InboundEvent) => void): this;
  on(event: "permission", listener: (perm: PermissionEvent) => void): this;
  on(event: "question", listener: (q: QuestionEvent) => void): this;
  on(event: "result", listener: (result: ResultEvent) => void): this;
  on(event: "diagnostic", listener: (diag: DiagnosticEvent) => void): this;
  on(event: "exit", listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  once(event: "event", listener: (ev: InboundEvent) => void): this;
  once(event: "permission", listener: (perm: PermissionEvent) => void): this;
  once(event: "question", listener: (q: QuestionEvent) => void): this;
  once(event: "result", listener: (result: ResultEvent) => void): this;
  once(event: "diagnostic", listener: (diag: DiagnosticEvent) => void): this;
  once(event: "exit", listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  emit(event: "event", ev: InboundEvent): boolean;
  emit(event: "permission", perm: PermissionEvent): boolean;
  emit(event: "question", q: QuestionEvent): boolean;
  emit(event: "result", result: ResultEvent): boolean;
  emit(event: "diagnostic", diag: DiagnosticEvent): boolean;
  emit(event: "exit", info: { code: number | null; signal: NodeJS.Signals | null }): boolean;
  emit(event: "error", err: Error): boolean;
}
