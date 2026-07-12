import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { z, type ZodType } from "zod";

export const CODEX_METADATA_ERROR_CODE = "CODEX_METADATA_UNAVAILABLE" as const;
export const DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS = 15_000;
export const DEFAULT_CODEX_APP_SERVER_MAX_STDOUT_LINE_BYTES = 1024 * 1024;
export const DEFAULT_CODEX_APP_SERVER_MAX_STDOUT_BUFFER_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CODEX_APP_SERVER_MAX_STDERR_BYTES = 64 * 1024;

type DiagnosticIssue =
  | "exit"
  | "malformed_json"
  | "notification_listener"
  | "spawn"
  | "stderr_limit"
  | "stdout_limit"
  | "transport_error"
  | "unknown_message"
  | "write_error";

export interface CodexMetadataDiagnostics {
  readonly lastIssue?: DiagnosticIssue;
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
}

export interface CodexAppServerNotification {
  readonly method: string;
  readonly params?: unknown;
}

interface WritableTransport extends EventEmitter {
  write(value: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
  end(): void;
}

type ReadableTransport = EventEmitter;

/** The intentionally small child-process surface used by the protocol client and its fake tests. */
export interface CodexAppServerTransport extends EventEmitter {
  readonly stdin: WritableTransport;
  readonly stdout: ReadableTransport;
  readonly stderr: ReadableTransport;
  kill(signal?: NodeJS.Signals): boolean | void;
}

export type SpawnCodexAppServerTransport = (
  command: string,
  args: readonly string[],
  options?: { readonly env?: NodeJS.ProcessEnv },
) => CodexAppServerTransport;

export interface CodexAppServerClientOptions {
  readonly codexBin?: string;
  /** Selects one validated `$CODEX_HOME/<name>.config.toml` layer before app-server starts. */
  readonly profile?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnTransport?: SpawnCodexAppServerTransport;
  readonly timeoutMs?: number;
  readonly maxStdoutLineBytes?: number;
  readonly maxStdoutBufferBytes?: number;
  readonly maxStderrBytes?: number;
}

export class CodexMetadataUnavailableError extends Error {
  readonly code = CODEX_METADATA_ERROR_CODE;

  constructor() {
    super("Codex metadata is unavailable");
    this.name = "CodexMetadataUnavailableError";
  }
}

const JsonRpcSuccessSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.number().int().nonnegative(),
  result: z.unknown(),
});

const JsonRpcErrorSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.number().int().nonnegative(),
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});

const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const InitializeResultSchema = z.unknown();

interface PendingRequest<T = unknown> {
  readonly schema: ZodType<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: CodexMetadataUnavailableError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface QueuedWrite {
  readonly frame: string;
  readonly resolve: () => void;
  readonly reject: (error: CodexMetadataUnavailableError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Generation {
  readonly number: number;
  readonly transport: CodexAppServerTransport;
  readonly pending: Map<number, PendingRequest>;
  readonly writeQueue: QueuedWrite[];
  stdoutBuffer: Buffer;
  stderrBytes: number;
  stderrTruncated: boolean;
  phase: "starting" | "running";
  closed: boolean;
  writing: boolean;
  drainListener?: () => void;
  readonly listeners: {
    readonly stdoutData: (chunk: Buffer | string) => void;
    readonly stderrData: (chunk: Buffer | string) => void;
    readonly exit: () => void;
    readonly error: () => void;
    readonly stdinError: () => void;
    readonly stdoutError: () => void;
    readonly stderrError: () => void;
  };
}

function unavailable(): CodexMetadataUnavailableError {
  return new CodexMetadataUnavailableError();
}

// Node writable streams may invoke a failed write callback and emit `error` afterwards. This
// closure-free sink deliberately stays on a dead transport so that late stream errors can never
// become uncaught host-process exceptions after the generation's active listeners are removed.
const absorbLateTransportError = (): void => {};

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function defaultSpawnTransport(
  command: string,
  args: readonly string[],
  options?: { readonly env?: NodeJS.ProcessEnv },
): CodexAppServerTransport {
  return spawn(command, [...args], { env: options?.env, stdio: ["pipe", "pipe", "pipe"] }) as CodexAppServerTransport;
}

/**
 * Bounded JSON-lines client for the auxiliary Codex app-server metadata channel.
 * It never participates in terminal streaming and deliberately knows no method-specific result schemas.
 */
export class CodexAppServerClient {
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxStdoutLineBytes: number;
    readonly maxStdoutBufferBytes: number;
    readonly maxStderrBytes: number;
  };

  private readonly codexBin: string;
  private readonly profile?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly spawnTransport: SpawnCodexAppServerTransport;
  private readonly notificationListeners = new Set<(notification: CodexAppServerNotification) => void>();
  private active?: Generation;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private nextRequestId = 1;
  private nextGeneration = 1;
  private lastDiagnostics: CodexMetadataDiagnostics = { stderrBytes: 0, stderrTruncated: false };

  constructor(options: CodexAppServerClientOptions = {}) {
    this.codexBin = options.codexBin ?? "codex";
    this.env = options.env ? { ...options.env } : undefined;
    if (
      options.profile !== undefined &&
      (options.profile.length === 0 ||
        options.profile.length > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.profile))
    ) {
      throw unavailable();
    }
    this.profile = options.profile;
    this.spawnTransport = options.spawnTransport ?? defaultSpawnTransport;
    const maxStdoutLineBytes = positiveInteger(
      options.maxStdoutLineBytes,
      DEFAULT_CODEX_APP_SERVER_MAX_STDOUT_LINE_BYTES,
    );
    this.limits = {
      timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS),
      maxStdoutLineBytes,
      maxStdoutBufferBytes: positiveInteger(
        options.maxStdoutBufferBytes,
        DEFAULT_CODEX_APP_SERVER_MAX_STDOUT_BUFFER_BYTES,
      ),
      maxStderrBytes: positiveInteger(options.maxStderrBytes, DEFAULT_CODEX_APP_SERVER_MAX_STDERR_BYTES),
    };
  }

