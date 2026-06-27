import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { ModelInfo } from "@remote-coder/protocol";
import { ClaudeProcess } from "./claude-process.js";

export type RunModelsProbe = () => Promise<ModelInfo[]>;

const MODELS_CACHE_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15000;

export interface ModelsServiceDeps {
  runProbe: RunModelsProbe;
  now: () => number;
  ttlMs?: number;
}

/**
 * Resolves + caches the account's selectable model list. Mirrors UsageService: the cache holds the LAST
 * GOOD list; a failed/empty probe keeps the last good (never an empty cache that would pin for the TTL).
 * Concurrent callers share one in-flight probe. Never throws.
 */
export class ModelsService {
  private readonly runProbe: RunModelsProbe;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cache?: { at: number; models: ModelInfo[] };
  private inFlight?: Promise<ModelInfo[]>;

  constructor(deps: ModelsServiceDeps) {
    this.runProbe = deps.runProbe;
    this.now = deps.now;
    this.ttlMs = deps.ttlMs ?? MODELS_CACHE_MS;
  }

  async getModels(force = false): Promise<ModelInfo[]> {
    if (!force && this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.models;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      let models: ModelInfo[] = [];
      try {
        models = await this.runProbe();
      } catch {
        models = [];
      }
      if (models.length > 0) this.cache = { at: this.now(), models };
      this.inFlight = undefined;
      return models.length > 0 ? models : (this.cache?.models ?? []);
    })();
    return this.inFlight;
  }
}

/**
 * The real probe: spawn a short-lived `claude` via ClaudeProcess, run ONLY the initialize handshake,
 * read `.models`, stop it. Resolves [] on any failure (never rejects). cwd is a throwaway tmpdir.
 */
export function createModelsProbe(opts: {
  claudeBin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): RunModelsProbe {
  return () =>
    new Promise<ModelInfo[]>((resolve) => {
      let proc: ClaudeProcess;
      try {
        proc = new ClaudeProcess({
          claudeBin: opts.claudeBin,
          cwd: tmpdir(),
          sessionId: randomUUID(),
          env: opts.env,
          startTimeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
        });
      } catch {
        resolve([]);
        return;
      }
      proc
        .start()
        .then(() => {
          const models = proc.models;
          proc.stop();
          resolve(models);
        })
        .catch(() => {
          proc.stop();
          resolve([]);
        });
    });
}

/** Production wiring: a ModelsService backed by the real spawn probe. */
export function createModelsService(opts: {
  claudeBin: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
}): ModelsService {
  return new ModelsService({
    runProbe: createModelsProbe({ claudeBin: opts.claudeBin, env: opts.env, timeoutMs: opts.timeoutMs }),
    now: opts.now ?? (() => Date.now()),
    ttlMs: opts.ttlMs,
  });
}
