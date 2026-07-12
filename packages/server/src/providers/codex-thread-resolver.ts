import { isAbsolute } from "node:path";
import { z, type ZodType } from "zod";
import { codexThreadResolutionCoordinator, type CodexSpawnLease } from "./codex-thread-coordinator.js";
import { isCodexThreadPersistence, type CodexThreadPersistence } from "./codex-thread-persistence.js";
import { ProviderError } from "./types.js";

const DEFAULT_DEADLINE_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_INVENTORY_ITEMS = 1_000;
const DEFAULT_CREATION_SKEW_MS = 5_000;
const MAX_THREAD_ID = 2_048;
const DEFAULT_CANCELLATION_ACK_MS = 1_000;

export interface CodexThreadInventoryEntry {
  readonly id: string;
  readonly cwd: string;
  readonly source: "cli" | "vscode" | "exec" | "appServer" | "unknown" | Record<string, unknown>;
  /** Current protocol uses Unix seconds; milliseconds are normalized defensively for compatible revisions. */
  readonly createdAt: number;
}

export type ReadCodexThreadInventory = () => Promise<readonly CodexThreadInventoryEntry[]>;

export interface CodexThreadRpc {
  request<T>(method: string, params: unknown, schema: ZodType<T>): Promise<T>;
}

export interface CreateCodexThreadInventoryOptions {
  readonly cwd: string;
  readonly maxPages?: number;
  readonly maxItems?: number;
}

export interface CodexThreadResolverOptions {
  readonly inventory: ReadCodexThreadInventory;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly deadlineMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxInventoryItems?: number;
  readonly creationSkewMs?: number;
  readonly cancellationAckMs?: number;
}

export interface ResolveCodexThreadOptions {
  readonly cwd: string;
  /** The launch callback is intentionally inside the process-wide identity mutex. */
  readonly spawn: (signal: AbortSignal) => CodexSpawnLease;
  readonly persistence: CodexThreadPersistence;
  readonly signal?: AbortSignal;
}

const ThreadSourceSchema = z.union([
  z.enum(["cli", "vscode", "exec", "appServer", "unknown"]),
  z.object({ custom: z.string().max(256) }),
  z.object({ subAgent: z.unknown() }),
]);

const ThreadSchema = z.object({
  id: z.string().min(1).max(MAX_THREAD_ID),
  cwd: z.string().min(1).max(4_096),
  source: ThreadSourceSchema,
  createdAt: z.number().int().safe().nonnegative(),
});

const ThreadListResponseSchema = z.object({
  data: z.array(ThreadSchema).max(500),
  nextCursor: z.string().min(1).max(2_048).nullable().optional(),
});

interface NormalizedThread {
  readonly id: string;
  readonly cwd: string;
  readonly source: z.infer<typeof ThreadSourceSchema>;
  readonly createdAtMs: number;
}

function unavailable(): ProviderError {
  return new ProviderError("RESUME_IDENTITY_UNAVAILABLE", "Codex resume identity is unavailable");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function validThreadId(id: string): boolean {
  return (
    id.trim().length > 0 &&
    id.length <= MAX_THREAD_ID &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(id) &&
    !id.trimStart().startsWith("-")
  );
}

function normalizeProtocolTimestamp(value: number): number | undefined {
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(unavailable());
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(unavailable());
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export function resetCodexThreadResolutionCoordinatorForTests(): void {
  codexThreadResolutionCoordinator.resetForTests();
}

class ResolverDeadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abortFromCaller?: () => void;

  constructor(
    milliseconds: number,
    private readonly callerSignal?: AbortSignal,
  ) {
    if (callerSignal?.aborted) {
      this.controller.abort();
    } else if (callerSignal) {
      this.abortFromCaller = () => this.controller.abort();
      callerSignal.addEventListener("abort", this.abortFromCaller, { once: true });
    }
    this.timer = setTimeout(() => this.controller.abort(), milliseconds);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(unavailable());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", aborted);
        callback();
      };
      const aborted = (): void => finish(() => reject(unavailable()));
      this.signal.addEventListener("abort", aborted, { once: true });
      try {
        Promise.resolve(operation()).then(
          (value) => finish(() => resolve(value)),
          () => finish(() => reject(unavailable())),
        );
      } catch {
        finish(() => reject(unavailable()));
      }
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    if (this.abortFromCaller) this.callerSignal?.removeEventListener("abort", this.abortFromCaller);
  }
}

