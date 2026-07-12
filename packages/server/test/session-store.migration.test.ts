import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openSessionStore } from "../src/index.js";

const require = createRequire(import.meta.url);

let dir: string;
let dbPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-mig-"));
  dbPath = join(dir, "s.db");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Simulate a chat-era DB (the FULL pre-migration schema, with a stale chat row + a live terminal row).
 * Opening it through openSessionStore must DROP the dead chat columns, PRUNE the non-terminal rows, keep
 * the terminal row intact, and stay idempotent on reopen — without ever crashing boot.
 */
test("opening a chat-era DB drops dead columns + prunes non-terminal rows (terminal-only migration)", () => {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    // No native sqlite available — the in-memory fallback has no schema to migrate; skip.
    return;
  }

  // The FULL chat-era schema, seeded with one stale chat row and one live terminal row.
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, model TEXT, effort TEXT, permission_mode TEXT,
      dangerously_skip INTEGER NOT NULL DEFAULT 0, display_name TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, context_window INTEGER,
      mode TEXT NOT NULL DEFAULT 'chat'
    )
  `);
  old
    .prepare(
      "INSERT INTO sessions (id, cwd, model, permission_mode, dangerously_skip, status, created_at, last_activity_at, context_window, mode) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run("chatty", "/old", "opus", "plan", 0, "dormant", 1, 1, 200000, "chat");
  old
    .prepare(
      "INSERT INTO sessions (id, cwd, dangerously_skip, status, created_at, last_activity_at, mode) VALUES (?,?,?,?,?,?,?)",
    )
    .run("term1", "/work", 1, "running", 2, 2, "terminal");
  old.close();

  // Open through the store → runs the terminal-only migration.
  const store = openSessionStore({ dbPath });
  // The stale chat row is pruned.
  expect(store.get("chatty")).toBeUndefined();
  // The terminal row survives with only the kept fields (dangerouslySkip round-trips as a boolean).
  expect(store.get("term1")).toEqual({
    provider: "claude",
    id: "term1",
    cwd: "/work",
    dangerouslySkip: true,
    status: "running",
    createdAt: 2,
    lastActivityAt: 2,
    mode: "terminal",
  });
  // A fresh upsert works against the cleaned schema.
  store.upsert({
    provider: "claude",
    id: "term2",
    cwd: "/w2",
    dangerouslySkip: false,
    status: "running",
    createdAt: 3,
    lastActivityAt: 3,
    mode: "terminal",
  });
  expect(store.get("term2")?.id).toBe("term2");
  store.close();

  // The dead chat columns were physically DROPPED — table_info lists only the terminal-era columns
  // (plus the nullable `name` the session-name migration APPENDS to a pre-name DB).
  const raw = new Database(dbPath);
  const cols = (raw.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  raw.close();
  for (const dead of ["model", "effort", "permission_mode", "display_name", "context_window"]) {
    expect(cols).not.toContain(dead);
  }
  expect(cols).toEqual([
    "id",
    "cwd",
    "dangerously_skip",
    "status",
    "created_at",
    "last_activity_at",
    "mode",
    "name",
    "spawn_args",
  ]);

  // Idempotent: reopening the already-migrated DB (columns gone, no chat rows) must not throw.
  const reopened = openSessionStore({ dbPath });
  expect(reopened.get("term1")?.mode).toBe("terminal");
  reopened.close();
});

/**
 * Session-name migration: opening a PRE-NAME DB (the exact schema the previous release created) must add
 * the nullable `name` column WITHOUT touching existing rows — old sessions read back name-less (absent
 * field, not null/""), a rename round-trips through setName, and clearing reverts to absent.
 */
test("opening a pre-name DB adds the nullable name column; old rows stay name-less; setName round-trips", () => {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    // No native sqlite available — the in-memory fallback has no schema to migrate; skip.
    return;
  }

  // The FULL pre-name (terminal-era) schema with one live row.
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, dangerously_skip INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'terminal'
    )
  `);
  old
    .prepare(
      "INSERT INTO sessions (id, cwd, dangerously_skip, status, created_at, last_activity_at, mode) VALUES (?,?,?,?,?,?,?)",
    )
    .run("term1", "/work", 0, "running", 1, 1, "terminal");
  old.close();

  const store = openSessionStore({ dbPath });
  // The old row survives, name-less (the field is ABSENT, so `?? cwd` fallbacks work).
  expect(store.get("term1")).toEqual({
    provider: "claude",
    id: "term1",
    cwd: "/work",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
    mode: "terminal",
  });
  expect(store.get("term1")?.name).toBeUndefined();

  // Rename → persisted; clear → back to absent.
  store.setName("term1", "wave 9 dialogs");
  expect(store.get("term1")?.name).toBe("wave 9 dialogs");
  store.setName("term1", undefined);
  expect(store.get("term1")?.name).toBeUndefined();

  // A named upsert round-trips, and the name SURVIVES a reopen (it's what rehydrate reads after a restart).
  store.setName("term1", "persisted-name");
  store.close();
  const reopened = openSessionStore({ dbPath });
  expect(reopened.get("term1")?.name).toBe("persisted-name");
  reopened.close();
});

