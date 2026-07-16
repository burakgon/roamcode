import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type PeerStoreMode = "sqlite" | "memory-fallback";
export type PeerAction = "read" | "send" | "wait" | "start" | "focus";
export type PeerStatus = "active" | "suspended";

export interface PeerRecord {
  id: string;
  label: string;
  remoteHostId: string;
  remoteVersion: string;
  actions: PeerAction[];
  allowedWorkspaceIds: string[] | null;
  status: PeerStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt: number;
}

export interface PeerConnection extends PeerRecord {
  baseUrl: string;
  credential: string;
}

export interface CreatePeerInput {
  label: string;
  baseUrl: string;
  credential: string;
  remoteHostId: string;
  remoteVersion: string;
  actions?: PeerAction[];
  allowedWorkspaceIds?: string[] | null;
}

export interface UpdatePeerInput {
  label?: string;
  actions?: PeerAction[];
  allowedWorkspaceIds?: string[] | null;
  status?: PeerStatus;
  remoteVersion?: string;
  lastVerifiedAt?: number;
}

export interface PeerStore {
  readonly mode: PeerStoreMode;
  list(): PeerRecord[];
  get(id: string): PeerRecord | undefined;
  connection(id: string): PeerConnection | undefined;
  create(input: CreatePeerInput, now?: number): PeerRecord;
  update(id: string, input: UpdatePeerInput, expectedRevision: number, now?: number): PeerRecord | undefined;
  rotateCredential(
    id: string,
    input: { credential: string; remoteVersion: string; lastVerifiedAt?: number },
    expectedRevision: number,
    now?: number,
  ): PeerRecord | undefined;
  remove(id: string): boolean;
  close(): void;
}

export interface OpenPeerStoreOptions {
  dbPath: string;
  generatePeerId?: () => string;
  loadDatabase?: () => typeof import("better-sqlite3");
}

export class PeerRevisionConflictError extends Error {
  constructor(readonly current: PeerRecord) {
    super("peer revision conflict");
    this.name = "PeerRevisionConflictError";
  }
}

const ACTION_ORDER: readonly PeerAction[] = ["read", "wait", "send", "start", "focus"];
const ACTIONS = new Set<PeerAction>(ACTION_ORDER);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`invalid ${field}`);
  return value;
}

function safeLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("peer label is required");
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 80 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(label)) throw new Error("invalid peer label");
  return label;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function normalizePeerBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("peer URL is required");
  const url = new URL(value.trim());
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new Error("peer URL must be an HTTPS origin; plain HTTP is allowed only on loopback");
  }
  return url.origin;
}

function safeCredential(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 4_096 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error("invalid peer credential");
  }
  return value;
}

function safeVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("invalid peer version");
  }
  return value;
}

function safeActions(value: unknown): PeerAction[] {
  const actions = value ?? ["read", "wait"];
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > ACTIONS.size)
    throw new Error("invalid peer actions");
  if (actions.some((action) => typeof action !== "string" || !ACTIONS.has(action as PeerAction))) {
    throw new Error("invalid peer actions");
  }
  const unique = new Set(actions as PeerAction[]);
  if (!unique.has("read") && (unique.has("wait") || unique.has("send") || unique.has("start") || unique.has("focus"))) {
    throw new Error("peer wait, send, start, and focus require read access");
  }
  return ACTION_ORDER.filter((action) => unique.has(action));
}

function safeWorkspaceIds(value: unknown): string[] | null {
  if (value === null) return null;
  // New connections are deny-by-default until an administrator discovers and selects remote workspaces.
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000) throw new Error("invalid peer workspace scope");
  const ids = value.map((id) => safeId(id, "peer workspace id"));
  return [...new Set(ids)].sort();
}

function safeStatus(value: unknown): PeerStatus {
  if (value !== "active" && value !== "suspended") throw new Error("invalid peer status");
  return value;
}

function safeTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid ${field}`);
  return value as number;
}

function safeRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("invalid peer revision");
  return value as number;
}

function publicRecord(connection: PeerConnection): PeerRecord {
  return clone({
    id: connection.id,
    label: connection.label,
    remoteHostId: connection.remoteHostId,
    remoteVersion: connection.remoteVersion,
    actions: connection.actions,
    allowedWorkspaceIds: connection.allowedWorkspaceIds,
    status: connection.status,
    revision: connection.revision,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastVerifiedAt: connection.lastVerifiedAt,
  });
}

function normalizeCreate(input: CreatePeerInput, id: string, now: number): PeerConnection {
  return {
    id: safeId(id, "peer id"),
    label: safeLabel(input.label),
    baseUrl: normalizePeerBaseUrl(input.baseUrl),
    credential: safeCredential(input.credential),
    remoteHostId: safeId(input.remoteHostId, "peer host id"),
    remoteVersion: safeVersion(input.remoteVersion),
    actions: safeActions(input.actions),
    allowedWorkspaceIds: safeWorkspaceIds(input.allowedWorkspaceIds),
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
  };
}

function normalizedUpdate(current: PeerConnection, input: UpdatePeerInput, now: number): PeerConnection {
  const allowed = new Set<keyof UpdatePeerInput>([
    "label",
    "actions",
    "allowedWorkspaceIds",
    "status",
    "remoteVersion",
    "lastVerifiedAt",
  ]);
  if (Object.keys(input).length === 0 || Object.keys(input).some((key) => !allowed.has(key as keyof UpdatePeerInput))) {
    throw new Error("invalid peer update");
  }
  return {
    ...current,
    ...(input.label === undefined ? {} : { label: safeLabel(input.label) }),
    ...(input.actions === undefined ? {} : { actions: safeActions(input.actions) }),
    ...(input.allowedWorkspaceIds === undefined
      ? {}
      : { allowedWorkspaceIds: safeWorkspaceIds(input.allowedWorkspaceIds) }),
    ...(input.status === undefined ? {} : { status: safeStatus(input.status) }),
    ...(input.remoteVersion === undefined ? {} : { remoteVersion: safeVersion(input.remoteVersion) }),
    ...(input.lastVerifiedAt === undefined
      ? {}
      : { lastVerifiedAt: safeTimestamp(input.lastVerifiedAt, "peer verification timestamp") }),
    revision: current.revision + 1,
    updatedAt: now,
  };
}

function createMemoryStore(options: OpenPeerStoreOptions): PeerStore {
  const peers = new Map<string, PeerConnection>();
  const generatePeerId = options.generatePeerId ?? (() => `rce_${randomBytes(18).toString("base64url")}`);
  const duplicate = (candidate: PeerConnection, ignoreId?: string) =>
    [...peers.values()].some(
      (peer) =>
        peer.id !== ignoreId && (peer.baseUrl === candidate.baseUrl || peer.remoteHostId === candidate.remoteHostId),
    );
  return {
    mode: "memory-fallback",
    list: () =>
      [...peers.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(publicRecord),
    get(id) {
      const peer = peers.get(safeId(id, "peer id"));
      return peer ? publicRecord(peer) : undefined;
    },
    connection(id) {
      const peer = peers.get(safeId(id, "peer id"));
      return peer ? clone(peer) : undefined;
    },
    create(input, now = Date.now()) {
      const peer = normalizeCreate(input, generatePeerId(), now);
      if (peers.has(peer.id) || duplicate(peer)) throw new Error("peer already exists");
      peers.set(peer.id, peer);
      return publicRecord(peer);
    },
    update(id, input, expectedRevision, now = Date.now()) {
      const safePeerId = safeId(id, "peer id");
      const revision = safeRevision(expectedRevision);
      const current = peers.get(safePeerId);
      if (!current) return undefined;
      if (current.revision !== revision) throw new PeerRevisionConflictError(publicRecord(current));
      const next = normalizedUpdate(current, input, now);
      if (duplicate(next, safePeerId)) throw new Error("peer already exists");
      peers.set(safePeerId, next);
      return publicRecord(next);
    },
    rotateCredential(id, input, expectedRevision, now = Date.now()) {
      const safePeerId = safeId(id, "peer id");
      const revision = safeRevision(expectedRevision);
      const current = peers.get(safePeerId);
      if (!current) return undefined;
      if (current.revision !== revision) throw new PeerRevisionConflictError(publicRecord(current));
      const next: PeerConnection = {
        ...current,
        credential: safeCredential(input.credential),
        remoteVersion: safeVersion(input.remoteVersion),
        lastVerifiedAt: safeTimestamp(input.lastVerifiedAt ?? now, "peer verification timestamp"),
        revision: current.revision + 1,
        updatedAt: now,
      };
      peers.set(safePeerId, next);
      return publicRecord(next);
    },
    remove(id) {
      return peers.delete(safeId(id, "peer id"));
    },
    close() {
      peers.clear();
    },
  };
}

interface PeerRow {
  id: string;
  label: string;
  base_url: string;
  credential: string;
  remote_host_id: string;
  remote_version: string;
  actions_json: string;
  allowed_workspace_ids_json: string | null;
  status: PeerStatus;
  revision: number;
  created_at: number;
  updated_at: number;
  last_verified_at: number;
}

function fromRow(row: PeerRow): PeerConnection {
  return {
    id: safeId(row.id, "peer id"),
    label: safeLabel(row.label),
    baseUrl: normalizePeerBaseUrl(row.base_url),
    credential: safeCredential(row.credential),
    remoteHostId: safeId(row.remote_host_id, "peer host id"),
    remoteVersion: safeVersion(row.remote_version),
    actions: safeActions(JSON.parse(row.actions_json) as unknown),
    allowedWorkspaceIds:
      row.allowed_workspace_ids_json === null
        ? null
        : safeWorkspaceIds(JSON.parse(row.allowed_workspace_ids_json) as unknown),
    status: safeStatus(row.status),
    revision: safeRevision(row.revision),
    createdAt: safeTimestamp(row.created_at, "peer creation timestamp"),
    updatedAt: safeTimestamp(row.updated_at, "peer update timestamp"),
    lastVerifiedAt: safeTimestamp(row.last_verified_at, "peer verification timestamp"),
  };
}

export function openPeerStore(options: OpenPeerStoreOptions): PeerStore {
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
  // The outbound credential must be recoverable after restart, so this database is secret-bearing. Keep the
  // file private even when an operator supplied a permissive umask or an older install left it too broad.
  if (options.dbPath !== ":memory:") chmodSync(options.dbPath, 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS peer_connections (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      base_url TEXT NOT NULL UNIQUE,
      credential TEXT NOT NULL,
      remote_host_id TEXT NOT NULL UNIQUE,
      remote_version TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      allowed_workspace_ids_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','suspended')),
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_verified_at INTEGER NOT NULL
    )
  `);
  const generatePeerId = options.generatePeerId ?? (() => `rce_${randomBytes(18).toString("base64url")}`);
  const row = (id: string) => db.prepare("SELECT * FROM peer_connections WHERE id = ?").get(id) as PeerRow | undefined;
  const insert = db.prepare(
    `INSERT INTO peer_connections
      (id,label,base_url,credential,remote_host_id,remote_version,actions_json,allowed_workspace_ids_json,
       status,revision,created_at,updated_at,last_verified_at)
     VALUES (@id,@label,@base_url,@credential,@remote_host_id,@remote_version,@actions_json,
       @allowed_workspace_ids_json,@status,@revision,@created_at,@updated_at,@last_verified_at)`,
  );
  const replace = db.prepare(
    `UPDATE peer_connections SET label=@label, credential=@credential, remote_version=@remote_version,
       actions_json=@actions_json, allowed_workspace_ids_json=@allowed_workspace_ids_json, status=@status,
       revision=@revision, updated_at=@updated_at, last_verified_at=@last_verified_at
     WHERE id=@id AND revision=@expected_revision`,
  );
  const values = (peer: PeerConnection) => ({
    id: peer.id,
    label: peer.label,
    base_url: peer.baseUrl,
    credential: peer.credential,
    remote_host_id: peer.remoteHostId,
    remote_version: peer.remoteVersion,
    actions_json: JSON.stringify(peer.actions),
    allowed_workspace_ids_json: peer.allowedWorkspaceIds === null ? null : JSON.stringify(peer.allowedWorkspaceIds),
    status: peer.status,
    revision: peer.revision,
    created_at: peer.createdAt,
    updated_at: peer.updatedAt,
    last_verified_at: peer.lastVerifiedAt,
  });
  return {
    mode: "sqlite",
    list: () =>
      (db.prepare("SELECT * FROM peer_connections ORDER BY created_at,id").all() as PeerRow[])
        .map(fromRow)
        .map(publicRecord),
    get(id) {
      const found = row(safeId(id, "peer id"));
      return found ? publicRecord(fromRow(found)) : undefined;
    },
    connection(id) {
      const found = row(safeId(id, "peer id"));
      return found ? fromRow(found) : undefined;
    },
    create(input, now = Date.now()) {
      const peer = normalizeCreate(input, generatePeerId(), now);
      try {
        insert.run(values(peer));
      } catch (error) {
        if (/UNIQUE constraint failed/.test((error as Error).message)) throw new Error("peer already exists");
        throw error;
      }
      return publicRecord(peer);
    },
    update(id, input, expectedRevision, now = Date.now()) {
      const safePeerId = safeId(id, "peer id");
      const revision = safeRevision(expectedRevision);
      const currentRow = row(safePeerId);
      if (!currentRow) return undefined;
      const current = fromRow(currentRow);
      if (current.revision !== revision) throw new PeerRevisionConflictError(publicRecord(current));
      const next = normalizedUpdate(current, input, now);
      let result: { changes: number };
      try {
        result = replace.run({ ...values(next), expected_revision: revision });
      } catch (error) {
        if (/UNIQUE constraint failed/.test((error as Error).message)) throw new Error("peer already exists");
        throw error;
      }
      if (result.changes === 0) {
        const latest = row(safePeerId);
        if (!latest) return undefined;
        throw new PeerRevisionConflictError(publicRecord(fromRow(latest)));
      }
      return publicRecord(next);
    },
    rotateCredential(id, input, expectedRevision, now = Date.now()) {
      const safePeerId = safeId(id, "peer id");
      const revision = safeRevision(expectedRevision);
      const currentRow = row(safePeerId);
      if (!currentRow) return undefined;
      const current = fromRow(currentRow);
      if (current.revision !== revision) throw new PeerRevisionConflictError(publicRecord(current));
      const next: PeerConnection = {
        ...current,
        credential: safeCredential(input.credential),
        remoteVersion: safeVersion(input.remoteVersion),
        lastVerifiedAt: safeTimestamp(input.lastVerifiedAt ?? now, "peer verification timestamp"),
        revision: current.revision + 1,
        updatedAt: now,
      };
      const result = replace.run({ ...values(next), expected_revision: revision });
      if (result.changes === 0) {
        const latest = row(safePeerId);
        if (!latest) return undefined;
        throw new PeerRevisionConflictError(publicRecord(fromRow(latest)));
      }
      return publicRecord(next);
    },
    remove(id) {
      return db.prepare("DELETE FROM peer_connections WHERE id = ?").run(safeId(id, "peer id")).changes > 0;
    },
    close: () => db.close(),
  };
}
