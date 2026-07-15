import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type RelayStoreMode = "sqlite" | "memory";

export interface RelayRouteRecord {
  id: string;
  label: string;
  hostCredentialHash: string;
  ownerAccountId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RelayDeviceRouteRecord {
  routeId: string;
  deviceId: string;
  credentialHash: string;
  createdAt: number;
  updatedAt: number;
  /** Bootstrap credentials expire unless the host promotes the device after the E2E pairing claim. */
  expiresAt?: number;
}

export interface PublicRelayRouteRecord {
  id: string;
  label: string;
  deviceCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RelayRouteStore {
  readonly mode: RelayStoreMode;
  createRoute(
    input: { id?: string; label: string; hostCredentialHash: string; ownerAccountId?: string },
    now?: number,
  ): RelayRouteRecord;
  getRoute(id: string): RelayRouteRecord | undefined;
  listRoutes(now?: number): PublicRelayRouteRecord[];
  listRoutesByOwner(ownerAccountId: string, now?: number): PublicRelayRouteRecord[];
  countDevices(routeId: string, now?: number): number;
  rotateHostCredential(routeId: string, credentialHash: string, now?: number): boolean;
  deleteRoute(id: string): boolean;
  authenticateHost(routeId: string, credential: string): boolean;
  putDevice(
    input: { routeId: string; deviceId: string; credentialHash: string; expiresAt?: number },
    now?: number,
  ): RelayDeviceRouteRecord;
  getDevice(routeId: string, deviceId: string, now?: number): RelayDeviceRouteRecord | undefined;
  authenticateDevice(routeId: string, deviceId: string, credential: string, now?: number): boolean;
  revokeDevice(routeId: string, deviceId: string): boolean;
  close(): void;
}

export interface OpenRelayRouteStoreOptions {
  dbPath: string;
  generateRouteId?: () => string;
  loadDatabase?: () => typeof import("better-sqlite3");
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`invalid relay ${field}`);
  return value;
}

function safeOwnerAccountId(value: unknown): string {
  if (typeof value !== "string" || !/^rra_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new Error("invalid relay route owner");
  }
  return value;
}

function safeLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("relay route label is required");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new Error("invalid relay route label");
  }
  return normalized;
}

function safeCredential(value: unknown): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid relay credential");
  }
  return value;
}

export function relayCredentialHash(credential: string): string {
  return `sha256:${createHash("sha256")
    .update("roamcode-relay-credential-v1\0")
    .update(safeCredential(credential))
    .digest("base64url")}`;
}

export function generateRelayCredential(prefix: "rrh" | "rrd" | "rrp" = "rrd"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function safeCredentialHash(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("invalid relay credential hash");
  }
  return value;
}

function safeExpiry(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("invalid relay device expiry");
  return value as number;
}