/**
 * spawn-args persistence: the user's chosen spawn flags must SURVIVE a reopen (a server restart), because
 * that's what lets a rehydrated session respawn with the same model/effort/permission/danger instead of a
 * bare claude. A row without them reads back absent (old sessions simply respawn flag-less).
 */
test("spawn_args round-trips through a reopen; an absent value stays absent", () => {
  try {
    require("better-sqlite3");
  } catch {
    return; // in-memory fallback has no durable schema to test
  }
  const store = openSessionStore({ dbPath });
  store.upsert({
    provider: "claude",
    id: "s1",
    cwd: "/w",
    dangerouslySkip: true,
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
    mode: "terminal",
    spawnArgs: ["--model", "opus", "--effort", "max", "--dangerously-skip-permissions"],
  });
  store.upsert({
    provider: "claude",
    id: "s2",
    cwd: "/w2",
    dangerouslySkip: false,
    status: "running",
    createdAt: 2,
    lastActivityAt: 2,
    mode: "terminal",
  }); // no spawnArgs
  store.close();

  const reopened = openSessionStore({ dbPath });
  expect(reopened.get("s1")?.spawnArgs).toEqual([
    "--model",
    "opus",
    "--effort",
    "max",
    "--dangerously-skip-permissions",
  ]);
  expect(reopened.get("s2")?.spawnArgs).toBeUndefined();
  reopened.close();
});

test("migration leaves the legacy sessions table byte-for-byte readable and creates an empty Codex table", () => {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return;
  }

  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      dangerously_skip INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'terminal',
      name TEXT,
      spawn_args TEXT
    )
  `);
  legacy
    .prepare(
      "INSERT INTO sessions (id, cwd, dangerously_skip, status, created_at, last_activity_at, mode, name, spawn_args) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run("old", "/legacy", 1, "dormant", 10, 20, "terminal", "Legacy", '["--model","opus"]');
  const before = legacy.prepare("SELECT * FROM sessions WHERE id = ?").get("old");
  legacy.close();

  const store = openSessionStore({ dbPath });
  expect(store.get("old")).toMatchObject({ provider: "claude", id: "old", mode: "terminal" });
  store.close();

  const inspected = new Database(dbPath);
  expect(inspected.prepare("SELECT * FROM sessions WHERE id = ?").get("old")).toEqual(before);
  expect(inspected.prepare("SELECT * FROM provider_sessions").all()).toEqual([]);
  inspected.close();
});

test("opening an existing database adds the app_settings table without changing existing rows", () => {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return;
  }

  const existing = new Database(dbPath);
  existing.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      dangerously_skip INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'terminal',
      name TEXT,
      spawn_args TEXT
    );
    INSERT INTO sessions
      (id, cwd, dangerously_skip, status, created_at, last_activity_at, mode, name, spawn_args)
    VALUES
      ('existing', '/work', 0, 'dormant', 1, 2, 'terminal', NULL, NULL);
  `);
  const before = existing.prepare("SELECT * FROM sessions WHERE id = 'existing'").get();
  existing.close();

  const initialized = openSessionStore({ dbPath });
  initialized.close();

  const inspected = new Database(dbPath);
  expect(inspected.prepare("SELECT * FROM sessions WHERE id = 'existing'").get()).toEqual(before);
  expect(inspected.prepare("PRAGMA table_info(app_settings)").all()).toEqual([
    { cid: 0, name: "key", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { cid: 1, name: "value_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { cid: 2, name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { cid: 3, name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  ]);
  const schema = inspected
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'")
    .get() as {
    sql: string;
  };
  expect(schema.sql).toContain("CHECK (revision > 0)");
  inspected.close();
});

test("malformed stored session defaults read as unset without deleting the diagnostic row", () => {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return;
  }

  const initialized = openSessionStore({ dbPath });
  initialized.close();

  const raw = new Database(dbPath);
  raw
    .prepare("INSERT INTO app_settings (key, value_json, revision, updated_at) VALUES (?, ?, ?, ?)")
    .run("session_defaults", '{"effort":"high","dangerouslySkip":"yes"}', 3, 5_000);
  raw.close();

  const store = openSessionStore({ dbPath });
  expect(store.getSessionDefaults()).toBeUndefined();
  store.close();

  const inspected = new Database(dbPath);
  expect(inspected.prepare("SELECT * FROM app_settings WHERE key = ?").get("session_defaults")).toEqual({
    key: "session_defaults",
    value_json: '{"effort":"high","dangerouslySkip":"yes"}',
    revision: 3,
    updated_at: 5_000,
  });
  inspected.close();
});

test("corrupt Codex JSON fails closed without deleting the diagnostic row", () => {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return;
  }

  const initialized = openSessionStore({ dbPath });
  initialized.close();
  const raw = new Database(dbPath);
  raw
    .prepare(
      "INSERT INTO provider_sessions (id, provider, cwd, status, created_at, last_activity_at, launch_options_json) VALUES (?,?,?,?,?,?,?)",
    )
    .run("corrupt", "codex", "/work", "dormant", 1, 1, '{"provider":"codex","apiKey":"secret"}');
  raw.close();

  const store = openSessionStore({ dbPath });
  expect(store.get("corrupt")).toBeUndefined();
  expect(store.list()).toEqual([]);
  store.close();

  const inspected = new Database(dbPath);
  expect(inspected.prepare("SELECT id FROM provider_sessions WHERE id = ?").get("corrupt")).toEqual({
    id: "corrupt",
  });
  inspected.close();
});

