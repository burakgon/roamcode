import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export type StoredStatus = "running" | "dormant" | "errored" | "stopped";

export interface StoredSession {
  id: string;
  cwd: string;
  model?: string;
  effort?: string;
  dangerouslySkip: boolean;
  displayName?: string;
  status: StoredStatus;
  createdAt: number;
  lastActivityAt: number;
  permissionMode?: string;
  /** The model's authoritative context window (from a result's modelUsage). Persisted so the context
   *  meter knows the right denominator on reopen/after a restart, when no result is in the buffer and the
   *  model name (often absent / lacking a "1m" marker) can't reveal it. */
  contextWindow?: number;
}

/** How a store is actually backed: "sqlite" (durable) or "memory-fallback" (the native module failed to
 *  load — NOT durable across restarts). Surfaced so start.ts can warn loudly + /diag can report it. */
export type StoreMode = "sqlite" | "memory-fallback";

export interface SessionStore {
  upsert(session: StoredSession): void;
  get(id: string): StoredSession | undefined;
  list(): StoredSession[];
  setStatus(id: string, status: StoredStatus): void;
  touch(id: string, at: number): void;
  delete(id: string): void;
  close(): void;
  /** "sqlite" when better-sqlite3 loaded; "memory-fallback" when it didn't (non-durable). */
  readonly mode: StoreMode;
}

export interface OpenSessionStoreOptions {
  /** Path to the SQLite file. ":memory:" uses an in-process DB. */
  dbPath: string;
  /** Injectable better-sqlite3 loader (the seam tests use to FORCE the in-memory fallback by throwing).
   *  Defaults to `require("better-sqlite3")`. */
  loadDatabase?: () => typeof import("better-sqlite3");
}

/** Row <-> StoredSession mapping (SQLite stores booleans as 0/1, optionals as NULL). */
interface Row {
  id: string;
  cwd: string;
  model: string | null;
  effort: string | null;
  dangerously_skip: number;
  display_name: string | null;
  status: string;
  created_at: number;
  last_activity_at: number;
  permission_mode: string | null;
  context_window: number | null;
}

function rowToSession(r: Row): StoredSession {
  const s: StoredSession = {
    id: r.id,
    cwd: r.cwd,
    dangerouslySkip: r.dangerously_skip === 1,
    status: r.status as StoredStatus,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
  };
  if (r.model !== null) s.model = r.model;
  if (r.effort !== null) s.effort = r.effort;
  if (r.display_name !== null) s.displayName = r.display_name;
  if (r.permission_mode !== null) s.permissionMode = r.permission_mode;
  if (r.context_window !== null) s.contextWindow = r.context_window;
  return s;
}

/**
 * In-memory fallback used when the native better-sqlite3 module cannot load
 * (no toolchain / unsupported platform) so the server still boots. NOT durable
 * across process restarts — surfaced as a diagnostic by the caller (Task 3/11).
 */
function inMemoryStore(): SessionStore {
  const map = new Map<string, StoredSession>();
  return {
    upsert: (s) => void map.set(s.id, { ...s }),
    get: (id) => {
      const v = map.get(id);
      return v ? { ...v } : undefined;
    },
    list: () => [...map.values()].map((v) => ({ ...v })),
    setStatus: (id, status) => {
      const v = map.get(id);
      if (v) v.status = status;
    },
    touch: (id, at) => {
      const v = map.get(id);
      if (v) v.lastActivityAt = at;
    },
    delete: (id) => void map.delete(id),
    close: () => map.clear(),
    mode: "memory-fallback",
  };
}

export function openSessionStore(opts: OpenSessionStoreOptions): SessionStore {
  let Database: typeof import("better-sqlite3");
  try {
    // Dynamic require keeps the native dep out of the module graph until needed
    // and lets us fall back gracefully if the build is missing. Injectable so tests force the fallback.
    if (opts.loadDatabase) {
      Database = opts.loadDatabase();
    } else {
      const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
      Database = (mod.default ?? mod) as typeof import("better-sqlite3");
    }
  } catch {
    return inMemoryStore();
  }

  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      permission_mode TEXT,
      dangerously_skip INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      context_window INTEGER
    )
  `);

  // Migration: a pre-Plan-6 DB (created by Plan 5) lacks permission_mode and CREATE TABLE IF NOT
  // EXISTS won't add it. Add the nullable column if missing; if the column already exists (fresh
  // DB from the CREATE above, or a previously-migrated one), SQLite throws "duplicate column name"
  // — which we swallow. Adding a nullable column is fully backward-compatible (existing rows NULL).
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN permission_mode TEXT");
  } catch {
    // column already exists — nothing to do
  }
  // Same backward-compatible migration for context_window (added later): nullable, swallow "duplicate".
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN context_window INTEGER");
  } catch {
    // column already exists — nothing to do
  }

  const upsertStmt = db.prepare(`
    INSERT INTO sessions (id, cwd, model, effort, permission_mode, dangerously_skip, display_name, status, created_at, last_activity_at, context_window)
    VALUES (@id, @cwd, @model, @effort, @permission_mode, @dangerously_skip, @display_name, @status, @created_at, @last_activity_at, @context_window)
    ON CONFLICT(id) DO UPDATE SET
      cwd=excluded.cwd, model=excluded.model, effort=excluded.effort,
      permission_mode=excluded.permission_mode,
      dangerously_skip=excluded.dangerously_skip, display_name=excluded.display_name,
      status=excluded.status, created_at=excluded.created_at, last_activity_at=excluded.last_activity_at,
      context_window=excluded.context_window
  `);
  const getStmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM sessions ORDER BY created_at ASC");
  const statusStmt = db.prepare("UPDATE sessions SET status = ? WHERE id = ?");
  const touchStmt = db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?");
  const deleteStmt = db.prepare("DELETE FROM sessions WHERE id = ?");

  return {
    upsert: (s) =>
      void upsertStmt.run({
        id: s.id,
        cwd: s.cwd,
        model: s.model ?? null,
        effort: s.effort ?? null,
        permission_mode: s.permissionMode ?? null,
        dangerously_skip: s.dangerouslySkip ? 1 : 0,
        display_name: s.displayName ?? null,
        status: s.status,
        created_at: s.createdAt,
        last_activity_at: s.lastActivityAt,
        context_window: s.contextWindow ?? null,
      }),
    get: (id) => {
      const row = getStmt.get(id) as Row | undefined;
      return row ? rowToSession(row) : undefined;
    },
    list: () => (listStmt.all() as Row[]).map(rowToSession),
    setStatus: (id, status) => void statusStmt.run(status, id),
    touch: (id, at) => void touchStmt.run(at, id),
    delete: (id) => void deleteStmt.run(id),
    close: () => db.close(),
    mode: "sqlite",
  };
}
