import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import {
  CodexThreadResolver,
  assertExactCodexResumeArgs,
  createCodexThreadInventory,
  resetCodexThreadResolutionCoordinatorForTests,
  type CodexThreadInventoryEntry,
} from "../../src/providers/codex-thread-resolver.js";
import { createCodexThreadPersistence } from "../../src/providers/codex-thread-persistence.js";
import { openSessionStore } from "../../src/session-store.js";
import type { CodexSpawnLease } from "../../src/providers/codex-thread-coordinator.js";

class FakeThreadRpc {
  readonly requests: Array<{
    method: string;
    params: unknown;
    schema: ZodType<unknown>;
    resolve: (value: unknown) => void;
  }> = [];

  request<T>(method: string, params: unknown, schema: ZodType<T>): Promise<T> {
    return new Promise<T>((resolve) => {
      this.requests.push({
        method,
        params,
        schema: schema as ZodType<unknown>,
        resolve: resolve as (value: unknown) => void,
      });
    });
  }

  reply(value: unknown): void {
    const request = this.requests.find((candidate) => "resolve" in candidate && !Object.hasOwn(candidate, "replied"));
    if (!request) throw new Error("No pending thread/list request");
    Object.assign(request, { replied: true });
    const parsed = request.schema.safeParse(value);
    if (!parsed.success) throw parsed.error;
    request.resolve(parsed.data);
  }
}

function thread(id: string, overrides: Partial<CodexThreadInventoryEntry> = {}): CodexThreadInventoryEntry {
  return { id, cwd: "/work", source: "cli", createdAt: 101, ...overrides };
}

function sequence(snapshots: readonly (readonly CodexThreadInventoryEntry[])[]) {
  let index = 0;
  return vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)]!);
}

let persistenceId = 0;
const testStores: ReturnType<typeof openSessionStore>[] = [];

function persistence(events?: string[]) {
  const store = openSessionStore({ dbPath: ":memory:" });
  testStores.push(store);
  const id = `resolver-${persistenceId++}`;
  store.claimNew({
    provider: "codex",
    id,
    cwd: "/work",
    mode: "terminal",
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
    launchOptions: { provider: "codex" },
  });
  const capability = createCodexThreadPersistence(store, id);
  if (events) {
    const mark = capability.markProvisional.bind(capability);
    const clear = capability.clear.bind(capability);
    vi.spyOn(capability, "markProvisional").mockImplementation((threadId) => {
      events.push(`persist:${threadId}`);
      mark(threadId);
    });
    vi.spyOn(capability, "clear").mockImplementation((threadId) => {
      events.push(`clear:${threadId}`);
      clear(threadId);
    });
  }
  return { capability, store, id };
}

function spawnLease(
  start: (signal: AbortSignal) => void | Promise<void> = () => {},
  cancel: () => Promise<void> = async () => {},
): (signal: AbortSignal) => CodexSpawnLease {
  return (signal) => ({ started: Promise.resolve().then(() => start(signal)), cancel });
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of testStores.splice(0)) store.close();
  resetCodexThreadResolutionCoordinatorForTests();
});