  get diagnostics(): CodexMetadataDiagnostics {
    const generation = this.active;
    return generation
      ? {
          ...this.lastDiagnostics,
          stderrBytes: generation.stderrBytes,
          stderrTruncated: generation.stderrTruncated,
        }
      : { ...this.lastDiagnostics };
  }

  start(): Promise<void> {
    if (this.active?.phase === "running" && !this.active.closed) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) return this.stopPromise.then(() => this.start());

    let transport: CodexAppServerTransport;
    try {
      transport = this.spawnTransport(
        this.codexBin,
        this.profile ? ["--profile", this.profile, "app-server", "--stdio"] : ["app-server", "--stdio"],
        { env: this.env ? { ...this.env } : undefined },
      );
    } catch {
      this.recordIssue("spawn");
      return Promise.reject(unavailable());
    }

    const generation = this.createGeneration(transport);
    this.active = generation;
    this.lastDiagnostics = { stderrBytes: 0, stderrTruncated: false };
    this.installListeners(generation);

    const promise = this.sendRequest(
      generation,
      "initialize",
      {
        clientInfo: { name: "roamcode", title: "RoamCode", version: "0.0.0" },
        capabilities: {},
      },
      InitializeResultSchema,
    )
      .then(() => this.writeFrame(generation, { method: "initialized", params: {} }))
      .then(() => {
        if (generation.closed || this.active !== generation) throw unavailable();
        generation.phase = "running";
      })
      .catch(() => {
        if (!generation.closed) this.failGeneration(generation, "transport_error", true);
        throw unavailable();
      });

