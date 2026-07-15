import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createCodexThreadPersistence, openSessionStore } from "../src/index.js";
import type { SessionStore, StoredSession, StoredSessionFile } from "../src/index.js";
import { SessionDefaultsConflictError } from "../src/session-defaults.js";

const require = createRequire(import.meta.url);

let dir: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-store-"));
  store = openSessionStore({ dbPath: join(dir, "sessions.db") });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function sample(id: string): StoredSession {
  return {
    provider: "claude",
    id,
    cwd: "/work/" + id,
    dangerouslySkip: false,
    status: "running",
    createdAt: 1000,
    lastActivityAt: 1000,
    mode: "terminal",
  };
}

function codexSample(id: string, createdAt = 1000): StoredSession {
  return {
    provider: "codex",
    id,
    cwd: "/work/" + id,
    status: "running",
    createdAt,
    lastActivityAt: createdAt,
    mode: "terminal",
    launchOptions: { provider: "codex", model: "gpt-5-codex", sandbox: "workspace-write" },
    integrationStatus: { attachments: "ready", activity: "degraded", detail: "pane fallback" },
  };
}

function fileSample(id: string, overrides: Partial<StoredSessionFile> = {}): StoredSessionFile {
  return {
    id,
    sessionId: "session-files",
    direction: "sent",
    storage: "managed",
    name: `${id}.png`,
    path: `/data/${id}.png`,
    mimeType: "image/png",
    size: 123,
    kind: "image",
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 10_000,
    ...overrides,
  };
}

test("upsert + get round-trips every durable field", () => {
  store.upsert(sample("a"));
  expect(store.get("a")).toEqual(sample("a"));
});

test("upsert is idempotent on the primary key (id) and overwrites", () => {
  store.upsert(sample("a"));
  store.upsert({ ...sample("a"), cwd: "/moved", status: "dormant" });
  expect(store.get("a")?.cwd).toBe("/moved");
  expect(store.get("a")?.status).toBe("dormant");
  expect(store.list()).toHaveLength(1);
});

test("setStatus + touch mutate in place", () => {
  store.upsert(sample("a"));
  store.setStatus("a", "errored");
  store.touch("a", 2000);
  expect(store.get("a")?.status).toBe("errored");
  expect(store.get("a")?.lastActivityAt).toBe(2000);
});

test("data survives reopening the same db file (durability)", () => {
  store.upsert(sample("a"));
  store.close();
  const reopened = openSessionStore({ dbPath: join(dir, "sessions.db") });
  expect(reopened.get("a")).toEqual(sample("a"));
  reopened.close();
});

test("session files survive reopening and preserve derivative metadata", () => {
  const dbPath = join(dir, "sessions.db");
  const file = fileSample("edited", {
    direction: "received",
    storage: "workspace",
    caption: "review this",
    derivedFromId: "original",
  });
  store.putFile(file);
  store.close();

  const reopened = openSessionStore({ dbPath });
  expect(reopened.listFiles(file.sessionId)).toEqual([file]);
  reopened.close();
});

test("session files can be hidden, restored, pruned, and deleted with their session", () => {
  const hidden = fileSample("hidden", { createdAt: 2_000, expiresAt: 9_000 });
  const expired = fileSample("expired", { expiresAt: 4_000 });
  store.putFile(hidden);
  store.putFile(expired);

  store.setFileHidden(hidden.sessionId, hidden.id, 3_000);
  expect(store.listFiles(hidden.sessionId).map((file) => file.id)).toEqual(["expired"]);
  expect(store.listFiles(hidden.sessionId, true).map((file) => file.id)).toEqual(["hidden", "expired"]);

  store.setFileHidden(hidden.sessionId, hidden.id, undefined);
  expect(store.getFile(hidden.sessionId, hidden.id)?.hiddenAt).toBeUndefined();
  expect(store.pruneFiles(5_000).map((file) => file.id)).toEqual(["expired"]);
  expect(store.getFile(expired.sessionId, expired.id)).toBeUndefined();

  store.upsert(sample(hidden.sessionId));
  store.delete(hidden.sessionId);
  expect(store.listFiles(hidden.sessionId, true)).toEqual([]);
});

test("dangerouslySkip round-trips (0/1 boolean) through a reopen", () => {
  store.upsert({ ...sample("a"), dangerouslySkip: true });
  store.close();
  const reopened = openSessionStore({ dbPath: join(dir, "sessions.db") });
  expect(reopened.get("a")?.dangerouslySkip).toBe(true);
  reopened.close();
});

