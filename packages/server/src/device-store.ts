import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { relayIdentityFingerprint } from "./relay-crypto.js";

const require = createRequire(import.meta.url);

/** A pairing link is deliberately short-lived and can be claimed exactly once. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export type DeviceScope = "direct" | "relay";

/** Avoid turning normal API polling into a SQLite write on every request. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  scopes: DeviceScope[];
  /** Pinned E2E relay signing identity. Public material only; the private key never leaves the device. */
  relayIdentityFingerprint?: string;
}

export interface DeviceRelayIdentity {
  publicKey: string;
  fingerprint: string;
}

export class DevicePairingError extends Error {
  constructor(
    readonly code: "INVALID_RELAY_IDENTITY",
    message: string,
  ) {
    super(message);
    this.name = "DevicePairingError";
  }
}

export interface PairingTicket {
  /** One-time capability carried by the pairing URL. Never persisted in plaintext. */
  secret: string;
  expiresAt: number;
  /** Exact product surfaces the resulting device credential can reach. */
  scopes: DeviceScope[];
}

/**
 * Relay bootstrap pre-allocates both durable ids. The token is still inert until the one-use pairing
 * capability is claimed, but carrying it in the URL fragment makes a dropped final response recoverable:
 * the browser can reconnect with the same credential after the host committed the claim.
 */
export interface RelayPairingTicket extends PairingTicket {
  deviceId: string;
  token: string;
}

export interface RelayPairingCancellationReservation {
  deviceId: string;
  reservationId: string;
}

export type RelayPairingCancellationStart =
  { status: "reserved"; reservation: RelayPairingCancellationReservation } | { status: "busy" } | { status: "missing" };

export interface DeviceEnrollment {
  /** The per-device bearer credential. Returned once; only its SHA-256 digest is persisted. */
  token: string;
  device: DeviceInfo;
}

export interface DeviceStore {
  readonly mode: "sqlite" | "memory-fallback";
  issuePairing(now?: number, scopes?: DeviceScope[]): PairingTicket;
  cancelPairing(secret: string): boolean;
  claimPairing(
    secret: string,
    name: string,
    now?: number,
    relayIdentityPublicKey?: string,
  ): DeviceEnrollment | undefined;
  issueRelayPairing(now?: number): RelayPairingTicket;
  pendingRelayPairing(deviceId: string, now?: number): boolean;
  /** Atomically prevents a relay claim from winning while broker revocation is in flight. */
  beginRelayPairingCancellation(deviceId: string, now?: number): RelayPairingCancellationStart;
  /** Release a failed broker-revocation attempt so the same expiry-bounded link can be retried. */
  releaseRelayPairingCancellation(reservation: RelayPairingCancellationReservation): boolean;
  /** Delete the local bootstrap only after broker revocation is authoritative. */
  finishRelayPairingCancellation(reservation: RelayPairingCancellationReservation): boolean;
  cancelRelayPairing(deviceId: string): boolean;
  claimRelayPairing(
    secret: string,
    token: string,
    name: string,
    relayIdentityPublicKey: string,
    now?: number,
  ): DeviceEnrollment | undefined;
  /** Resolve a per-device bearer credential and best-effort touch its last-seen time. */
  authenticate(token: string, now?: number, requiredScope?: DeviceScope): DeviceInfo | undefined;
  relayIdentity(id: string): DeviceRelayIdentity | undefined;
  list(): DeviceInfo[];
  rename(id: string, name: string): DeviceInfo | undefined;
  revoke(id: string): boolean;
  revokeAll(): number;
  close(): void;
}

export interface OpenDeviceStoreOptions {
  /** SQLite file path. ":memory:" uses an in-process DB. */
  dbPath: string;
  generateSecret?: () => string;
  generateToken?: () => string;
  generateId?: () => string;
}

interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  scopes_json: string;
  relay_public_key?: string | null;
  relay_fingerprint?: string | null;
}

interface PairingRow {
  secret_hash: string;
  expires_at: number;
  scopes_json: string;
  device_id?: string | null;
  token_hash?: string | null;
  cancellation_id?: string | null;
}

