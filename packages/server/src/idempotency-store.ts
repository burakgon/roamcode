import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type IdempotencyStoreMode = "sqlite" | "memory-fallback";

export interface IdempotencyRecord {
  actorId: string;
  key: string;
  fingerprint: string;
  statusCode: number;
  body: string;
  createdAt: number;
  expiresAt: number;
}

export interface IdempotencyStore {
  readonly mode: IdempotencyStoreMode;
  get(actorId: string, key: string, now?: number): IdempotencyRecord | undefined;
  put(record: IdempotencyRecord): void;
  close(): void;
}

export interface OpenIdempotencyStoreOptions {
  /** Reuses control.db so retry records survive the 3.0 upgrade; legacy tables remain untouched. */
  dbPath: string;
  loadDatabase?: () => typeof import("better-sqlite3");
}

function memoryStore(): IdempotencyStore {
  const records = new Map<string, IdempotencyRecord>();
  return {
    mode: "memory-fallback",
    get(actorId, key, now = Date.now()) {
      const mapKey = `${actorId}\0${key}`;
      const record = records.get(mapKey);
      if (!record || record.expiresAt <= now) {
        records.delete(mapKey);
        return undefined;
      }
      return { ...record };
    },
    put(record) {
      records.set(`${record.actorId}\0${record.key}`, { ...record });
    },
    close() {
      records.clear();
    },
  };
}

export function openIdempotencyStore(options: OpenIdempotencyStoreOptions): IdempotencyStore {
  let Database: typeof import("better-sqlite3");
  try {
    if (options.loadDatabase) Database = options.loadDatabase();
    else {
      const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
      Database = (mod.default ?? mod) as typeof import("better-sqlite3");
    }
  } catch {
    return memoryStore();
  }

  const db = new Database(options.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS control_idempotency (
      actor_id TEXT NOT NULL,
      key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (actor_id, key)
    );
    CREATE INDEX IF NOT EXISTS control_idempotency_expiry_idx ON control_idempotency(expires_at);
  `);

  const get = db.prepare(
    "SELECT actor_id, key, fingerprint, status_code, body, created_at, expires_at FROM control_idempotency WHERE actor_id=? AND key=?",
  );
  const put = db.prepare(`
    INSERT INTO control_idempotency (actor_id, key, fingerprint, status_code, body, created_at, expires_at)
    VALUES (@actor_id, @key, @fingerprint, @status_code, @body, @created_at, @expires_at)
    ON CONFLICT(actor_id, key) DO NOTHING
  `);
  const prune = db.prepare("DELETE FROM control_idempotency WHERE expires_at <= ?");

  return {
    mode: "sqlite",
    get(actorId, key, now = Date.now()) {
      prune.run(now);
      const row = get.get(actorId, key) as
        | {
            actor_id: string;
            key: string;
            fingerprint: string;
            status_code: number;
            body: string;
            created_at: number;
            expires_at: number;
          }
        | undefined;
      return row
        ? {
            actorId: row.actor_id,
            key: row.key,
            fingerprint: row.fingerprint,
            statusCode: row.status_code,
            body: row.body,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          }
        : undefined;
    },
    put(record) {
      put.run({
        actor_id: record.actorId,
        key: record.key,
        fingerprint: record.fingerprint,
        status_code: record.statusCode,
        body: record.body,
        created_at: record.createdAt,
        expires_at: record.expiresAt,
      });
    },
    close() {
      db.close();
    },
  };
}
