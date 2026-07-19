import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** A pairing link is deliberately short-lived and can be claimed exactly once. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export type DeviceScope = "direct";

const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  scopes: DeviceScope[];
}

export interface PairingTicket {
  /** One-time capability carried by the pairing URL. Never persisted in plaintext. */
  secret: string;
  expiresAt: number;
  scopes: DeviceScope[];
}

export interface DeviceEnrollment {
  /** The per-device bearer credential. Returned once; only its SHA-256 digest is persisted. */
  token: string;
  device: DeviceInfo;
}

export interface DeviceStore {
  readonly mode: "sqlite" | "memory-fallback";
  issuePairing(now?: number): PairingTicket;
  cancelPairing(secret: string): boolean;
  claimPairing(secret: string, name: string, now?: number): DeviceEnrollment | undefined;
  authenticate(token: string, now?: number, requiredScope?: DeviceScope): DeviceInfo | undefined;
  list(): DeviceInfo[];
  rename(id: string, name: string): DeviceInfo | undefined;
  revoke(id: string): boolean;
  revokeAll(): number;
  close(): void;
}

export interface OpenDeviceStoreOptions {
  dbPath: string;
  generateSecret?: () => string;
  generateToken?: () => string;
  generateId?: () => string;
  loadDatabase?: () => typeof import("better-sqlite3");
}

interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  scopes_json: string;
}

interface PairingRow {
  secret_hash: string;
  expires_at: number;
  scopes_json: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function randomCredential(prefix: "rcp" | "rcd"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** Keep device labels useful in UI while refusing control characters and unbounded payloads. */
export function normalizeDeviceName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80 || UNSAFE_DISPLAY_TEXT.test(normalized)) return undefined;
  return normalized;
}

export function normalizeDeviceScopes(value: unknown): DeviceScope[] | undefined {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== "direct") return undefined;
  return ["direct"];
}

function hasDirectScope(value: string): boolean {
  try {
    return normalizeDeviceScopes(JSON.parse(value)) !== undefined;
  } catch {
    return false;
  }
}

function rowToDevice(row: DeviceRow): DeviceInfo | undefined {
  if (!hasDirectScope(row.scopes_json)) return undefined;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    scopes: ["direct"],
  };
}

function inMemoryStore(opts: OpenDeviceStoreOptions): DeviceStore {
  const devices = new Map<string, DeviceRow>();
  const tokenToId = new Map<string, string>();
  const pairings = new Map<string, { expiresAt: number }>();
  const generateSecret = opts.generateSecret ?? (() => randomCredential("rcp"));
  const generateToken = opts.generateToken ?? (() => randomCredential("rcd"));
  const generateId = opts.generateId ?? randomUUID;

  const prunePairings = (now: number) => {
    for (const [secretHash, pairing] of pairings) {
      if (pairing.expiresAt < now) pairings.delete(secretHash);
    }
  };

  return {
    mode: "memory-fallback",
    issuePairing(now = Date.now()) {
      prunePairings(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const secret = generateSecret();
        const secretHash = digest(secret);
        if (pairings.has(secretHash)) continue;
        const expiresAt = now + PAIRING_TTL_MS;
        pairings.set(secretHash, { expiresAt });
        return { secret, expiresAt, scopes: ["direct"] };
      }
      throw new Error("could not allocate a unique pairing credential");
    },
    cancelPairing(secret) {
      return pairings.delete(digest(secret));
    },
    claimPairing(secret, rawName, now = Date.now()) {
      const name = normalizeDeviceName(rawName);
      if (!name) return undefined;
      const secretHash = digest(secret);
      const pairing = pairings.get(secretHash);
      if (!pairing || pairing.expiresAt < now) {
        pairings.delete(secretHash);
        return undefined;
      }
      pairings.delete(secretHash);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const token = generateToken();
        const tokenHash = digest(token);
        const id = generateId();
        if (tokenToId.has(tokenHash) || devices.has(id)) continue;
        const row: DeviceRow = {
          id,
          name,
          token_hash: tokenHash,
          created_at: now,
          last_seen_at: now,
          scopes_json: '["direct"]',
        };
        devices.set(id, row);
        tokenToId.set(tokenHash, id);
        return { token, device: rowToDevice(row)! };
      }
      throw new Error("could not allocate a unique device credential");
    },
    authenticate(token, now = Date.now()) {
      const id = tokenToId.get(digest(token));
      const row = id ? devices.get(id) : undefined;
      const device = row ? rowToDevice(row) : undefined;
      if (!row || !device) return undefined;
      if (now - row.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) row.last_seen_at = now;
      return rowToDevice(row);
    },
    list: () =>
      [...devices.values()].flatMap((row) => rowToDevice(row) ?? []).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    rename(id, rawName) {
      const name = normalizeDeviceName(rawName);
      const row = devices.get(id);
      if (!name || !row || !hasDirectScope(row.scopes_json)) return undefined;
      row.name = name;
      return rowToDevice(row);
    },
    revoke(id) {
      const row = devices.get(id);
      if (!row) return false;
      tokenToId.delete(row.token_hash);
      return devices.delete(id);
    },
    revokeAll() {
      const count = devices.size;
      devices.clear();
      tokenToId.clear();
      return count;
    },
    close() {
      devices.clear();
      tokenToId.clear();
      pairings.clear();
    },
  };
}

