import { createRequire } from "node:module";
import type { StoreMode } from "./session-store.js";
const require = createRequire(import.meta.url);

export interface IdempotencyStore {
  lookup(key: string, now: number): string | undefined;
  remember(key: string, sessionId: string, now: number): void;
  close(): void;
  /** "sqlite" when better-sqlite3 loaded; "memory-fallback" when it didn't (non-durable). */
  readonly mode: StoreMode;
}

export interface OpenIdempotencyStoreOptions {
  dbPath: string;
  /** Window during which a repeated key returns the same session. Default 600000 (10 min). */
  ttlMs?: number;
  /** Injectable better-sqlite3 loader (the seam tests use to FORCE the in-memory fallback by throwing).
   *  Defaults to `require("better-sqlite3")`. */
  loadDatabase?: () => typeof import("better-sqlite3");
}

function inMemory(ttlMs: number): IdempotencyStore {
  const map = new Map<string, { sessionId: string; at: number }>();
  return {
    lookup: (key, now) => {
      const v = map.get(key);
      if (!v) return undefined;
      if (now - v.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      return v.sessionId;
    },
    remember: (key, sessionId, now) => void map.set(key, { sessionId, at: now }),
    close: () => map.clear(),
    mode: "memory-fallback",
  };
}

export function openIdempotencyStore(opts: OpenIdempotencyStoreOptions): IdempotencyStore {
  const ttlMs = opts.ttlMs ?? 600000;
  let Database: typeof import("better-sqlite3");
  try {
    // Injectable so tests force the in-memory fallback by throwing.
    if (opts.loadDatabase) {
      Database = opts.loadDatabase();
    } else {
      const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
      Database = (mod.default ?? mod) as typeof import("better-sqlite3");
    }
  } catch {
    return inMemory(ttlMs);
  }

  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL"); // parity with the session store (concurrent reader/writer safety)
  db.exec(
    `CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL)`,
  );
  const getStmt = db.prepare("SELECT session_id AS sessionId, at FROM idempotency WHERE key = ?");
  const delStmt = db.prepare("DELETE FROM idempotency WHERE key = ?");
  const putStmt = db.prepare(
    "INSERT INTO idempotency (key, session_id, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET session_id=excluded.session_id, at=excluded.at",
  );

  return {
    lookup: (key, now) => {
      const row = getStmt.get(key) as { sessionId: string; at: number } | undefined;
      if (!row) return undefined;
      if (now - row.at > ttlMs) {
        delStmt.run(key);
        return undefined;
      }
      return row.sessionId;
    },
    remember: (key, sessionId, now) => void putStmt.run(key, sessionId, now),
    close: () => db.close(),
    mode: "sqlite",
  };
}