test("list returns all rows; delete removes one", () => {
  store.upsert(sample("a"));
  store.upsert(sample("b"));
  expect(
    store
      .list()
      .map((s) => s.id)
      .sort(),
  ).toEqual(["a", "b"]);
  store.delete("a");
  expect(store.list().map((s) => s.id)).toEqual(["b"]);
});

test("an in-memory store (dbPath ':memory:' fallback path) satisfies the same contract", () => {
  const mem = openSessionStore({ dbPath: ":memory:" });
  mem.upsert(sample("x"));
  expect(mem.get("x")).toEqual(sample("x"));
  mem.close();
});

test("reports mode 'sqlite' when the native module loads (durable path)", () => {
  // The default open (this suite's store) uses the real better-sqlite3 — CI hard-verifies it built.
  expect(store.mode).toBe("sqlite");
});

test("session defaults use compare-and-swap revisions and defensive clones", () => {
  expect(store.getSessionDefaults()).toBeUndefined();

  const input = {
    effort: "high",
    dangerouslySkip: false,
    codex: { addDirs: ["/work/one"] },
  };
  const first = store.putSessionDefaults(input, 0, 1_000);
  expect(first).toEqual({ defaults: input, revision: 1, updatedAt: 1_000 });

  input.effort = "source-mutated";
  input.codex.addDirs[0] = "/source-mutated";
  first.defaults.effort = "result-mutated";
  first.defaults.codex!.addDirs![0] = "/result-mutated";
  expect(store.getSessionDefaults()).toEqual({
    defaults: { effort: "high", dangerouslySkip: false, codex: { addDirs: ["/work/one"] } },
    revision: 1,
    updatedAt: 1_000,
  });

  const second = store.putSessionDefaults({ effort: "xhigh", dangerouslySkip: true }, 1, 2_000);
  expect(second).toEqual({
    defaults: { effort: "xhigh", dangerouslySkip: true },
    revision: 2,
    updatedAt: 2_000,
  });

  let conflict: unknown;
  try {
    store.putSessionDefaults({ effort: "low", dangerouslySkip: false }, 1, 3_000);
  } catch (error) {
    conflict = error;
  }
  expect(conflict).toBeInstanceOf(SessionDefaultsConflictError);
  expect(conflict).toMatchObject({ current: second });
  const current = (conflict as SessionDefaultsConflictError).current!;
  current.defaults.effort = "conflict-mutated";
  expect(store.getSessionDefaults()).toEqual(second);
});

test("server-owned last-launch writes replace choices and advance the revision without browser CAS", () => {
  store.putSessionDefaults({ effort: "low", dangerouslySkip: false }, 0, 1_000);

  const remembered = store.rememberSessionDefaults(
    {
      provider: "claude",
      effort: "high",
      model: "claude-next",
      dangerouslySkip: false,
      addDirs: ["/work/shared"],
    },
    2_000,
  );

  expect(remembered).toEqual({
    defaults: {
      provider: "claude",
      effort: "high",
      model: "claude-next",
      dangerouslySkip: false,
      addDirs: ["/work/shared"],
    },
    revision: 2,
    updatedAt: 2_000,
  });
  remembered.defaults.addDirs![0] = "/mutated";
  expect(store.getSessionDefaults()?.defaults.addDirs).toEqual(["/work/shared"]);
});

test("session defaults survive closing and reopening SQLite", () => {
  const dbPath = join(dir, "sessions.db");
  store.putSessionDefaults(
    {
      effort: "high",
      model: "claude-opus-4-1",
      dangerouslySkip: false,
      permissionMode: "plan",
      codex: { model: "gpt-5-codex", sandbox: "workspace-write" },
    },
    0,
    4_000,
  );
  store.close();

  const reopened = openSessionStore({ dbPath });
  expect(reopened.getSessionDefaults()).toEqual({
    defaults: {
      effort: "high",
      model: "claude-opus-4-1",
      dangerouslySkip: false,
      permissionMode: "plan",
      codex: { model: "gpt-5-codex", sandbox: "workspace-write" },
    },
    revision: 1,
    updatedAt: 4_000,
  });
  reopened.close();
});

