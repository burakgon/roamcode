import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export interface PushSubscriptionRecord {
  /** Browser push endpoint URL (PRIMARY KEY — one per subscription). */
  endpoint: string;
  /** PushSubscription.keys.p256dh (client public key). */
  p256dh: string;
  /** PushSubscription.keys.auth (client auth secret). */
  auth: string;
  /** Optional session scope; undefined = subscribed to ALL sessions. */
  sessionId?: string;
  /** Per-device credential that created this subscription. Revocation removes its push channel too. */
  deviceId?: string;
  createdAt: number;
}

export interface PushStore {
  upsert(sub: PushSubscriptionRecord): void;
  /** All subscriptions, or — with { sessionId } — the global (NULL) ones UNION the session-scoped ones. */
  list(opts?: { sessionId?: string }): PushSubscriptionRecord[];
  remove(endpoint: string): void;
  removeForDevice(deviceId: string): void;
  close(): void;
}

export interface OpenPushStoreOptions {
  /** SQLite file path. ":memory:" uses an in-process DB. */
  dbPath: string;
}

/** Row <-> PushSubscriptionRecord mapping (SQLite stores optional scope as NULL). */
interface Row {
  endpoint: string;
  p256dh: string;
  auth: string;
  session_id: string | null;
  device_id: string | null;
  created_at: number;
}

function rowToSub(r: Row): PushSubscriptionRecord {
  const s: PushSubscriptionRecord = {
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    createdAt: r.created_at,
  };
  if (r.session_id !== null) s.sessionId = r.session_id;
  if (r.device_id !== null) s.deviceId = r.device_id;
  return s;
}

/**
 * In-memory fallback used when the native better-sqlite3 module cannot load
 * (no toolchain / unsupported platform) so the server still boots. NOT durable
 * across process restarts — mirrors the SessionStore/idempotency-store pattern.
 */
function inMemoryStore(): PushStore {
  const map = new Map<string, PushSubscriptionRecord>();
  return {
    upsert: (s) => void map.set(s.endpoint, { ...s }),
    list: (opts) => {
      const all = [...map.values()].map((v) => ({ ...v }));
      if (!opts?.sessionId) return all;
      return all.filter((s) => s.sessionId === undefined || s.sessionId === opts.sessionId);
    },
    remove: (endpoint) => void map.delete(endpoint),
    removeForDevice: (deviceId) => {
      for (const [endpoint, sub] of map) if (sub.deviceId === deviceId) map.delete(endpoint);
    },
    close: () => map.clear(),
  };
}

export function openPushStore(opts: OpenPushStoreOptions): PushStore {
  let Database: typeof import("better-sqlite3");
  try {
    // Dynamic require keeps the native dep out of the module graph until needed
    // and lets us fall back gracefully if the build is missing.
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return inMemoryStore();
  }

  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL"); // parity with the session store (concurrent reader/writer safety)
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      session_id TEXT,
      device_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  // Existing installs predate per-device credentials. Add the nullable owner column in place; legacy
  // subscriptions remain valid and unowned until their browser subscribes again.
  const columns = db.prepare("PRAGMA table_info(push_subscriptions)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "device_id")) {
    db.exec("ALTER TABLE push_subscriptions ADD COLUMN device_id TEXT");
  }

  const upsertStmt = db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, session_id, device_id, created_at)
    VALUES (@endpoint, @p256dh, @auth, @session_id, @device_id, @created_at)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh=excluded.p256dh, auth=excluded.auth, session_id=excluded.session_id,
      device_id=excluded.device_id, created_at=excluded.created_at
  `);
  const listAllStmt = db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at ASC");
  const listScopedStmt = db.prepare(
    "SELECT * FROM push_subscriptions WHERE session_id IS NULL OR session_id = ? ORDER BY created_at ASC",
  );
  const removeStmt = db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?");
  const removeForDeviceStmt = db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?");

  return {
    upsert: (s) =>
      void upsertStmt.run({
        endpoint: s.endpoint,
        p256dh: s.p256dh,
        auth: s.auth,
        session_id: s.sessionId ?? null,
        device_id: s.deviceId ?? null,
        created_at: s.createdAt,
      }),
    list: (opts) => {
      const rows = (opts?.sessionId ? listScopedStmt.all(opts.sessionId) : listAllStmt.all()) as Row[];
      return rows.map(rowToSub);
    },
    remove: (endpoint) => void removeStmt.run(endpoint),
    removeForDevice: (deviceId) => void removeForDeviceStmt.run(deviceId),
    close: () => db.close(),
  };
}