export function openDeviceStore(opts: OpenDeviceStoreOptions): DeviceStore {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = (opts.loadDatabase?.() ?? require("better-sqlite3")) as {
      default?: typeof import("better-sqlite3");
    };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return inMemoryStore(opts);
  }

  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '["direct"]'
    );
    CREATE TABLE IF NOT EXISTS pairing_sessions (
      secret_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '["direct"]'
    );
    CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS pairing_expiry_idx ON pairing_sessions(expires_at);
  `);
  const deviceColumns = db.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
  if (!deviceColumns.some((column) => column.name === "scopes_json")) {
    db.exec(`ALTER TABLE devices ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["direct"]'`);
  }
  const pairingColumns = db.prepare("PRAGMA table_info(pairing_sessions)").all() as Array<{ name: string }>;
  if (!pairingColumns.some((column) => column.name === "scopes_json")) {
    db.exec(`ALTER TABLE pairing_sessions ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["direct"]'`);
  }
  // Old relay bootstrap rows are intentionally inert after a standalone-only upgrade.
  db.prepare(`DELETE FROM pairing_sessions WHERE scopes_json != '["direct"]'`).run();

  const generateSecret = opts.generateSecret ?? (() => randomCredential("rcp"));
  const generateToken = opts.generateToken ?? (() => randomCredential("rcd"));
  const generateId = opts.generateId ?? randomUUID;
  const prunePairings = db.prepare("DELETE FROM pairing_sessions WHERE expires_at < ?");
  const insertPairing = db.prepare(
    "INSERT INTO pairing_sessions (secret_hash, created_at, expires_at, scopes_json) VALUES (?, ?, ?, ?)",
  );
  const cancelPairing = db.prepare("DELETE FROM pairing_sessions WHERE secret_hash = ?");
  const findPairing = db.prepare(
    "SELECT secret_hash, expires_at, scopes_json FROM pairing_sessions WHERE secret_hash = ?",
  );
  const deletePairing = db.prepare("DELETE FROM pairing_sessions WHERE secret_hash = ?");
  const insertDevice = db.prepare(
    "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, scopes_json) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const findDeviceByToken = db.prepare("SELECT * FROM devices WHERE token_hash = ?");
  const findDeviceById = db.prepare("SELECT * FROM devices WHERE id = ?");
  const listDevices = db.prepare("SELECT * FROM devices ORDER BY last_seen_at DESC, created_at DESC");
  const touchDevice = db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?");
  const renameDevice = db.prepare("UPDATE devices SET name = ? WHERE id = ?");
  const revokeDevice = db.prepare("DELETE FROM devices WHERE id = ?");
  const revokeAllDevices = db.prepare("DELETE FROM devices");

  const claim = db.transaction((secretHash: string, name: string, now: number): DeviceEnrollment | undefined => {
    prunePairings.run(now);
    const pairing = findPairing.get(secretHash) as PairingRow | undefined;
    if (!pairing || pairing.expires_at < now || !hasDirectScope(pairing.scopes_json)) return undefined;
    deletePairing.run(secretHash);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = generateToken();
      const id = generateId();
      try {
        insertDevice.run(id, name, digest(token), now, now, '["direct"]');
        return {
          token,
          device: { id, name, createdAt: now, lastSeenAt: now, scopes: ["direct"] },
        };
      } catch (error) {
        if (
          !String((error as Error).message)
            .toLowerCase()
            .includes("unique")
        )
          throw error;
      }
    }
    throw new Error("could not allocate a unique device credential");
  });

  return {
    mode: "sqlite",
    issuePairing(now = Date.now()) {
      prunePairings.run(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const secret = generateSecret();
        try {
          const expiresAt = now + PAIRING_TTL_MS;
          insertPairing.run(digest(secret), now, expiresAt, '["direct"]');
          return { secret, expiresAt, scopes: ["direct"] };
        } catch (error) {
          if (
            !String((error as Error).message)
              .toLowerCase()
              .includes("unique")
          )
            throw error;
        }
      }
      throw new Error("could not allocate a unique pairing credential");
    },
    cancelPairing: (secret) => cancelPairing.run(digest(secret)).changes > 0,
    claimPairing(secret, rawName, now = Date.now()) {
      const name = normalizeDeviceName(rawName);
      if (!name) return undefined;
      return claim(digest(secret), name, now);
    },
    authenticate(token, now = Date.now()) {
      const row = findDeviceByToken.get(digest(token)) as DeviceRow | undefined;
      const device = row ? rowToDevice(row) : undefined;
      if (!row || !device) return undefined;
      if (now - row.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) {
        touchDevice.run(now, row.id);
        row.last_seen_at = now;
      }
      return rowToDevice(row);
    },
    list: () => (listDevices.all() as DeviceRow[]).flatMap((row) => rowToDevice(row) ?? []),
    rename(id, rawName) {
      const name = normalizeDeviceName(rawName);
      const existing = findDeviceById.get(id) as DeviceRow | undefined;
      if (!name || !existing || !hasDirectScope(existing.scopes_json)) return undefined;
      renameDevice.run(name, id);
      return rowToDevice({ ...existing, name });
    },
    revoke: (id) => revokeDevice.run(id).changes > 0,
    revokeAll: () => revokeAllDevices.run().changes,
    close: () => db.close(),
  };
}
