import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { ProviderError } from "./types.js";

const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_MODELS = 64;
const MAX_EFFORTS = 32;
const MAX_TOKEN = 128;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const CLAUDE_METADATA_ARGS = [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--permission-mode",
  "plan",
] as const;

export interface ClaudeModelCatalogItem {
  value: string;
  displayName: string;
  description?: string;
  supportedEffortLevels: string[];
  isDefault: boolean;
}

export interface ClaudeMetadataRunner {
  run(): Promise<unknown>;
  dispose?(): void | Promise<void>;
}

interface ClaudeMetadataChildProcess {
  readonly stdin: {
    end(chunk: string): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    off(event: "error", listener: (error: Error) => void): unknown;
  };
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(): boolean;
}

type ClaudeMetadataSpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ClaudeMetadataChildProcess;

interface CreateClaudeMetadataRunnerOptions {
  claudeBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Process boundary injected by lifecycle tests. */
  spawnProcess?: ClaudeMetadataSpawnProcess;
}

function metadataUnavailable(): Error {
  const error = new Error("Claude model metadata is unavailable");
  error.name = "ClaudeMetadataError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TOKEN && SAFE_VALUE.test(value);
}

function normalizeCatalog(envelope: unknown): ClaudeModelCatalogItem[] {
  if (!isRecord(envelope) || !isRecord(envelope.response) || !isRecord(envelope.response.response)) {
    throw metadataUnavailable();
  }
  const models = envelope.response.response.models;
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS) {
    throw metadataUnavailable();
  }

  const seenModels = new Set<string>();
  return models.map((candidate) => {
    if (!isRecord(candidate) || !isSafeToken(candidate.value) || seenModels.has(candidate.value)) {
      throw metadataUnavailable();
    }
    seenModels.add(candidate.value);
    if (
      typeof candidate.displayName !== "string" ||
      candidate.displayName.length === 0 ||
      candidate.displayName.length > 512 ||
      (candidate.description !== undefined &&
        (typeof candidate.description !== "string" || candidate.description.length > 4_096)) ||
      !Array.isArray(candidate.supportedEffortLevels) ||
      candidate.supportedEffortLevels.length > MAX_EFFORTS ||
      typeof candidate.isDefault !== "boolean"
    ) {
      throw metadataUnavailable();
    }

    const seenEfforts = new Set<string>();
    const supportedEffortLevels = candidate.supportedEffortLevels.map((effort) => {
      if (!isSafeToken(effort) || seenEfforts.has(effort)) throw metadataUnavailable();
      seenEfforts.add(effort);
      return effort;
    });
    return {
      value: candidate.value,
      displayName: candidate.displayName,
      ...(candidate.description !== undefined ? { description: candidate.description } : {}),
      supportedEffortLevels,
      isDefault: candidate.isDefault,
    };
  });
}

function cloneCatalog(models: readonly ClaudeModelCatalogItem[]): ClaudeModelCatalogItem[] {
  return models.map((model) => ({ ...model, supportedEffortLevels: [...model.supportedEffortLevels] }));
}

export class ClaudeMetadataService {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cache?: { at: number; models: readonly ClaudeModelCatalogItem[] };
  private inFlight?: Promise<readonly ClaudeModelCatalogItem[]>;
  private disposed = false;

  constructor(
    private readonly runner: ClaudeMetadataRunner,
    options: { now?: () => number; ttlMs?: number } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async getModels(force = false): Promise<ClaudeModelCatalogItem[]> {
    if (!force && this.cache && this.now() - this.cache.at < this.ttlMs) {
      return cloneCatalog(this.cache.models);
    }
    if (this.inFlight) return cloneCatalog(await this.inFlight);

    const request = this.loadModels();
    this.inFlight = request;
    try {
      const models = await request;
      this.cache = { at: this.now(), models: cloneCatalog(models) };
      return cloneCatalog(models);
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  async validateModelSelection(model: string, effort?: string): Promise<void> {
    const models = await this.getModels();
    const selected = models.find((candidate) => candidate.value === model);
    if (!selected || effort === undefined || selected.supportedEffortLevels.includes(effort)) return;
    throw new ProviderError("INVALID_PROVIDER_OPTIONS", "Invalid Claude model and effort selection");
  }

  dispose(): void | Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    return this.runner.dispose?.();
  }

  private async loadModels(): Promise<ClaudeModelCatalogItem[]> {
    try {
      return normalizeCatalog(await this.runner.run());
    } catch {
      throw metadataUnavailable();
    }
  }
}

export function createClaudeMetadataRunner(options: CreateClaudeMetadataRunnerOptions): ClaudeMetadataRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const spawnProcess = options.spawnProcess ?? (nodeSpawn as unknown as ClaudeMetadataSpawnProcess);
  const activeRuns = new Set<() => void>();
  let disposed = false;

  return {
    run(): Promise<unknown> {
      if (disposed) return Promise.reject(metadataUnavailable());

      return new Promise((resolve, reject) => {
        const env = { ...options.env };
        delete env.ANTHROPIC_API_KEY;
        let child: ClaudeMetadataChildProcess;
        try {
          child = spawnProcess(options.claudeBin, CLAUDE_METADATA_ARGS, {
            cwd: options.cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          reject(metadataUnavailable());
          return;
        }

        const requestId = `roamcode-models-${randomUUID()}`;
        const decoder = new StringDecoder("utf8");
        let stdoutBuffer = "";
        let outputBytes = 0;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined = undefined;

        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          child.stdout.off("data", onStdout);
          child.stderr.off("data", onStderr);
          child.stdin.off("error", onStdinError);
          child.off("error", onError);
          child.off("exit", onExit);
          activeRuns.delete(cancel);
          try {
            child.kill();
          } catch {
            // Cleanup is best-effort and must not replace the original settlement.
          }
        };
        const settle = (value?: unknown): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (value === undefined) reject(metadataUnavailable());
          else resolve(value);
        };
        const addBytes = (chunk: unknown): Buffer | undefined => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          outputBytes += buffer.byteLength;
          if (outputBytes > maxOutputBytes) {
            settle();
            return undefined;
          }
          return buffer;
        };
        const onStdout = (chunk: unknown): void => {
          const buffer = addBytes(chunk);
          if (!buffer || settled) return;
          stdoutBuffer += decoder.write(buffer);
          while (!settled) {
            const newline = stdoutBuffer.indexOf("\n");
            if (newline < 0) return;
            const line = stdoutBuffer.slice(0, newline).trim();
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (line.length === 0) continue;
            let message: unknown;
            try {
              message = JSON.parse(line);
            } catch {
              settle();
              return;
            }
            if (
              isRecord(message) &&
              message.type === "control_response" &&
              isRecord(message.response) &&
              message.response.request_id === requestId
            ) {
              settle(message);
            }
          }
        };
        const onStderr = (chunk: unknown): void => {
          addBytes(chunk);
        };
        const onStdinError = (): void => settle();
        const onError = (): void => settle();
        const onExit = (): void => settle();
        const cancel = (): void => settle();

        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        child.stdin.on("error", onStdinError);
        child.on("error", onError);
        child.on("exit", onExit);
        activeRuns.add(cancel);
        timer = setTimeout(cancel, timeoutMs);

        const request = {
          type: "control_request",
          request_id: requestId,
          request: {
            subtype: "initialize",
            hooks: { PreToolUse: [{ matcher: "", hookCallbackIds: ["roamcode-metadata"] }] },
          },
        };
        try {
          child.stdin.end(`${JSON.stringify(request)}\n`);
        } catch {
          settle();
        }
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const cancel of [...activeRuns]) cancel();
    },
  };
}