describe("CodexThreadResolver exact identity", () => {
  it("accepts only the store-bound persistence capability and commits the cross-checked id", async () => {
    const store = openSessionStore({ dbPath: ":memory:" });
    store.claimNew({
      provider: "codex",
      id: "roam-1",
      cwd: "/work",
      mode: "terminal",
      status: "running",
      createdAt: 1,
      lastActivityAt: 1,
      launchOptions: { provider: "codex" },
    });
    const resolver = new CodexThreadResolver({
      inventory: sequence([[], [thread("exact")], [thread("exact")]]),
      now: () => 100_000,
      sleep: async () => {},
    });

    await expect(
      resolver.resolveAfterSpawn({
        cwd: "/work",
        spawn: () => ({ started: Promise.resolve(), cancel: async () => {} }),
        persistence: createCodexThreadPersistence(store, "roam-1"),
      }),
    ).resolves.toBe("exact");
    expect(store.get("roam-1")).toMatchObject({ providerSessionId: "exact" });

    const replacement = new CodexThreadResolver({
      inventory: sequence([[], [thread("replacement")], [thread("replacement")]]),
      now: () => 100_000,
      sleep: async () => {},
    }).resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(),
      persistence: createCodexThreadPersistence(store, "roam-1"),
    });
    await expect(replacement).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
    expect(store.get("roam-1")).toMatchObject({ providerSessionId: "exact" });

    await expect(
      resolver.resolveAfterSpawn({
        cwd: "/work",
        spawn: () => ({ started: Promise.resolve(), cancel: async () => {} }),
        persistence: {
          markProvisional: async () => {},
          clear: async () => {},
          commit: async () => {},
        } as never,
      }),
    ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
    store.close();
  });
  it("builds a narrow, cwd-scoped, fully paginated app-server inventory", async () => {
    const rpc = new FakeThreadRpc();
    const inventory = createCodexThreadInventory(rpc, { cwd: "/work", maxPages: 2, maxItems: 2 });
    const result = inventory();
    expect(rpc.requests[0]).toMatchObject({
      method: "thread/list",
      params: {
        cursor: null,
        limit: 100,
        archived: false,
        cwd: "/work",
        sourceKinds: ["cli"],
        sortKey: "created_at",
        sortDirection: "desc",
      },
    });
    rpc.reply({
      data: [{ id: "a", cwd: "/work", source: "cli", createdAt: 101, accessToken: "strip" }],
      nextCursor: "two",
    });
    await vi.waitFor(() => expect(rpc.requests).toHaveLength(2));
    rpc.reply({ data: [{ id: "b", cwd: "/work", source: "cli", createdAt: 102 }], nextCursor: null });
    await expect(result).resolves.toEqual([thread("a"), thread("b", { createdAt: 102 })]);
    expect(JSON.stringify(await result)).not.toContain("strip");

    const cyclingRpc = new FakeThreadRpc();
    const cycling = createCodexThreadInventory(cyclingRpc, { cwd: "/work", maxPages: 2 })();
    cyclingRpc.reply({ data: [], nextCursor: "same" });
    await vi.waitFor(() => expect(cyclingRpc.requests).toHaveLength(2));
    cyclingRpc.reply({ data: [], nextCursor: "same" });
    await expect(cycling).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
  });

  it("snapshots before spawn, persists the only new exact candidate immediately, then cross-checks", async () => {
    let now = 100_000;
    const events: string[] = [];
    const inventory = sequence([
      [thread("stale", { createdAt: 90 })],
      [thread("stale", { createdAt: 90 }), thread("new", { createdAt: 101 })],
      [thread("stale", { createdAt: 90 }), thread("new", { createdAt: 101 })],
    ]);
    const resolver = new CodexThreadResolver({
      inventory,
      now: () => now,
      sleep: async () => {
        now += 10;
      },
    });
    const stored = persistence(events);
    const resolved = resolver.resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(() => void events.push("spawn")),
      persistence: stored.capability,
    });
    await expect(resolved).resolves.toBe("new");
    expect(events).toEqual(["spawn", "persist:new"]);
    expect(inventory).toHaveBeenCalledTimes(3);
    expect(inventory.mock.invocationCallOrder[0]).toBeLessThan(events.indexOf("spawn") + 1_000_000);
  });

  it("normalizes protocol seconds and milliseconds and rejects ambiguity, wrong fields, and stale ids", async () => {
    let now = 1_783_800_000_000;
    const ambiguous = new CodexThreadResolver({
      inventory: sequence([
        [],
        [thread("a", { createdAt: 1_783_800_001 }), thread("b", { createdAt: 1_783_800_001_000 })],
      ]),
      now: () => now,
      sleep: async () => {
        now += 1;
      },
    });
    await expect(
      ambiguous.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).rejects.toMatchObject({
      code: "RESUME_IDENTITY_UNAVAILABLE",
    });

    const invalids = [
      thread("wrong-cwd", { cwd: "/other" }),
      thread("wrong-source", { source: "appServer" }),
      thread("too-old", { createdAt: 1 }),
      thread("--last", { createdAt: 1_783_800_001 }),
    ];
    const unavailable = new CodexThreadResolver({
      inventory: sequence([[], invalids]),
      now: () => now,
      sleep: async () => {
        now += 20;
      },
      deadlineMs: 30,
      pollIntervalMs: 10,
    });
    await expect(
      unavailable.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).rejects.toMatchObject({
      code: "RESUME_IDENTITY_UNAVAILABLE",
    });
  });

  it.each([
    ["disappears", [[], [thread("new")], []]],
    ["changes", [[], [thread("new")], [thread("new", { cwd: "/changed" })]]],
    ["gains ambiguity", [[], [thread("new")], [thread("new"), thread("second")]]],
  ] as const)("fails closed when the persisted candidate %s during cross-check", async (_name, snapshots) => {
    const events: string[] = [];
    const stored = persistence(events);
    const resolver = new CodexThreadResolver({
      inventory: sequence(snapshots),
      now: () => 100_000,
      sleep: async () => {},
    });
    await expect(
      resolver.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: stored.capability,
      }),
    ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
    expect(events).toEqual(["persist:new", "clear:new"]);
    expect(stored.store.get(stored.id)).not.toHaveProperty("providerSessionId");
  });

  it("fails closed on persistence errors and releases the process-wide mutex on spawn errors", async () => {
    const stored = persistence();
    vi.spyOn(stored.capability, "markProvisional").mockImplementation(() => {
      throw new Error("db-secret");
    });
    const resolver = new CodexThreadResolver({
      inventory: sequence([[], [thread("new")]]),
      now: () => 100_000,
      sleep: async () => {},
    });
    await expect(
      resolver.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: stored.capability,
      }),
    ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE", message: "Codex resume identity is unavailable" });
    expect(stored.store.get(stored.id)).not.toHaveProperty("providerSessionId");

    const failedSpawn = new CodexThreadResolver({
      inventory: sequence([[]]),
      now: () => 100_000,
      sleep: async () => {},
    });
    await expect(
      failedSpawn.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(() => {
          throw new Error("spawn-failed");
        }),
        persistence: persistence().capability,
      }),
    ).rejects.toMatchObject({
      code: "RESUME_IDENTITY_UNAVAILABLE",
      message: "Codex resume identity is unavailable",
    });

    const next = new CodexThreadResolver({
      inventory: sequence([[], [thread("next")], [thread("next")]]),
      now: () => 100_000,
      sleep: async () => {},
    });
    await expect(
      next.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).resolves.toBe("next");
  });

  it("serializes snapshot, caller spawn, and discovery process-wide across resolver instances", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const first = new CodexThreadResolver({
      inventory: sequence([[], [thread("first")], [thread("first")]]),
      now: () => 100_000,
      sleep: async () => {},
    });
    const secondInventory = sequence([[], [thread("second")], [thread("second")]]);
    const second = new CodexThreadResolver({ inventory: secondInventory, now: () => 100_000, sleep: async () => {} });
    const firstPersistence = persistence(events);
    const secondPersistence = persistence(events);

    const one = first.resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(async () => {
        events.push("spawn:first");
        await gate;
      }),
      persistence: firstPersistence.capability,
    });
    await vi.waitFor(() => expect(events).toContain("spawn:first"));
    const two = second.resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(() => void events.push("spawn:second")),
      persistence: secondPersistence.capability,
    });
    await Promise.resolve();
    expect(secondInventory).not.toHaveBeenCalled();
    expect(events).not.toContain("spawn:second");
    releaseFirst();
    await expect(Promise.all([one, two])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["spawn:first", "persist:first", "spawn:second", "persist:second"]);
  });

  it("starts one absolute deadline before mutex acquisition and admits later work after a waiter times out", async () => {
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = new CodexThreadResolver({
      inventory: sequence([[], [thread("holder")], [thread("holder")]]),
      now: () => 100_000,
      deadlineMs: 1_000,
      pollIntervalMs: 10,
    });
    const holding = holder.resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(() => holderGate),
      persistence: persistence().capability,
    });
    await vi.waitFor(() => expect(holderGate).toBeDefined());

    const waitingInventory = sequence([[], [thread("waiter")], [thread("waiter")]]);
    const waiter = new CodexThreadResolver({
      inventory: waitingInventory,
      now: () => 100_000,
      deadlineMs: 20,
      pollIntervalMs: 10,
    });
    const waited = waiter.resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(),
      persistence: persistence().capability,
    });
    await expect(
      Promise.race([waited, new Promise((resolve) => setTimeout(() => resolve("still-pending"), 80))]),
    ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
    expect(waitingInventory).not.toHaveBeenCalled();

    releaseHolder();
    await expect(holding).resolves.toBe("holder");
    const later = new CodexThreadResolver({
      inventory: sequence([[], [thread("later")], [thread("later")]]),
      now: () => 100_000,
      deadlineMs: 100,
      pollIntervalMs: 10,
    });
    await expect(
      later.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).resolves.toBe("later");
  });

  it("honors cancellation while polling and a hard deadline with bounded inventory", async () => {
    let now = 100_000;
    const controller = new AbortController();
    const inventory = sequence([[], []]);
    const resolver = new CodexThreadResolver({
      inventory,
      now: () => now,
      sleep: async () => {
        now += 10;
        controller.abort();
      },
      deadlineMs: 50,
      pollIntervalMs: 10,
      maxInventoryItems: 2,
    });
    await expect(
      resolver.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });

    const oversized = new CodexThreadResolver({
      inventory: sequence([[], [thread("a"), thread("b"), thread("c")]]),
      now: () => 100_000,
      sleep: async () => {},
      maxInventoryItems: 2,
    });
    await expect(
      oversized.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).rejects.toMatchObject({
      code: "RESUME_IDENTITY_UNAVAILABLE",
    });

    let lateNow = 100_000;
    const late = new CodexThreadResolver({
      inventory: sequence([[], [], [thread("late")]]),
      now: () => lateNow,
      sleep: async () => {
        lateNow += 51;
      },
      deadlineMs: 50,
      pollIntervalMs: 10,
    });
    await expect(
      late.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
  });

  it("asserts resume argv can never contain --last", () => {
    expect(() => assertExactCodexResumeArgs(["resume", "--", "exact-id"])).not.toThrow();
    expect(() => assertExactCodexResumeArgs(["resume", "--last"])).toThrow(/exact safe session id/i);
    expect(() => assertExactCodexResumeArgs(["resume", "--last=true"])).toThrow(/exact safe session id/i);
  });

  it("aborts a hung spawn with the resolver-owned signal, releases the mutex, and redacts the error", async () => {
    let spawnSignal: AbortSignal | undefined;
    const hung = new CodexThreadResolver({
      inventory: sequence([[]]),
      now: () => 100_000,
      deadlineMs: 20,
      pollIntervalMs: 10,
    }).resolveAfterSpawn({
      cwd: "/work",
      spawn: (signal) => {
        spawnSignal = signal;
        return { started: new Promise<void>(() => {}), cancel: async () => {} };
      },
      persistence: persistence().capability,
    });
    await expect(
      Promise.race([hung, new Promise((resolve) => setTimeout(() => resolve("still-pending"), 80))]),
    ).rejects.toMatchObject({
      code: "RESUME_IDENTITY_UNAVAILABLE",
      message: "Codex resume identity is unavailable",
    });
    expect(spawnSignal?.aborted).toBe(true);

    const later = new CodexThreadResolver({
      inventory: sequence([[], [thread("later")], [thread("later")]]),
      now: () => 100_000,
      deadlineMs: 100,
      pollIntervalMs: 10,
    });
    await expect(
      later.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).resolves.toBe("later");
  });

  it("bounds a hung inventory snapshot and releases the mutex for later work", async () => {
    const hung = new CodexThreadResolver({
      inventory: () => new Promise<readonly CodexThreadInventoryEntry[]>(() => {}),
      now: () => 100_000,
      deadlineMs: 20,
      pollIntervalMs: 10,
    }).resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(),
      persistence: persistence().capability,
    });
    await expect(
      Promise.race([hung, new Promise((resolve) => setTimeout(() => resolve("still-pending"), 80))]),
    ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });

    const later = new CodexThreadResolver({
      inventory: sequence([[], [thread("after-snapshot")], [thread("after-snapshot")]]),
      now: () => 100_000,
      deadlineMs: 100,
      pollIntervalMs: 10,
    });
    await expect(
      later.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).resolves.toBe("after-snapshot");
  });

  it("bounds a custom sleep that ignores abort and still admits later work", async () => {
    const hung = new CodexThreadResolver({
      inventory: sequence([[], []]),
      sleep: () => new Promise<void>(() => {}),
      now: () => 100_000,
      deadlineMs: 20,
      pollIntervalMs: 10,
    }).resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(),
      persistence: persistence().capability,
    });
    await expect(
      Promise.race([hung, new Promise((resolve) => setTimeout(() => resolve("still-pending"), 80))]),
    ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });

    const later = new CodexThreadResolver({
      inventory: sequence([[], [thread("after-sleep")], [thread("after-sleep")]]),
      now: () => 100_000,
      deadlineMs: 100,
      pollIntervalMs: 10,
    });
    await expect(
      later.resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).resolves.toBe("after-sleep");
  });

  it.each([
    ["poll inventory", 1, false],
    ["cross-check inventory", 2, true],
  ] as const)(
    "bounds hung %s, clears provisional state when needed, and detaches caller abort listeners",
    async (_phase, hangAt, hasCandidate) => {
      const controller = new AbortController();
      const events: string[] = [];
      const stored = persistence(events);
      let call = 0;
      const inventory = vi.fn(() => {
        const current = call++;
        if (current === hangAt) return new Promise<readonly CodexThreadInventoryEntry[]>(() => {});
        return Promise.resolve(current === 1 && hasCandidate ? [thread("provisional")] : []);
      });
      const result = new CodexThreadResolver({
        inventory,
        now: () => 100_000,
        deadlineMs: 20,
        pollIntervalMs: 10,
      }).resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: stored.capability,
        signal: controller.signal,
      });
      await expect(result).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
      expect(events.filter((event) => event.startsWith("clear:"))).toEqual(
        events.filter((event) => event.startsWith("persist:")).map((event) => event.replace("persist:", "clear:")),
      );
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );

  it("redacts a synchronous clear failure and releases the mutex", async () => {
    const stored = persistence();
    vi.spyOn(stored.capability, "clear").mockImplementation(() => {
      throw new Error("clear-secret");
    });
    const failed = new CodexThreadResolver({
      inventory: sequence([[], [thread("provisional")], []]),
      now: () => 100_000,
      deadlineMs: 100,
      pollIntervalMs: 10,
    }).resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(),
      persistence: stored.capability,
    });
    await expect(failed).rejects.toMatchObject({
      code: "RESUME_IDENTITY_UNAVAILABLE",
      message: "Codex resume identity is unavailable",
    });
    await expect(failed).rejects.not.toThrow(/clear-secret/);

    await expect(
      new CodexThreadResolver({
        inventory: sequence([[], [thread("after-clear")], [thread("after-clear")]]),
        now: () => 100_000,
        deadlineMs: 100,
      }).resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).resolves.toBe("after-clear");
  });

  it("keeps a provisional id non-resumable when rollback storage becomes unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-provisional-"));
    const dbPath = join(directory, "sessions.db");
    const durable = openSessionStore({ dbPath });
    durable.claimNew({
      provider: "codex",
      id: "rollback-crash",
      cwd: "/work",
      mode: "terminal",
      status: "running",
      createdAt: 1,
      lastActivityAt: 1,
      launchOptions: { provider: "codex" },
    });
    let inventoryCall = 0;
    const result = new CodexThreadResolver({
      inventory: async () => {
        inventoryCall += 1;
        if (inventoryCall === 1) return [];
        if (inventoryCall === 2) return [thread("provisional")];
        durable.close();
        return [];
      },
      now: () => 100_000,
      deadlineMs: 100,
    }).resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(),
      persistence: createCodexThreadPersistence(durable, "rollback-crash"),
    });

    await expect(result).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
    const reopened = openSessionStore({ dbPath });
    expect(reopened.get("rollback-crash")).not.toHaveProperty("providerSessionId");
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects an unbranded async persistence object before it can start a late write", async () => {
    const writes: string[] = [];
    const result = new CodexThreadResolver({
      inventory: sequence([[], [thread("must-not-persist")]]),
      now: () => 100_000,
      deadlineMs: 100,
    }).resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(),
      persistence: {
        markProvisional: async (id: string) => void writes.push(id),
        clear: async () => {},
        commit: async () => {},
      } as never,
    });

    await expect(result).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
    await Promise.resolve();
    expect(writes).toEqual([]);
  });

  it("aborts a hung mutex holder on the caller signal and admits later work", async () => {
    const controller = new AbortController();
    let ownedSignal: AbortSignal | undefined;
    const holding = new CodexThreadResolver({
      inventory: sequence([[]]),
      now: () => 100_000,
      deadlineMs: 1_000,
    }).resolveAfterSpawn({
      cwd: "/work",
      spawn: (signal) => {
        ownedSignal = signal;
        return { started: new Promise<void>(() => {}), cancel: async () => {} };
      },
      persistence: persistence().capability,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(ownedSignal).toBeDefined());
    controller.abort();
    await expect(holding).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
    expect(ownedSignal?.aborted).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    await expect(
      new CodexThreadResolver({
        inventory: sequence([[], [thread("after-abort")], [thread("after-abort")]]),
        now: () => 100_000,
        deadlineMs: 100,
      }).resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).resolves.toBe("after-abort");
  });

  it.each(["hang", "reject", "non-promise"] as const)(
    "poisons process-wide discovery when spawn cancellation acknowledgement %s",
    async (mode) => {
      const cancel =
        mode === "hang"
          ? () => new Promise<void>(() => {})
          : mode === "reject"
            ? () => Promise.reject(new Error("cancel-secret"))
            : ((() => undefined) as never);
      const failed = new CodexThreadResolver({
        inventory: sequence([[]]),
        now: () => 100_000,
        deadlineMs: 15,
        cancellationAckMs: 10,
      }).resolveAfterSpawn({
        cwd: "/work",
        spawn: () => ({ started: new Promise<void>(() => {}), cancel }),
        persistence: persistence().capability,
      });
      await expect(failed).rejects.toMatchObject({
        code: "RESUME_IDENTITY_UNAVAILABLE",
        message: "Codex resume identity is unavailable",
      });

      const laterInventory = sequence([[], [thread("must-not-select")], [thread("must-not-select")]]);
      await expect(
        new CodexThreadResolver({ inventory: laterInventory, now: () => 100_000 }).resolveAfterSpawn({
          cwd: "/work",
          spawn: spawnLease(),
          persistence: persistence().capability,
        }),
      ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
      expect(laterInventory).not.toHaveBeenCalled();
    },
  );

  it.each(["throws", "returns no lease"] as const)(
    "poisons process-wide discovery when spawn %s before a cancellation lease exists",
    async (mode) => {
      const failed = new CodexThreadResolver({
        inventory: sequence([[]]),
        now: () => 100_000,
      }).resolveAfterSpawn({
        cwd: "/work",
        spawn: (() => {
          if (mode === "throws") throw new Error("spawn-secret");
          return undefined;
        }) as never,
        persistence: persistence().capability,
      });
      await expect(failed).rejects.toMatchObject({
        code: "RESUME_IDENTITY_UNAVAILABLE",
        message: "Codex resume identity is unavailable",
      });
      await expect(failed).rejects.not.toThrow(/spawn-secret/);

      let laterInventoryCall = 0;
      const laterInventory = vi.fn(async () => (laterInventoryCall++ === 0 ? [] : [thread("must-not-select")]));
      const laterSpawn = vi.fn(spawnLease());
      await expect(
        new CodexThreadResolver({ inventory: laterInventory, now: () => 100_000 }).resolveAfterSpawn({
          cwd: "/work",
          spawn: laterSpawn,
          persistence: persistence().capability,
        }),
      ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
      expect(laterInventory).not.toHaveBeenCalled();
      expect(laterSpawn).not.toHaveBeenCalled();
    },
  );

  it("cancels a malformed lease with an acknowledgement before admitting later discovery", async () => {
    const cancel = vi.fn(async () => {});
    await expect(
      new CodexThreadResolver({ inventory: sequence([[]]), now: () => 100_000 }).resolveAfterSpawn({
        cwd: "/work",
        spawn: (() => ({ started: undefined, cancel })) as never,
        persistence: persistence().capability,
      }),
    ).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
    expect(cancel).toHaveBeenCalledOnce();

    await expect(
      new CodexThreadResolver({
        inventory: sequence([[], [thread("after-malformed")], [thread("after-malformed")]]),
        now: () => 100_000,
      }).resolveAfterSpawn({
        cwd: "/work",
        spawn: spawnLease(),
        persistence: persistence().capability,
      }),
    ).resolves.toBe("after-malformed");
  });

  it("holds the coordinator until cancellation is acknowledged so a late spawn cannot contaminate later work", async () => {
    let acknowledgeCancel!: () => void;
    const cancelAck = new Promise<void>((resolve) => {
      acknowledgeCancel = resolve;
    });
    const failed = new CodexThreadResolver({
      inventory: sequence([[]]),
      now: () => 100_000,
      deadlineMs: 15,
      cancellationAckMs: 100,
    }).resolveAfterSpawn({
      cwd: "/work",
      spawn: () => ({ started: new Promise<void>(() => {}), cancel: () => cancelAck }),
      persistence: persistence().capability,
    });
    const laterInventory = sequence([[], [thread("later")], [thread("later")]]);
    const later = new CodexThreadResolver({ inventory: laterInventory, now: () => 100_000 }).resolveAfterSpawn({
      cwd: "/work",
      spawn: spawnLease(),
      persistence: persistence().capability,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(laterInventory).not.toHaveBeenCalled();
    acknowledgeCancel();
    await expect(failed).rejects.toMatchObject({ code: "RESUME_IDENTITY_UNAVAILABLE" });
    await expect(later).resolves.toBe("later");
  });
});