test("memory fallback has the same session-defaults revision and conflict behavior", () => {
  const fallback = openSessionStore({
    dbPath: join(dir, "unused-defaults.db"),
    loadDatabase: () => {
      throw new Error("simulated better-sqlite3 load failure");
    },
  });

  expect(fallback.getSessionDefaults()).toBeUndefined();
  const first = fallback.putSessionDefaults({ effort: "medium", dangerouslySkip: false }, 0, 10);
  expect(first.revision).toBe(1);
  expect(() => fallback.putSessionDefaults({ effort: "high", dangerouslySkip: false }, 0, 20)).toThrow(
    SessionDefaultsConflictError,
  );
  const second = fallback.putSessionDefaults({ effort: "high", dangerouslySkip: false }, 1, 30);
  expect(second).toEqual({
    defaults: { effort: "high", dangerouslySkip: false },
    revision: 2,
    updatedAt: 30,
  });
  expect(fallback.rememberSessionDefaults({ provider: "codex", effort: "high", dangerouslySkip: false }, 40)).toEqual({
    defaults: { provider: "codex", effort: "high", dangerouslySkip: false },
    revision: 3,
    updatedAt: 40,
  });
  fallback.close();
});

test("FALLS BACK to a non-durable in-memory store (mode 'memory-fallback') when better-sqlite3 fails to load", () => {
  // Force the native-load failure via the injectable loader seam — exactly what happens on a host with
  // no toolchain / an unbuilt binding. The store must still satisfy the contract, but flag itself
  // non-durable so start.ts can warn + /diag can surface it.
  const fallback = openSessionStore({
    dbPath: join(dir, "unused.db"),
    loadDatabase: () => {
      throw new Error("simulated better-sqlite3 load failure");
    },
  });
  expect(fallback.mode).toBe("memory-fallback");
  fallback.upsert(sample("y"));
  expect(fallback.get("y")).toEqual(sample("y"));
  fallback.close();
});

test("keeps legacy sessions as Claude and stores Codex in provider_sessions", () => {
  store.upsert(sample("c1"));
  store.upsert({ ...codexSample("x1"), providerSessionId: "thread-1" });

  expect(store.list().map((session) => [session.id, session.provider])).toEqual([
    ["c1", "claude"],
    ["x1", "codex"],
  ]);
  const codex = store.get("x1");
  expect(codex?.provider).toBe("codex");
  expect(codex?.providerSessionId).toBe("thread-1");
  expect(codex?.launchOptions).toEqual({
    provider: "codex",
    model: "gpt-5-codex",
    sandbox: "workspace-write",
  });
  expect(codex?.integrationStatus).toEqual({
    attachments: "ready",
    activity: "degraded",
    detail: "pane fallback",
  });
});

test("merges providers in stable createdAt then id order", () => {
  store.upsert(codexSample("z", 5));
  store.upsert({ ...sample("b"), createdAt: 5 });
  store.upsert(codexSample("a", 5));
  store.upsert({ ...sample("old"), createdAt: 1 });

  expect(store.list().map((session) => session.id)).toEqual(["old", "a", "b", "z"]);
});

test("routes Codex mutations to its owning row and only sets provider session ids for Codex", () => {
  store.upsert(sample("claude"));
  store.upsert(codexSample("codex"));

  store.setStatus("codex", "dormant");
  store.touch("codex", 3000);
  store.setName("codex", "Codex work");
  store.setProviderSessionId("codex", "thread-exact");
  store.setProviderSessionId("claude", "must-not-be-written");

  expect(store.get("codex")).toMatchObject({
    provider: "codex",
    status: "dormant",
    lastActivityAt: 3000,
    name: "Codex work",
    providerSessionId: "thread-exact",
  });
  expect(store.get("claude")).not.toHaveProperty("providerSessionId");

  store.delete("codex");
  expect(store.get("codex")).toBeUndefined();
  expect(store.get("claude")?.provider).toBe("claude");
});

test("forced memory fallback has parity for Codex identity and stable union ordering", () => {
  const fallback = openSessionStore({
    dbPath: join(dir, "unused-provider.db"),
    loadDatabase: () => {
      throw new Error("simulated better-sqlite3 load failure");
    },
  });
  fallback.upsert(codexSample("x", 2));
  fallback.upsert({ ...sample("c"), createdAt: 1 });
  fallback.setProviderSessionId("x", "thread-memory");
  fallback.setProviderSessionId("c", "not-claude");

  expect(fallback.list().map((session) => [session.id, session.provider])).toEqual([
    ["c", "claude"],
    ["x", "codex"],
  ]);
  expect(fallback.get("x")).toMatchObject({ provider: "codex", providerSessionId: "thread-memory" });
  expect(fallback.get("c")).not.toHaveProperty("providerSessionId");
  fallback.close();
});