function hashMatches(expected: string, credential: string): boolean {
  try {
    const actual = relayCredentialHash(credential);
    const left = Buffer.from(safeCredentialHash(expected));
    const right = Buffer.from(actual);
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function cloneRoute(route: RelayRouteRecord): RelayRouteRecord {
  return { ...route };
}

function cloneDevice(device: RelayDeviceRouteRecord): RelayDeviceRouteRecord {
  return { ...device };
}

function createMemoryStore(options: OpenRelayRouteStoreOptions): RelayRouteStore {
  const routes = new Map<string, RelayRouteRecord>();
  const devices = new Map<string, RelayDeviceRouteRecord>();
  const generateRouteId = options.generateRouteId ?? (() => `rrt_${randomBytes(16).toString("base64url")}`);
  const deviceKey = (routeId: string, deviceId: string) => `${routeId}\0${deviceId}`;
  const listRoutes = (now: number, ownerAccountId?: string): PublicRelayRouteRecord[] =>
    [...routes.values()]
      .filter((route) => ownerAccountId === undefined || route.ownerAccountId === ownerAccountId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((route) => ({
        id: route.id,
        label: route.label,
        deviceCount: [...devices.values()].filter(
          (device) => device.routeId === route.id && (device.expiresAt === undefined || device.expiresAt >= now),
        ).length,
        createdAt: route.createdAt,
        updatedAt: route.updatedAt,
      }));
  return {
    mode: "memory",
    createRoute(input, now = Date.now()) {
      const id = safeId(input.id ?? generateRouteId(), "route id");
      if (routes.has(id)) throw new Error("relay route already exists");
      const route: RelayRouteRecord = {
        id,
        label: safeLabel(input.label),
        hostCredentialHash: safeCredentialHash(input.hostCredentialHash),
        ...(input.ownerAccountId === undefined ? {} : { ownerAccountId: safeOwnerAccountId(input.ownerAccountId) }),
        createdAt: now,
        updatedAt: now,
      };
      routes.set(id, route);
      return cloneRoute(route);
    },
    getRoute(id) {
      const route = routes.get(safeId(id, "route id"));
      return route ? cloneRoute(route) : undefined;
    },
    listRoutes: (now = Date.now()) => listRoutes(now),
    listRoutesByOwner(ownerAccountId, now = Date.now()) {
      return listRoutes(now, safeOwnerAccountId(ownerAccountId));
    },
    countDevices(routeId, now = Date.now()) {
      const safeRouteId = safeId(routeId, "route id");
      return [...devices.values()].filter(
        (device) => device.routeId === safeRouteId && (device.expiresAt === undefined || device.expiresAt >= now),
      ).length;
    },
    rotateHostCredential(routeId, credentialHash, now = Date.now()) {
      const route = routes.get(safeId(routeId, "route id"));
      if (!route) return false;
      route.hostCredentialHash = safeCredentialHash(credentialHash);
      route.updatedAt = now;
      return true;
    },
    deleteRoute(id) {
      const safeRouteId = safeId(id, "route id");
      if (!routes.delete(safeRouteId)) return false;
      for (const [key, device] of devices) if (device.routeId === safeRouteId) devices.delete(key);
      return true;
    },
    authenticateHost(routeId, credential) {
      const route = routes.get(safeId(routeId, "route id"));
      return !!route && hashMatches(route.hostCredentialHash, credential);
    },
    putDevice(input, now = Date.now()) {
      const routeId = safeId(input.routeId, "route id");
      if (!routes.has(routeId)) throw new Error("relay route not found");
      const deviceId = safeId(input.deviceId, "device id");
      const key = deviceKey(routeId, deviceId);
      const current = devices.get(key);
      const device: RelayDeviceRouteRecord = {
        routeId,
        deviceId,
        credentialHash: safeCredentialHash(input.credentialHash),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        ...(input.expiresAt === undefined ? {} : { expiresAt: safeExpiry(input.expiresAt) }),
      };
      devices.set(key, device);
      const route = routes.get(routeId)!;
      route.updatedAt = now;
      return cloneDevice(device);
    },
    getDevice(routeId, deviceId, now = Date.now()) {
      const device = devices.get(deviceKey(safeId(routeId, "route id"), safeId(deviceId, "device id")));
      return device && (device.expiresAt === undefined || device.expiresAt >= now) ? cloneDevice(device) : undefined;
    },
    authenticateDevice(routeId, deviceId, credential, now = Date.now()) {
      const device = devices.get(deviceKey(safeId(routeId, "route id"), safeId(deviceId, "device id")));
      return (
        !!device &&
        (device.expiresAt === undefined || device.expiresAt >= now) &&
        hashMatches(device.credentialHash, credential)
      );
    },
    revokeDevice(routeId, deviceId) {
      const safeRouteId = safeId(routeId, "route id");
      const removed = devices.delete(deviceKey(safeRouteId, safeId(deviceId, "device id")));
      if (removed) routes.get(safeRouteId)!.updatedAt = Date.now();
      return removed;
    },
    close() {
      routes.clear();
      devices.clear();
    },
  };
}

interface RouteRow {
  id: string;
  label: string;
  host_credential_hash: string;
  owner_account_id: string | null;
  created_at: number;
  updated_at: number;
}

interface DeviceRow {
  route_id: string;
  device_id: string;
  credential_hash: string;
  created_at: number;
  updated_at: number;
  expires_at?: number | null;
}

function routeFromRow(row: RouteRow): RelayRouteRecord {
  return {
    id: row.id,
    label: row.label,
    hostCredentialHash: row.host_credential_hash,
    ...(row.owner_account_id === null ? {} : { ownerAccountId: row.owner_account_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deviceFromRow(row: DeviceRow): RelayDeviceRouteRecord {
  return {
    routeId: row.route_id,
    deviceId: row.device_id,
    credentialHash: row.credential_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at === null || row.expires_at === undefined ? {} : { expiresAt: row.expires_at }),
  };
}

export function openRelayRouteStore(options: OpenRelayRouteStoreOptions): RelayRouteStore {
  let Database: typeof import("better-sqlite3");
  try {
    if (options.loadDatabase) Database = options.loadDatabase();
    else {
      const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
      Database = (mod.default ?? mod) as typeof import("better-sqlite3");
    }
  } catch {
    return createMemoryStore(options);
  }
  const db = new Database(options.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_routes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      host_credential_hash TEXT NOT NULL,
      owner_account_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relay_route_devices (
      route_id TEXT NOT NULL REFERENCES relay_routes(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY(route_id, device_id)
    );
  `);
  const relayDeviceColumns = db.prepare("PRAGMA table_info(relay_route_devices)").all() as Array<{ name: string }>;
  if (!relayDeviceColumns.some((column) => column.name === "expires_at")) {
    db.exec("ALTER TABLE relay_route_devices ADD COLUMN expires_at INTEGER");
  }
  const relayRouteColumns = db.prepare("PRAGMA table_info(relay_routes)").all() as Array<{ name: string }>;
  if (!relayRouteColumns.some((column) => column.name === "owner_account_id")) {
    db.exec("ALTER TABLE relay_routes ADD COLUMN owner_account_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS relay_routes_owner_idx ON relay_routes(owner_account_id)");
  const generateRouteId = options.generateRouteId ?? (() => `rrt_${randomBytes(16).toString("base64url")}`);
  const getRoute = (id: string) =>
    db.prepare("SELECT * FROM relay_routes WHERE id = ?").get(id) as RouteRow | undefined;
  const getDevice = (routeId: string, deviceId: string) =>
    db.prepare("SELECT * FROM relay_route_devices WHERE route_id = ? AND device_id = ?").get(routeId, deviceId) as
      DeviceRow | undefined;
  const createRoute = db.transaction(
    (
      input: { id?: string; label: string; hostCredentialHash: string; ownerAccountId?: string },
      now: number,
    ): RelayRouteRecord => {
      const id = safeId(input.id ?? generateRouteId(), "route id");
      if (getRoute(id)) throw new Error("relay route already exists");
      const route: RelayRouteRecord = {
        id,
        label: safeLabel(input.label),
        hostCredentialHash: safeCredentialHash(input.hostCredentialHash),
        ...(input.ownerAccountId === undefined ? {} : { ownerAccountId: safeOwnerAccountId(input.ownerAccountId) }),
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        `INSERT INTO relay_routes
         (id, label, host_credential_hash, owner_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        route.id,
        route.label,
        route.hostCredentialHash,
        route.ownerAccountId ?? null,
        route.createdAt,
        route.updatedAt,
      );
      return route;
    },
  );
  const putDevice = db.transaction(
    (
      input: { routeId: string; deviceId: string; credentialHash: string; expiresAt?: number },
      now: number,
    ): RelayDeviceRouteRecord => {
      const routeId = safeId(input.routeId, "route id");
      if (!getRoute(routeId)) throw new Error("relay route not found");
      const deviceId = safeId(input.deviceId, "device id");
      const current = getDevice(routeId, deviceId);
      const device: RelayDeviceRouteRecord = {
        routeId,
        deviceId,
        credentialHash: safeCredentialHash(input.credentialHash),
        createdAt: current?.created_at ?? now,
        updatedAt: now,
        ...(input.expiresAt === undefined ? {} : { expiresAt: safeExpiry(input.expiresAt) }),
      };
      db.prepare(
        `INSERT INTO relay_route_devices (route_id, device_id, credential_hash, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(route_id, device_id) DO UPDATE SET credential_hash = excluded.credential_hash,
           updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
      ).run(
        device.routeId,
        device.deviceId,
        device.credentialHash,
        device.createdAt,
        device.updatedAt,
        device.expiresAt ?? null,
      );
      db.prepare("UPDATE relay_routes SET updated_at = ? WHERE id = ?").run(now, routeId);
      return device;
    },
  );
  const listRoutes = (now: number, ownerAccountId?: string): PublicRelayRouteRecord[] =>
    (
      db
        .prepare(
          `SELECT r.id, r.label, r.created_at, r.updated_at, COUNT(d.device_id) AS device_count
           FROM relay_routes r LEFT JOIN relay_route_devices d ON d.route_id = r.id
             AND (d.expires_at IS NULL OR d.expires_at >= ?)
           ${ownerAccountId === undefined ? "" : "WHERE r.owner_account_id = ?"}
           GROUP BY r.id ORDER BY r.created_at, r.id`,
        )
        .all(now, ...(ownerAccountId === undefined ? [] : [safeOwnerAccountId(ownerAccountId)])) as Array<
        Omit<RouteRow, "host_credential_hash" | "owner_account_id"> & { device_count: number }
      >
    ).map((row) => ({
      id: row.id,
      label: row.label,
      deviceCount: row.device_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  return {
    mode: "sqlite",
    createRoute: (input, now = Date.now()) => cloneRoute(createRoute(input, now)),
    getRoute(id) {
      const row = getRoute(safeId(id, "route id"));
      return row ? routeFromRow(row) : undefined;
    },
    listRoutes: (now = Date.now()) => listRoutes(now),
    listRoutesByOwner: (ownerAccountId, now = Date.now()) => listRoutes(now, ownerAccountId),
    countDevices(routeId, now = Date.now()) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM relay_route_devices
           WHERE route_id = ? AND (expires_at IS NULL OR expires_at >= ?)`,
        )
        .get(safeId(routeId, "route id"), now) as { count: number };
      return row.count;
    },
    rotateHostCredential(routeId, credentialHash, now = Date.now()) {
      return (
        db
          .prepare("UPDATE relay_routes SET host_credential_hash = ?, updated_at = ? WHERE id = ?")
          .run(safeCredentialHash(credentialHash), now, safeId(routeId, "route id")).changes > 0
      );
    },
    deleteRoute(id) {
      return db.prepare("DELETE FROM relay_routes WHERE id = ?").run(safeId(id, "route id")).changes > 0;
    },
    authenticateHost(routeId, credential) {
      const row = getRoute(safeId(routeId, "route id"));
      return !!row && hashMatches(row.host_credential_hash, credential);
    },
    putDevice: (input, now = Date.now()) => cloneDevice(putDevice(input, now)),
    getDevice(routeId, deviceId, now = Date.now()) {
      const row = getDevice(safeId(routeId, "route id"), safeId(deviceId, "device id"));
      return row && (row.expires_at === null || row.expires_at === undefined || row.expires_at >= now)
        ? deviceFromRow(row)
        : undefined;
    },
    authenticateDevice(routeId, deviceId, credential, now = Date.now()) {
      const row = getDevice(safeId(routeId, "route id"), safeId(deviceId, "device id"));
      return (
        !!row &&
        (row.expires_at === null || row.expires_at === undefined || row.expires_at >= now) &&
        hashMatches(row.credential_hash, credential)
      );
    },
    revokeDevice(routeId, deviceId) {
      const safeRouteId = safeId(routeId, "route id");
      const result = db
        .prepare("DELETE FROM relay_route_devices WHERE route_id = ? AND device_id = ?")
        .run(safeRouteId, safeId(deviceId, "device id"));
      if (result.changes > 0)
        db.prepare("UPDATE relay_routes SET updated_at = ? WHERE id = ?").run(Date.now(), safeRouteId);
      return result.changes > 0;
    },
    close: () => db.close(),
  };
}