export function normalizeDeviceScopes(value: unknown): DeviceScope[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const scopes = [...new Set(value)];
  if (scopes.some((scope) => scope !== "direct" && scope !== "relay")) return undefined;
  return scopes as DeviceScope[];
}

function scopesFromJson(value: string): DeviceScope[] {
  try {
    return normalizeDeviceScopes(JSON.parse(value)) ?? ["direct"];
  } catch {
    return ["direct"];
  }
}

function rowToDevice(row: DeviceRow): DeviceInfo {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    scopes: scopesFromJson(row.scopes_json),
    ...(row.relay_fingerprint ? { relayIdentityFingerprint: row.relay_fingerprint } : {}),
  };
}

function relayIdentityForClaim(scopes: DeviceScope[], publicKey: string | undefined): DeviceRelayIdentity | undefined {
  if (!scopes.includes("relay")) return undefined;
  if (typeof publicKey !== "string") {
    throw new DevicePairingError("INVALID_RELAY_IDENTITY", "relay pairing requires a device E2E identity");
  }
  try {
    return { publicKey, fingerprint: relayIdentityFingerprint(publicKey) };
  } catch {
    throw new DevicePairingError("INVALID_RELAY_IDENTITY", "relay identity must be a P-256 public key");
  }
}

function relayIdentityFromRow(row: DeviceRow | undefined): DeviceRelayIdentity | undefined {
  if (!row?.relay_public_key || !row.relay_fingerprint) return undefined;
  return { publicKey: row.relay_public_key, fingerprint: row.relay_fingerprint };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function inMemoryStore(opts: OpenDeviceStoreOptions): DeviceStore {
  const devices = new Map<string, DeviceRow>();
  const tokenToId = new Map<string, string>();
  const pairings = new Map<
    string,
    {
      expiresAt: number;
      scopes: DeviceScope[];
      deviceId?: string;
      tokenHash?: string;
      cancellationId?: string;
    }
  >();
  const generateSecret = opts.generateSecret ?? (() => randomCredential("rcp"));
  const generateToken = opts.generateToken ?? (() => randomCredential("rcd"));
  const generateId = opts.generateId ?? randomUUID;

  const prune = (now: number) => {
    for (const [secretHash, pairing] of pairings) {
      if (pairing.expiresAt < now) pairings.delete(secretHash);
    }
  };

  return {
    mode: "memory-fallback",
    issuePairing(now = Date.now(), rawScopes = ["direct"]) {
      const scopes = normalizeDeviceScopes(rawScopes);
      if (!scopes) throw new Error("invalid device scopes");
      prune(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const secret = generateSecret();
        const secretHash = digest(secret);
        if (pairings.has(secretHash)) continue;
        const expiresAt = now + PAIRING_TTL_MS;
        pairings.set(secretHash, { expiresAt, scopes });
        return { secret, expiresAt, scopes: [...scopes] };
      }
      throw new Error("could not allocate a unique pairing credential");
    },
    cancelPairing: (secret) => pairings.delete(digest(secret)),
    claimPairing(secret, rawName, now = Date.now(), relayIdentityPublicKey) {
      const name = normalizeDeviceName(rawName);
      if (!name) return undefined;
      prune(now);
      const secretHash = digest(secret);
      const pairing = pairings.get(secretHash);
      if (pairing === undefined || pairing.expiresAt < now || pairing.deviceId || pairing.tokenHash) return undefined;
      const relayIdentity = relayIdentityForClaim(pairing.scopes, relayIdentityPublicKey);
      // Delete BEFORE issuing the durable credential: concurrent/repeated claims cannot both win.
      pairings.delete(secretHash);
      const token = generateToken();
      const id = generateId();
      const row: DeviceRow = {
        id,
        name,
        token_hash: digest(token),
        created_at: now,
        last_seen_at: now,
        scopes_json: JSON.stringify(pairing.scopes),
        relay_public_key: relayIdentity?.publicKey,
        relay_fingerprint: relayIdentity?.fingerprint,
      };
      devices.set(id, row);
      tokenToId.set(row.token_hash, id);
      return { token, device: rowToDevice(row) };
    },
    issueRelayPairing(now = Date.now()) {
      prune(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const secret = generateSecret();
        const token = generateToken();
        const deviceId = generateId();
        const secretHash = digest(secret);
        if (
          pairings.has(secretHash) ||
          tokenToId.has(digest(token)) ||
          devices.has(deviceId) ||
          [...pairings.values()].some((pairing) => pairing.deviceId === deviceId || pairing.tokenHash === digest(token))
        )
          continue;
        const expiresAt = now + PAIRING_TTL_MS;
        pairings.set(secretHash, {
          expiresAt,
          scopes: ["relay"],
          deviceId,
          tokenHash: digest(token),
        });
        return { secret, expiresAt, scopes: ["relay"], deviceId, token };
      }
      throw new Error("could not allocate a unique relay pairing credential");
    },
    pendingRelayPairing(deviceId, now = Date.now()) {
      prune(now);
      return [...pairings.values()].some((pairing) => pairing.deviceId === deviceId && pairing.expiresAt >= now);
    },
    beginRelayPairingCancellation(deviceId, now = Date.now()) {
      prune(now);
      const pairing = [...pairings.values()].find((candidate) => candidate.deviceId === deviceId);
      if (!pairing || pairing.expiresAt < now) return { status: "missing" };
      if (pairing.cancellationId) return { status: "busy" };
      const reservation = { deviceId, reservationId: randomUUID() };
      pairing.cancellationId = reservation.reservationId;
      return { status: "reserved", reservation };
    },
    releaseRelayPairingCancellation(reservation) {
      const pairing = [...pairings.values()].find((candidate) => candidate.deviceId === reservation.deviceId);
      if (pairing?.cancellationId !== reservation.reservationId) return false;
      delete pairing.cancellationId;
      return true;
    },
    finishRelayPairingCancellation(reservation) {
      for (const [secretHash, pairing] of pairings) {
        if (pairing.deviceId === reservation.deviceId && pairing.cancellationId === reservation.reservationId) {
          pairings.delete(secretHash);
          return true;
        }
      }
      return false;
    },
    cancelRelayPairing(deviceId) {
      for (const [secretHash, pairing] of pairings) {
        if (pairing.deviceId === deviceId) {
          pairings.delete(secretHash);
          return true;
        }
      }
      return false;
    },
    claimRelayPairing(secret, token, rawName, relayIdentityPublicKey, now = Date.now()) {
      const name = normalizeDeviceName(rawName);
      if (!name || !/^rcd_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      prune(now);
      const secretHash = digest(secret);
      const pairing = pairings.get(secretHash);
      if (
        !pairing?.deviceId ||
        !pairing.tokenHash ||
        pairing.cancellationId ||
        pairing.expiresAt < now ||
        pairing.tokenHash !== digest(token)
      )
        return undefined;
      const relayIdentity = relayIdentityForClaim(pairing.scopes, relayIdentityPublicKey);
      pairings.delete(secretHash);
      const row: DeviceRow = {
        id: pairing.deviceId,
        name,
        token_hash: pairing.tokenHash,
        created_at: now,
        last_seen_at: now,
        scopes_json: JSON.stringify(pairing.scopes),
        relay_public_key: relayIdentity?.publicKey,
        relay_fingerprint: relayIdentity?.fingerprint,
      };
      devices.set(row.id, row);
      tokenToId.set(row.token_hash, row.id);
      return { token, device: rowToDevice(row) };
    },
    authenticate(token, now = Date.now(), requiredScope = "direct") {
      const id = tokenToId.get(digest(token));
      if (!id) return undefined;
      const row = devices.get(id);
      if (!row) return undefined;
      if (!scopesFromJson(row.scopes_json).includes(requiredScope)) return undefined;
      if (now - row.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) row.last_seen_at = now;
      return rowToDevice(row);
    },
    relayIdentity: (id) => relayIdentityFromRow(devices.get(id)),
    list: () => [...devices.values()].sort((a, b) => b.last_seen_at - a.last_seen_at).map(rowToDevice),
    rename(id, rawName) {
      const name = normalizeDeviceName(rawName);
      const row = devices.get(id);
      if (!name || !row) return undefined;
      row.name = name;
      return rowToDevice(row);
    },
    revoke(id) {
      const row = devices.get(id);
      if (!row) return false;
      tokenToId.delete(row.token_hash);
      devices.delete(id);
      return true;
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
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return inMemoryStore(opts);
  }

  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  // `roamcode pair` deliberately writes through a short-lived second connection while the service is
  // running. Wait through a brief writer overlap instead of failing a perfectly valid pairing attempt.
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '["direct"]',
      relay_public_key TEXT,
      relay_fingerprint TEXT
    );
    CREATE TABLE IF NOT EXISTS pairing_sessions (
      secret_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '["direct"]',
      device_id TEXT,
      token_hash TEXT,
      cancellation_id TEXT
    );
    CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS pairing_expiry_idx ON pairing_sessions(expires_at);
  `);
  const deviceColumns = db.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
  if (!deviceColumns.some((column) => column.name === "scopes_json")) {
    db.exec(`ALTER TABLE devices ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["direct"]'`);
  }
  if (!deviceColumns.some((column) => column.name === "relay_public_key")) {
    db.exec("ALTER TABLE devices ADD COLUMN relay_public_key TEXT");
  }
  if (!deviceColumns.some((column) => column.name === "relay_fingerprint")) {
    db.exec("ALTER TABLE devices ADD COLUMN relay_fingerprint TEXT");
  }
  const pairingColumns = db.prepare("PRAGMA table_info(pairing_sessions)").all() as Array<{ name: string }>;
  if (!pairingColumns.some((column) => column.name === "scopes_json")) {
    db.exec(`ALTER TABLE pairing_sessions ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["direct"]'`);
  }
  if (!pairingColumns.some((column) => column.name === "device_id")) {
    db.exec("ALTER TABLE pairing_sessions ADD COLUMN device_id TEXT");
  }
  if (!pairingColumns.some((column) => column.name === "token_hash")) {
    db.exec("ALTER TABLE pairing_sessions ADD COLUMN token_hash TEXT");
  }
  if (!pairingColumns.some((column) => column.name === "cancellation_id")) {
    db.exec("ALTER TABLE pairing_sessions ADD COLUMN cancellation_id TEXT");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS pairing_device_id_idx ON pairing_sessions(device_id) WHERE device_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS pairing_token_hash_idx ON pairing_sessions(token_hash) WHERE token_hash IS NOT NULL;
  `);

  const generateSecret = opts.generateSecret ?? (() => randomCredential("rcp"));
  const generateToken = opts.generateToken ?? (() => randomCredential("rcd"));
  const generateId = opts.generateId ?? randomUUID;
  const insertPairing = db.prepare(
    "INSERT INTO pairing_sessions (secret_hash, created_at, expires_at, scopes_json) VALUES (?, ?, ?, ?)",
  );
  const insertRelayPairing = db.prepare(
    "INSERT INTO pairing_sessions (secret_hash, created_at, expires_at, scopes_json, device_id, token_hash) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const prunePairings = db.prepare("DELETE FROM pairing_sessions WHERE expires_at < ?");
  const cancelPairing = db.prepare("DELETE FROM pairing_sessions WHERE secret_hash = ?");
  const findPairing = db.prepare(
    "SELECT secret_hash, expires_at, scopes_json, device_id, token_hash, cancellation_id FROM pairing_sessions WHERE secret_hash = ?",
  );
  const findPendingRelayPairing = db.prepare(
    "SELECT 1 FROM pairing_sessions WHERE device_id = ? AND expires_at >= ? LIMIT 1",
  );
  const cancelRelayPairing = db.prepare("DELETE FROM pairing_sessions WHERE device_id = ?");
  const findRelayPairingByDevice = db.prepare(
    "SELECT secret_hash, expires_at, scopes_json, device_id, token_hash, cancellation_id FROM pairing_sessions WHERE device_id = ?",
  );
  const reserveRelayPairingCancellation = db.prepare(
    "UPDATE pairing_sessions SET cancellation_id = ? WHERE device_id = ? AND cancellation_id IS NULL",
  );
  const releaseRelayPairingCancellation = db.prepare(
    "UPDATE pairing_sessions SET cancellation_id = NULL WHERE device_id = ? AND cancellation_id = ?",
  );
  const finishRelayPairingCancellation = db.prepare(
    "DELETE FROM pairing_sessions WHERE device_id = ? AND cancellation_id = ?",
  );
  const deletePairing = db.prepare("DELETE FROM pairing_sessions WHERE secret_hash = ?");
  const insertDevice = db.prepare(
    "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, scopes_json, relay_public_key, relay_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const findDeviceByToken = db.prepare("SELECT * FROM devices WHERE token_hash = ?");
  const findDeviceById = db.prepare("SELECT * FROM devices WHERE id = ?");
  const listDevices = db.prepare("SELECT * FROM devices ORDER BY last_seen_at DESC, created_at DESC");
  const touchDevice = db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?");
  const renameDevice = db.prepare("UPDATE devices SET name = ? WHERE id = ?");
  const revokeDevice = db.prepare("DELETE FROM devices WHERE id = ?");
  const revokeAllDevices = db.prepare("DELETE FROM devices");

  const claim = db.transaction(
    (
      secretHash: string,
      name: string,
      now: number,
      token: string,
      id: string,
      relayIdentityPublicKey: string | undefined,
    ): DeviceEnrollment | undefined => {
      prunePairings.run(now);
      const pairing = findPairing.get(secretHash) as PairingRow | undefined;
      if (!pairing || pairing.expires_at < now || pairing.device_id || pairing.token_hash) return undefined;
      const scopes = scopesFromJson(pairing.scopes_json);
      const relayIdentity = relayIdentityForClaim(scopes, relayIdentityPublicKey);
      deletePairing.run(secretHash);
      insertDevice.run(
        id,
        name,
        digest(token),
        now,
        now,
        pairing.scopes_json,
        relayIdentity?.publicKey ?? null,
        relayIdentity?.fingerprint ?? null,
      );
      return {
        token,
        device: {
          id,
          name,
          createdAt: now,
          lastSeenAt: now,
          scopes,
          ...(relayIdentity ? { relayIdentityFingerprint: relayIdentity.fingerprint } : {}),
        },
      };
    },
  );

  const claimRelay = db.transaction(
    (
      secretHash: string,
      token: string,
      name: string,
      now: number,
      relayIdentityPublicKey: string,
    ): DeviceEnrollment | undefined => {
      prunePairings.run(now);
      const pairing = findPairing.get(secretHash) as PairingRow | undefined;
      if (
        !pairing?.device_id ||
        !pairing.token_hash ||
        pairing.cancellation_id ||
        pairing.expires_at < now ||
        pairing.token_hash !== digest(token)
      )
        return undefined;
      const scopes = scopesFromJson(pairing.scopes_json);
      const relayIdentity = relayIdentityForClaim(scopes, relayIdentityPublicKey);
      deletePairing.run(secretHash);
      insertDevice.run(
        pairing.device_id,
        name,
        pairing.token_hash,
        now,
        now,
        pairing.scopes_json,
        relayIdentity?.publicKey ?? null,
        relayIdentity?.fingerprint ?? null,
      );
      return {
        token,
        device: {
          id: pairing.device_id,
          name,
          createdAt: now,
          lastSeenAt: now,
          scopes,
          ...(relayIdentity ? { relayIdentityFingerprint: relayIdentity.fingerprint } : {}),
        },
      };
    },
  );

  return {
    mode: "sqlite",
    issuePairing(now = Date.now(), rawScopes = ["direct"]) {
      const scopes = normalizeDeviceScopes(rawScopes);
      if (!scopes) throw new Error("invalid device scopes");
      prunePairings.run(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const secret = generateSecret();
        try {
          const expiresAt = now + PAIRING_TTL_MS;
          insertPairing.run(digest(secret), now, expiresAt, JSON.stringify(scopes));
          return { secret, expiresAt, scopes: [...scopes] };
        } catch (error) {
          // Only a generator collision is retryable. A real SQLite failure should stay loud.
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
    claimPairing(secret, rawName, now = Date.now(), relayIdentityPublicKey) {
      const name = normalizeDeviceName(rawName);
      if (!name) return undefined;
      return claim(digest(secret), name, now, generateToken(), generateId(), relayIdentityPublicKey);
    },
    issueRelayPairing(now = Date.now()) {
      prunePairings.run(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const secret = generateSecret();
        const token = generateToken();
        const deviceId = generateId();
        const expiresAt = now + PAIRING_TTL_MS;
        try {
          insertRelayPairing.run(
            digest(secret),
            now,
            expiresAt,
            JSON.stringify(["relay"] satisfies DeviceScope[]),
            deviceId,
            digest(token),
          );
          return { secret, expiresAt, scopes: ["relay"], deviceId, token };
        } catch (error) {
          if (
            !String((error as Error).message)
              .toLowerCase()
              .includes("unique")
          )
            throw error;
        }
      }
      throw new Error("could not allocate a unique relay pairing credential");
    },
    pendingRelayPairing(deviceId, now = Date.now()) {
      prunePairings.run(now);
      return findPendingRelayPairing.get(deviceId, now) !== undefined;
    },
    beginRelayPairingCancellation(deviceId, now = Date.now()) {
      prunePairings.run(now);
      const pairing = findRelayPairingByDevice.get(deviceId) as PairingRow | undefined;
      if (!pairing || pairing.expires_at < now) return { status: "missing" };
      if (pairing.cancellation_id) return { status: "busy" };
      const reservation = { deviceId, reservationId: randomUUID() };
      if (reserveRelayPairingCancellation.run(reservation.reservationId, deviceId).changes !== 1) {
        return findRelayPairingByDevice.get(deviceId) ? { status: "busy" } : { status: "missing" };
      }
      return { status: "reserved", reservation };
    },
    releaseRelayPairingCancellation: (reservation) =>
      releaseRelayPairingCancellation.run(reservation.deviceId, reservation.reservationId).changes === 1,
    finishRelayPairingCancellation: (reservation) =>
      finishRelayPairingCancellation.run(reservation.deviceId, reservation.reservationId).changes === 1,
    cancelRelayPairing: (deviceId) => cancelRelayPairing.run(deviceId).changes > 0,
    claimRelayPairing(secret, token, rawName, relayIdentityPublicKey, now = Date.now()) {
      const name = normalizeDeviceName(rawName);
      if (!name || !/^rcd_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      return claimRelay(digest(secret), token, name, now, relayIdentityPublicKey);
    },
    authenticate(token, now = Date.now(), requiredScope = "direct") {
      const row = findDeviceByToken.get(digest(token)) as DeviceRow | undefined;
      if (!row) return undefined;
      if (!scopesFromJson(row.scopes_json).includes(requiredScope)) return undefined;
      if (now - row.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) {
        touchDevice.run(now, row.id);
        row.last_seen_at = now;
      }
      return rowToDevice(row);
    },
    relayIdentity: (id) => relayIdentityFromRow(findDeviceById.get(id) as DeviceRow | undefined),
    list: () => (listDevices.all() as DeviceRow[]).map(rowToDevice),
    rename(id, rawName) {
      const name = normalizeDeviceName(rawName);
      if (!name || renameDevice.run(name, id).changes === 0) return undefined;
      const row = findDeviceById.get(id) as DeviceRow;
      return rowToDevice(row);
    },
    revoke: (id) => revokeDevice.run(id).changes > 0,
    revokeAll: () => revokeAllDevices.run().changes,
    close: () => db.close(),
  };
}
