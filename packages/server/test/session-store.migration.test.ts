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
    id: "term1",
    cwd: "/work",
    dangerouslySkip: true,
    status: "running",
    createdAt: 2,
    lastActivityAt: 2,
    mode: "terminal",
  });
  // A fresh upsert works against the cleaned schema.
  store.upsert({ id: "term2", cwd: "/w2", dangerouslySkip: false, status: "running", createdAt: 3, lastActivityAt: 3, mode: "terminal" });
  expect(store.get("term2")?.id).toBe("term2");
  store.close();

  // The dead chat columns were physically DROPPED — table_info lists only the terminal-era columns.
  const raw = new Database(dbPath);
  const cols = (raw.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  raw.close();
  for (const dead of ["model", "effort", "permission_mode", "display_name", "context_window"]) {
    expect(cols).not.toContain(dead);
  }
  expect(cols).toEqual(["id", "cwd", "dangerously_skip", "status", "created_at", "last_activity_at", "mode"]);

  // Idempotent: reopening the already-migrated DB (columns gone, no chat rows) must not throw.
  const reopened = openSessionStore({ dbPath });
  expect(reopened.get("term1")?.mode).toBe("terminal");
  reopened.close();
});