    this.startPromise = promise;
    void promise.then(
      () => {
        if (this.startPromise === promise) this.startPromise = undefined;
      },
      () => {
        if (this.startPromise === promise) this.startPromise = undefined;
      },
    );
    return promise;
  }

  request<T>(method: string, params: unknown, schema: ZodType<T>): Promise<T> {
    const generation = this.active;
    if (!generation || generation.closed || generation.phase !== "running" || !method) {
      return Promise.reject(unavailable());
    }
    return this.sendRequest(generation, method, params, schema);
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const promise = Promise.resolve();
    this.stopPromise = promise;
    const generation = this.active;
    if (generation) this.failGeneration(generation, "transport_error", true, true);
    void promise.then(() => {
      if (this.stopPromise === promise) this.stopPromise = undefined;
    });
    return promise;
  }

  private createGeneration(transport: CodexAppServerTransport): Generation {
    const generation: Generation = {
      number: this.nextGeneration++,
      transport,
      pending: new Map<number, PendingRequest>(),
      writeQueue: [],
      stdoutBuffer: Buffer.alloc(0),
      stderrBytes: 0,
      stderrTruncated: false,
      phase: "starting" as const,
      closed: false,
      writing: false,
      listeners: {
        stdoutData: (chunk) => this.onStdout(generation, chunk),
        stderrData: (chunk) => this.onStderr(generation, chunk),
        exit: () => this.failGeneration(generation, "exit", false),
        error: () => this.failGeneration(generation, "transport_error", true),
        stdinError: () => this.failGeneration(generation, "write_error", true),
        stdoutError: () => this.failGeneration(generation, "transport_error", true),
        stderrError: () => this.failGeneration(generation, "transport_error", true),
      },
    };
    return generation;
  }

  private installListeners(generation: Generation): void {
    const { transport, listeners } = generation;
    transport.on("error", absorbLateTransportError);
    transport.stdin.on("error", absorbLateTransportError);
    transport.stdout.on("error", absorbLateTransportError);
    transport.stderr.on("error", absorbLateTransportError);
    transport.stdout.on("data", listeners.stdoutData);
    transport.stderr.on("data", listeners.stderrData);
    transport.on("exit", listeners.exit);
    transport.on("error", listeners.error);
    transport.stdin.on("error", listeners.stdinError);
    transport.stdout.on("error", listeners.stdoutError);
    transport.stderr.on("error", listeners.stderrError);
  }

  private sendRequest<T>(generation: Generation, method: string, params: unknown, schema: ZodType<T>): Promise<T> {
    if (generation.closed || this.active !== generation) return Promise.reject(unavailable());
    const id = this.nextRequestId++;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.failGeneration(generation, "transport_error", true), this.limits.timeoutMs);
      generation.pending.set(id, {
        schema: schema as ZodType<unknown>,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    const written = this.writeFrame(generation, { id, method, params }).catch(() => {
      if (!generation.closed) {
        this.failGeneration(generation, "write_error", true);
      }
      throw unavailable();
    });
    return Promise.all([written, response]).then(([, value]) => value);
  }

  private writeFrame(generation: Generation, value: unknown): Promise<void> {
    if (generation.closed || this.active !== generation) return Promise.reject(unavailable());
    let frame: string;
    try {
      frame = `${JSON.stringify(value)}\n`;
    } catch {
      return Promise.reject(unavailable());
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!generation.closed) this.failGeneration(generation, "write_error", true);
      }, this.limits.timeoutMs);
      generation.writeQueue.push({ frame, resolve, reject, timer });
      this.flushWrites(generation);
    });
  }

  private flushWrites(generation: Generation): void {
    if (generation.closed || generation.writing) return;
    const entry = generation.writeQueue[0];
    if (!entry) return;

    generation.writing = true;
    let callbackDone = false;
    let drainDone = false;
    let writeReturned = false;
    let settled = false;

    const finish = () => {
      if (settled || generation.closed || !writeReturned || !callbackDone || !drainDone) return;
      settled = true;
      generation.writeQueue.shift();
      generation.writing = false;
      clearTimeout(entry.timer);
      entry.resolve();
      this.flushWrites(generation);
    };

    try {
      const accepted = generation.transport.stdin.write(entry.frame, (error) => {
        if (generation.closed) return;
        if (error) {
          this.failGeneration(generation, "write_error", true);
          return;
        }
        callbackDone = true;
        finish();
      });
      writeReturned = true;
      if (generation.closed) return;
      if (accepted) {
        drainDone = true;
      } else {
        const onDrain = () => {
          if (generation.drainListener === onDrain) generation.drainListener = undefined;
          drainDone = true;
          finish();
        };
        generation.drainListener = onDrain;
        generation.transport.stdin.once("drain", onDrain);
      }
      finish();
    } catch {
      this.failGeneration(generation, "write_error", true);
    }
  }

  private onStdout(generation: Generation, value: Buffer | string): void {
    if (generation.closed || this.active !== generation) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (generation.stdoutBuffer.length + chunk.length > this.limits.maxStdoutBufferBytes) {
      this.failGeneration(generation, "stdout_limit", true);
      return;
    }
    generation.stdoutBuffer = Buffer.concat([generation.stdoutBuffer, chunk]);
    for (;;) {
      const newline = generation.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (generation.stdoutBuffer.length > this.limits.maxStdoutLineBytes) {
          this.failGeneration(generation, "stdout_limit", true);
        }
        return;
      }
      let line = generation.stdoutBuffer.subarray(0, newline);
      generation.stdoutBuffer = generation.stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length > this.limits.maxStdoutLineBytes) {
        this.failGeneration(generation, "stdout_limit", true);
        return;
      }
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.toString("utf8")) as unknown;
      } catch {
        this.failGeneration(generation, "malformed_json", true);
        return;
      }
      this.onMessage(generation, parsed);
      if (generation.closed) return;
    }
  }

  private onMessage(generation: Generation, message: unknown): void {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      this.recordIssue("unknown_message", generation);
      return;
    }
    const hasId = Object.hasOwn(message, "id");
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    const hasMethod = Object.hasOwn(message, "method");

    if (hasId && hasResult && !hasError && !hasMethod) {
      const success = JsonRpcSuccessSchema.safeParse(message);
      if (success.success) {
        this.resolveResponse(generation, success.data.id, success.data.result);
        return;
      }
    } else if (hasId && hasError && !hasResult && !hasMethod) {
      const failure = JsonRpcErrorSchema.safeParse(message);
      if (failure.success) {
        this.rejectResponse(generation, failure.data.id);
        return;
      }
    } else if (hasMethod && !hasId && !hasResult && !hasError) {
      const notification = JsonRpcNotificationSchema.safeParse(message);
      if (!notification.success) {
        this.recordIssue("unknown_message", generation);
        return;
      }
      const value: CodexAppServerNotification = {
        method: notification.data.method,
        ...(Object.hasOwn(notification.data, "params") ? { params: notification.data.params } : {}),
      };
      for (const listener of this.notificationListeners) {
        try {
          listener(value);
        } catch {
          this.recordIssue("notification_listener", generation);
        }
      }
      return;
    }
    this.recordIssue("unknown_message", generation);
  }

  private resolveResponse(generation: Generation, id: number, result: unknown): void {
    const pending = generation.pending.get(id);
    if (!pending) {
      this.recordIssue("unknown_message", generation);
      return;
    }
    generation.pending.delete(id);
    clearTimeout(pending.timer);
    try {
      const parsed = pending.schema.safeParse(result);
      if (parsed.success) pending.resolve(parsed.data);
      else pending.reject(unavailable());
    } catch {
      pending.reject(unavailable());
    }
  }

  private rejectResponse(generation: Generation, id: number): void {
    const pending = generation.pending.get(id);
    if (!pending) {
      this.recordIssue("unknown_message", generation);
      return;
    }
    generation.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(unavailable());
  }

  private onStderr(generation: Generation, value: Buffer | string): void {
    if (generation.closed || this.active !== generation) return;
    const bytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
    const remaining = this.limits.maxStderrBytes - generation.stderrBytes;
    generation.stderrBytes += Math.min(remaining, bytes);
    if (bytes > remaining) {
      generation.stderrTruncated = true;
      this.recordIssue("stderr_limit", generation);
    }
  }

  private failGeneration(generation: Generation, issue: DiagnosticIssue, kill: boolean, endStdin = false): void {
    if (generation.closed) return;
    generation.closed = true;
    generation.writing = false;
    if (this.active === generation) this.startPromise = undefined;
    this.recordIssue(issue, generation);
    this.lastDiagnostics = {
      ...this.lastDiagnostics,
      stderrBytes: generation.stderrBytes,
      stderrTruncated: generation.stderrTruncated,
    };
    if (this.active === generation) this.active = undefined;
    this.removeListeners(generation);
    const error = unavailable();
    for (const pending of generation.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    generation.pending.clear();
    for (const write of generation.writeQueue.splice(0)) {
      clearTimeout(write.timer);
      write.reject(error);
    }
    if (endStdin) {
      try {
        generation.transport.stdin.end();
      } catch {
        // The same stable unavailable error already rejects every waiter.
      }
    }
    if (kill) {
      try {
        generation.transport.kill("SIGKILL");
      } catch {
        // The transport is already unavailable.
      }
    }
  }

  private removeListeners(generation: Generation): void {
    const { transport, listeners } = generation;
    transport.stdout.removeListener("data", listeners.stdoutData);
    transport.stderr.removeListener("data", listeners.stderrData);
    transport.removeListener("exit", listeners.exit);
    transport.removeListener("error", listeners.error);
    transport.stdin.removeListener("error", listeners.stdinError);
    transport.stdout.removeListener("error", listeners.stdoutError);
    transport.stderr.removeListener("error", listeners.stderrError);
    if (generation.drainListener) {
      transport.stdin.removeListener("drain", generation.drainListener);
      generation.drainListener = undefined;
    }
  }

  private recordIssue(issue: DiagnosticIssue, generation?: Generation): void {
    this.lastDiagnostics = {
      lastIssue: issue,
      stderrBytes: generation?.stderrBytes ?? this.lastDiagnostics.stderrBytes,
      stderrTruncated: generation?.stderrTruncated ?? this.lastDiagnostics.stderrTruncated,
    };
  }
}
