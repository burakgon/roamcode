import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openSessionStore } from "../src/index.js";
import type { SessionStore, StoredSession } from "../src/index.js";

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
    id,
    cwd: "/work/" + id,
    dangerouslySkip: false,
    status: "running",
    createdAt: 1000,
    lastActivityAt: 1000,
    mode: "terminal",
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