test("provisional Codex identities stay hidden until atomically committed in every store mode", () => {
  const fallback = openSessionStore({
    dbPath: join(dir, "unused-provisional.db"),
    loadDatabase: () => {
      throw new Error("simulated better-sqlite3 load failure");
    },
  });

  for (const [mode, target] of [
    ["sqlite", store],
    ["memory", fallback],
  ] as const) {
    const id = `${mode}-provisional`;
    target.claimNew(codexSample(id));
    const persistence = createCodexThreadPersistence(target, id);

    persistence.markProvisional("thread-unverified");
    expect(target.get(id)).not.toHaveProperty("providerSessionId");
    expect(target.list().find((session) => session.id === id)).not.toHaveProperty("providerSessionId");

    persistence.commit("thread-unverified");
    expect(target.get(id)).toMatchObject({ providerSessionId: "thread-unverified" });
  }

  fallback.close();
});

test("reopening SQLite discards interrupted provisional identity without exposing it as resumable", () => {
  const dbPath = join(dir, "sessions.db");
  store.claimNew(codexSample("crashed-provisional"));
  createCodexThreadPersistence(store, "crashed-provisional").markProvisional("thread-before-crash");
  expect(store.get("crashed-provisional")).not.toHaveProperty("providerSessionId");

  store.close();
  const reopened = openSessionStore({ dbPath });
  expect(reopened.get("crashed-provisional")).not.toHaveProperty("providerSessionId");

  const recovered = createCodexThreadPersistence(reopened, "crashed-provisional");
  recovered.markProvisional("thread-after-restart");
  recovered.commit("thread-after-restart");
  expect(reopened.get("crashed-provisional")).toMatchObject({ providerSessionId: "thread-after-restart" });
  reopened.close();
});

test("migrates an existing provider_sessions table with separate provisional identity state", () => {
  const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
  const Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  const dbPath = join(dir, "pre-provisional.db");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE provider_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider = 'codex'),
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      name TEXT,
      provider_session_id TEXT,
      launch_options_json TEXT NOT NULL,
      integration_status_json TEXT
    )
  `);
  legacy.close();

  const migrated = openSessionStore({ dbPath });
  const inspected = new Database(dbPath);
  const columns = inspected.prepare("PRAGMA table_info(provider_sessions)").all() as Array<{ name: string }>;
  expect(columns.map((column) => column.name)).toContain("provisional_provider_session_id");
  inspected.close();
  migrated.close();
});

test("rejects unvalidated Codex integration JSON before it can be persisted", () => {
  const invalid = {
    ...codexSample("secret-bearing"),
    integrationStatus: {
      attachments: "ready",
      activity: "ready",
      apiKey: "must-never-reach-storage",
    },
  } as unknown as StoredSession;

  expect(() => store.upsert(invalid)).toThrow("Invalid integration status");
  expect(store.get("secret-bearing")).toBeUndefined();
});

test("fails closed on cross-provider id collisions in SQLite and memory fallback", () => {
  store.upsert(sample("collision"));
  expect(() => store.upsert(codexSample("collision"))).toThrow("already belongs to claude");

  const fallback = openSessionStore({
    dbPath: join(dir, "unused-collision.db"),
    loadDatabase: () => {
      throw new Error("simulated better-sqlite3 load failure");
    },
  });
  fallback.upsert(codexSample("collision"));
  expect(() => fallback.upsert(sample("collision"))).toThrow("already belongs to codex");
  fallback.close();
});

test("claimNew rejects an existing same-provider owner without overwriting it in every store mode", () => {
  const fallback = openSessionStore({
    dbPath: join(dir, "unused-claim-new.db"),
    loadDatabase: () => {
      throw new Error("simulated better-sqlite3 load failure");
    },
  });

  for (const [mode, target] of [
    ["sqlite", store],
    ["memory", fallback],
  ] as const) {
    target.claimNew({
      ...codexSample(`${mode}-claim`),
      cwd: "/winner",
      launchOptions: { provider: "codex", model: "winner" },
    });
    expect(() =>
      target.claimNew({
        ...codexSample(`${mode}-claim`),
        cwd: "/loser",
        launchOptions: { provider: "codex", model: "loser" },
      }),
    ).toThrow(`Session id ${mode}-claim already exists`);
    expect(target.get(`${mode}-claim`)).toMatchObject({
      cwd: "/winner",
      launchOptions: { provider: "codex", model: "winner" },
    });

    target.upsert({ ...codexSample(`${mode}-claim`), cwd: "/intentional-update" });
    expect(target.get(`${mode}-claim`)?.cwd).toBe("/intentional-update");
  }

  fallback.close();
});

test("two SQLite connections atomically leave one physical owner during a cross-provider race", async () => {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return;
  }
  const dbPath = join(dir, "sessions.db");
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const loaded = require("better-sqlite3");
      const Database = loaded.default || loaded;
      const db = new Database(workerData.dbPath);
      db.pragma("journal_mode = WAL");
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        "INSERT INTO sessions (id, cwd, dangerously_skip, status, created_at, last_activity_at, mode) VALUES (?,?,?,?,?,?,?)"
      ).run("raced", "/claude", 0, "running", 1, 1, "terminal");
      parentPort.postMessage("locked");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
        parentPort.postMessage("committed");
      }, 250);
    `,
    { eval: true, workerData: { dbPath } },
  );
  await new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", (message) => {
      if (message === "locked") resolve();
      else reject(new Error(`unexpected worker message: ${String(message)}`));
    });
  });
  const workerExited = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
  });

  let collisionError: unknown;
  try {
    store.upsert(codexSample("raced"));
  } catch (error) {
    collisionError = error;
  }
  await workerExited;

  const inspected = new Database(dbPath);
  const legacyCount = (
    inspected.prepare("SELECT count(*) AS n FROM sessions WHERE id = ?").get("raced") as {
      n: number;
    }
  ).n;
  const providerCount = (
    inspected.prepare("SELECT count(*) AS n FROM provider_sessions WHERE id = ?").get("raced") as { n: number }
  ).n;
  inspected.close();

  expect(collisionError).toMatchObject({ message: "Session id raced already belongs to claude" });
  expect({ legacyCount, providerCount }).toEqual({ legacyCount: 1, providerCount: 0 });
});