test("routes new Claude and Codex rows to separate physical tables", () => {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return;
  }

  const store = openSessionStore({ dbPath });
  store.upsert({
    provider: "claude",
    id: "claude-new",
    cwd: "/claude",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
    mode: "terminal",
  });
  store.upsert({
    provider: "codex",
    id: "codex-new",
    cwd: "/codex",
    status: "running",
    createdAt: 2,
    lastActivityAt: 2,
    mode: "terminal",
    launchOptions: { provider: "codex", approvalPolicy: "on-request" },
  });
  store.close();

  const raw = new Database(dbPath);
  expect(raw.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "claude-new" }]);
  expect(raw.prepare("SELECT id, provider FROM provider_sessions ORDER BY id").all()).toEqual([
    { id: "codex-new", provider: "codex" },
  ]);
  raw.close();
});

test("list excludes pre-existing cross-table id collisions and keeps stable order", () => {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return;
  }

  const initialized = openSessionStore({ dbPath });
  initialized.close();

  const raw = new Database(dbPath);
  const insertLegacy = raw.prepare(
    "INSERT INTO sessions (id, cwd, dangerously_skip, status, created_at, last_activity_at, mode) VALUES (?,?,?,?,?,?,?)",
  );
  const insertProvider = raw.prepare(
    "INSERT INTO provider_sessions (id, provider, cwd, status, created_at, last_activity_at, launch_options_json) VALUES (?,?,?,?,?,?,?)",
  );
  insertLegacy.run("collision", "/legacy-collision", 0, "dormant", 1, 1, "terminal");
  insertProvider.run("collision", "codex", "/codex-collision", "dormant", 2, 2, '{"provider":"codex"}');
  insertProvider.run("z-provider", "codex", "/z", "dormant", 5, 5, '{"provider":"codex"}');
  insertLegacy.run("b-legacy", "/b", 0, "dormant", 5, 5, "terminal");
  insertProvider.run("a-provider", "codex", "/a", "dormant", 5, 5, '{"provider":"codex"}');
  insertLegacy.run("old-legacy", "/old", 0, "dormant", 3, 3, "terminal");
  raw.close();

  const store = openSessionStore({ dbPath });
  expect(store.get("collision")).toBeUndefined();
  expect(store.list().map((session) => session.id)).toEqual(["old-legacy", "a-provider", "b-legacy", "z-provider"]);
  store.close();
});
