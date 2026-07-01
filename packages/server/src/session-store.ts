import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export type StoredStatus = "running" | "dormant" | "errored" | "stopped";

export interface StoredSession {
  id: string;
  cwd: string;
  dangerouslySkip: boolean;
  status: StoredStatus;
  createdAt: number;
  lastActivityAt: number;
  /** Always "terminal" — the only session kind. Kept so rehydrate can filter/guard on it. */
  mode: "terminal";
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

/** Row <-> StoredSession mapping (SQLite stores booleans as 0/1). */
interface Row {
  id: string;
  cwd: string;
  dangerously_skip: number;
  status: string;
  created_at: number;
  last_activity_at: number;
  mode: string | null;
}

function rowToSession(r: Row): StoredSession {
  return {
    id: r.id,
    cwd: r.cwd,
    dangerouslySkip: r.dangerously_skip === 1,
    status: r.status as StoredStatus,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
    mode: "terminal",
  };
}

/**
 * In-memory fallback used when the native better-sqlite3 module cannot load
 * (no toolchain / unsupported platform) so the server still boots. NOT durable
 * across process restarts — surfaced as a diagnostic by the caller.
 */
function inMemoryStore(): SessionStore {
  const map = new Map<string, StoredSession>();
  return {
    upsert: (s) => void map.set(s.id, { ...s, mode: "terminal" }),
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
      dangerously_skip INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'terminal'
    )
  `);

  // TERMINAL-ONLY MIGRATION: a chat-era DB carries dead columns (model, effort, permission_mode,
  // display_name, context_window) and possibly stale mode!='terminal' rows the app never surfaces.
  // Drop the dead columns and prune the stale rows so the schema matches the terminal-only model. All
  // guarded (best-effort): on a FRESH DB the columns don't exist ("no such column"); on an ancient SQLite
  // DROP COLUMN may be unsupported — either way we swallow and boot with the columns simply unused.
  for (const col of ["model", "effort", "permission_mode", "display_name", "context_window"]) {
    try {
      db.exec(`ALTER TABLE sessions DROP COLUMN ${col}`);
    } catch {
      // column already gone (fresh DB) or DROP COLUMN unsupported — harmless, leave it be
    }
  }
  // A pre-`mode` (Plan-5) DB lacks the column entirely; add it so the prune + queries below work.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'terminal'");
  } catch {
    // column already exists — nothing to do
  }
  // Prune leftover non-terminal (chat) rows — never adopted or surfaced by the terminal app, just cruft.
  try {
    db.exec("DELETE FROM sessions WHERE mode IS NOT NULL AND mode != 'terminal'");
  } catch {
    // best-effort — never block boot on the prune
  }

  const upsertStmt = db.prepare(`
    INSERT INTO sessions (id, cwd, dangerously_skip, status, created_at, last_activity_at, mode)
    VALUES (@id, @cwd, @dangerously_skip, @status, @created_at, @last_activity_at, @mode)
    ON CONFLICT(id) DO UPDATE SET
      cwd=excluded.cwd, dangerously_skip=excluded.dangerously_skip,
      status=excluded.status, created_at=excluded.created_at, last_activity_at=excluded.last_activity_at,
      mode=excluded.mode
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
        dangerously_skip: s.dangerouslySkip ? 1 : 0,
        status: s.status,
        created_at: s.createdAt,
        last_activity_at: s.lastActivityAt,
        mode: s.mode ?? "terminal",
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
