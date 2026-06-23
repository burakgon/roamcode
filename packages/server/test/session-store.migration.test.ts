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
 * Simulate a pre-Plan-6 DB: a `sessions` table created WITHOUT the `permission_mode` column (the
 * exact Plan-5 schema). Opening it through `openSessionStore` must run the guarded ALTER and add
 * the column rather than crash, and subsequent upserts referencing @permission_mode must succeed.
 */
test("opening a pre-Plan-6 DB missing permission_mode migrates in place (no crash, column added)", () => {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    // No native sqlite available — the in-memory fallback has no schema to migrate; skip.
    return;
  }

  // Create the OLD (column-less) schema directly, exactly as Plan 5 shipped it.
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      dangerously_skip INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    )
  `);
  // Seed a pre-existing row so we can also prove old rows read back with permissionMode undefined.
  old
    .prepare(
      "INSERT INTO sessions (id, cwd, dangerously_skip, status, created_at, last_activity_at) VALUES (?,?,?,?,?,?)",
    )
    .run("legacy", "/old", 0, "dormant", 1, 1);
  old.close();

  // Open through the store: this must run the guarded ALTER (add permission_mode) without crashing.
  const store = openSessionStore({ dbPath });

  // The pre-existing row reads back fine; its permissionMode is absent (NULL → undefined).
  const legacy = store.get("legacy");
  expect(legacy?.id).toBe("legacy");
  expect(legacy?.permissionMode).toBeUndefined();

  // A new upsert referencing @permission_mode succeeds (proves the column now exists).
  store.upsert({
    id: "fresh",
    cwd: "/w",
    dangerouslySkip: false,
    status: "running",
    createdAt: 2,
    lastActivityAt: 2,
    permissionMode: "plan",
  });
  expect(store.get("fresh")?.permissionMode).toBe("plan");
  store.close();

  // The ALTER is idempotent: reopening the now-migrated DB (column already present) must not throw.
  const reopened = openSessionStore({ dbPath });
  expect(reopened.get("fresh")?.permissionMode).toBe("plan");
  reopened.close();
});