test("rejects empty provider session ids at upsert and mutation boundaries in every store mode", () => {
  const fallback = openSessionStore({
    dbPath: join(dir, "unused-empty-provider-id.db"),
    loadDatabase: () => {
      throw new Error("simulated better-sqlite3 load failure");
    },
  });

  for (const [mode, target] of [
    ["sqlite", store],
    ["memory", fallback],
  ] as const) {
    expect(() => target.upsert({ ...codexSample(`${mode}-upsert`), providerSessionId: "" })).toThrow(
      "Invalid provider session id",
    );
    expect(target.get(`${mode}-upsert`)).toBeUndefined();

    target.upsert({ ...codexSample(`${mode}-mutation`), providerSessionId: "thread-existing" });
    expect(() => target.setProviderSessionId(`${mode}-mutation`, "")).toThrow("Invalid provider session id");
    expect(target.get(`${mode}-mutation`)?.providerSessionId).toBe("thread-existing");
  }

  fallback.close();
});

test("preserves exact valid provider session ids and rejects unsafe values in every store mode", () => {
  const fallback = openSessionStore({
    dbPath: join(dir, "unused-unsafe-provider-id.db"),
    loadDatabase: () => {
      throw new Error("simulated better-sqlite3 load failure");
    },
  });
  const exactId = "  thread/opaque:α  ";
  const invalidIds = [
    "   ",
    "thread\nsecond-line",
    "thread\0suffix",
    "thread\u0085next-line",
    "thread\u009bcontrol-sequence",
    "thread\u2028line-separator",
    "thread\u2029paragraph-separator",
    "x".repeat(2049),
  ];

  for (const [mode, target] of [
    ["sqlite", store],
    ["memory", fallback],
  ] as const) {
    const id = `${mode}-exact`;
    target.upsert({ ...codexSample(id), providerSessionId: exactId });
    expect(target.get(id)?.providerSessionId).toBe(exactId);

    for (const invalidId of invalidIds) {
      expect(() => target.setProviderSessionId(id, invalidId)).toThrow("Invalid provider session id");
      expect(target.get(id)?.providerSessionId).toBe(exactId);
    }
  }

  fallback.close();
});