/** Shared assertion used by the provider's generated resume argv regression. */
export function assertExactCodexResumeArgs(args: readonly string[]): void {
  if (args.some((arg) => arg === "--last" || arg.startsWith("--last="))) {
    throw new ProviderError("RESUME_IDENTITY_UNAVAILABLE", "Codex resume requires an exact safe session id");
  }
}

/** Creates the bounded current-protocol `thread/list` reader used by resolver snapshots and polls. */
export function createCodexThreadInventory(
  rpc: CodexThreadRpc,
  options: CreateCodexThreadInventoryOptions,
): ReadCodexThreadInventory {
  const maxPages = positiveInteger(options.maxPages, 20);
  const maxItems = positiveInteger(options.maxItems, DEFAULT_MAX_INVENTORY_ITEMS);
  return async () => {
    if (!isAbsolute(options.cwd) || options.cwd.length > 4_096) throw unavailable();
    const entries: CodexThreadInventoryEntry[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    try {
      for (let page = 0; page < maxPages; page += 1) {
        const response: z.infer<typeof ThreadListResponseSchema> = await rpc.request(
          "thread/list",
          {
            cursor,
            limit: 100,
            archived: false,
            cwd: options.cwd,
            sourceKinds: ["cli"],
            sortKey: "created_at",
            sortDirection: "desc",
          },
          ThreadListResponseSchema,
        );
        if (entries.length + response.data.length > maxItems) throw unavailable();
        entries.push(...response.data);
        const next: string | null = response.nextCursor ?? null;
        if (next === null) return entries;
        if (seenCursors.has(next)) throw unavailable();
        seenCursors.add(next);
        cursor = next;
      }
    } catch {
      throw unavailable();
    }
    throw unavailable();
  };
}

export class CodexThreadResolver {
  private readonly inventory: ReadCodexThreadInventory;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly deadlineMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxInventoryItems: number;
  private readonly creationSkewMs: number;
  private readonly cancellationAckMs: number;
  private readonly maxPolls: number;

  constructor(options: CodexThreadResolverOptions) {
    this.inventory = options.inventory;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.deadlineMs = positiveInteger(options.deadlineMs, DEFAULT_DEADLINE_MS);
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.maxInventoryItems = positiveInteger(options.maxInventoryItems, DEFAULT_MAX_INVENTORY_ITEMS);
    this.creationSkewMs = positiveInteger(options.creationSkewMs, DEFAULT_CREATION_SKEW_MS);
    this.cancellationAckMs = positiveInteger(options.cancellationAckMs, DEFAULT_CANCELLATION_ACK_MS);
    this.maxPolls = Math.min(10_000, Math.ceil(this.deadlineMs / this.pollIntervalMs) + 2);
  }

  async resolveAfterSpawn(options: ResolveCodexThreadOptions): Promise<string> {
    if (
      !isAbsolute(options.cwd) ||
      options.cwd.length > 4_096 ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(options.cwd) ||
      typeof options.spawn !== "function" ||
      !isCodexThreadPersistence(options.persistence)
    ) {
      throw unavailable();
    }
    const deadlineAt = this.now() + this.deadlineMs;
    const deadline = new ResolverDeadline(this.deadlineMs, options.signal);
    let release: (() => void) | undefined;
    try {
      release = await codexThreadResolutionCoordinator.acquire(deadline.signal);
      return await this.resolveLocked(options, deadline, deadlineAt);
    } catch {
      throw unavailable();
    } finally {
      release?.();
      deadline.dispose();
    }
  }

  private async resolveLocked(
    options: ResolveCodexThreadOptions,
    deadline: ResolverDeadline,
    deadlineAt: number,
  ): Promise<string> {
    this.throwIfCancelled(deadline.signal);
    const before = await this.readInventory(deadline);
    const beforeIds = new Set(before.map((thread) => thread.id));
    const startedAt = this.now();
    let lease: CodexSpawnLease | undefined;
    let spawnAttempted = false;
    let completed = false;
    try {
      spawnAttempted = true;
      lease = options.spawn(deadline.signal);
      if (!lease || !(lease.started instanceof Promise) || typeof lease.cancel !== "function") throw unavailable();
      await deadline.run(() => lease!.started);

      for (let poll = 0; poll < this.maxPolls; poll += 1) {
        this.throwIfCancelled(deadline.signal);
        const current = await this.readInventory(deadline);
        const observedAt = this.now();
        if (observedAt > deadlineAt) throw unavailable();
        const candidates = this.candidates(current, beforeIds, options.cwd, startedAt, observedAt);
        if (candidates.length > 1) throw unavailable();
        const candidate = candidates[0];
        if (candidate) {
          try {
            options.persistence.markProvisional(candidate.id);
            this.throwIfCancelled(deadline.signal);
            if (this.now() > deadlineAt) throw unavailable();
            const fresh = await this.readInventory(deadline);
            const crossCheckedAt = this.now();
            if (crossCheckedAt > deadlineAt) throw unavailable();
            const crossChecked = this.candidates(fresh, beforeIds, options.cwd, startedAt, crossCheckedAt);
            if (crossChecked.length !== 1 || !this.sameIdentity(candidate, crossChecked[0]!)) throw unavailable();
            options.persistence.commit(candidate.id);
            completed = true;
            return candidate.id;
          } catch {
            try {
              options.persistence.clear(candidate.id);
            } catch {
              // The resolver still fails closed; the capability contract requires storage to mark the id unusable.
            }
            throw unavailable();
          }
        }

        const now = this.now();
        if (now >= deadlineAt) throw unavailable();
        try {
          await deadline.run(() => this.sleep(Math.min(this.pollIntervalMs, deadlineAt - now), deadline.signal));
        } catch {
          throw unavailable();
        }
      }
      throw unavailable();
    } finally {
      if (lease && !completed) {
        await codexThreadResolutionCoordinator.acknowledgeCancellation(lease, this.cancellationAckMs);
      } else if (spawnAttempted && !completed) {
        codexThreadResolutionCoordinator.poisonUnknownSpawnOutcome();
      }
    }
  }

  private async readInventory(deadline: ResolverDeadline): Promise<NormalizedThread[]> {
    let raw: readonly CodexThreadInventoryEntry[];
    try {
      raw = await deadline.run(() => this.inventory());
    } catch {
      throw unavailable();
    }
    if (!Array.isArray(raw) || raw.length > this.maxInventoryItems) throw unavailable();
    const normalized: NormalizedThread[] = [];
    const ids = new Set<string>();
    for (const value of raw) {
      const parsed = ThreadSchema.safeParse(value);
      if (!parsed.success || !validThreadId(parsed.data.id) || ids.has(parsed.data.id)) throw unavailable();
      const createdAtMs = normalizeProtocolTimestamp(parsed.data.createdAt);
      if (createdAtMs === undefined) throw unavailable();
      ids.add(parsed.data.id);
      normalized.push({
        id: parsed.data.id,
        cwd: parsed.data.cwd,
        source: parsed.data.source,
        createdAtMs,
      });
    }
    return normalized;
  }

  private candidates(
    inventory: readonly NormalizedThread[],
    beforeIds: ReadonlySet<string>,
    cwd: string,
    startedAt: number,
    observedAt: number,
  ): NormalizedThread[] {
    const earliest = startedAt - this.creationSkewMs;
    const latest = Math.min(startedAt + this.deadlineMs + this.creationSkewMs, observedAt + this.creationSkewMs);
    return inventory.filter(
      (thread) =>
        !beforeIds.has(thread.id) &&
        validThreadId(thread.id) &&
        thread.cwd === cwd &&
        thread.source === "cli" &&
        thread.createdAtMs >= earliest &&
        thread.createdAtMs <= latest,
    );
  }

  private sameIdentity(left: NormalizedThread, right: NormalizedThread): boolean {
    return (
      left.id === right.id &&
      left.cwd === right.cwd &&
      left.source === right.source &&
      left.createdAtMs === right.createdAtMs
    );
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw unavailable();
  }
}
