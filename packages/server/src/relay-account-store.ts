import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type RelayAccountStoreMode = "sqlite" | "memory";
export type RelayAccountStatus = "active" | "suspended" | "deleted";
export type RelayAccountPlan = "free" | "team" | "enterprise";

export interface RelayAccountRecord {
  id: string;
  label: string;
  status: RelayAccountStatus;
  plan: RelayAccountPlan;
  maxRoutes: number;
  maxDevicesPerRoute: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

interface RelayAccountFields {
  /** Stable control-plane identity. Omit for the legacy server-generated account flow. */
  id?: string;
  label: string;
  plan?: RelayAccountPlan;
  maxRoutes?: number;
  maxDevicesPerRoute?: number;
}

export interface RelayAccountCredentialMaterial {
  credentialHash: string;
  credentialLookup: string;
}

export type CreateRelayAccountInput = RelayAccountFields &
  (
    | ({ credential: string } & Partial<Record<keyof RelayAccountCredentialMaterial, never>>)
    | ({ credential?: never } & RelayAccountCredentialMaterial)
  );

export type RelayAccountCredentialInput = string | RelayAccountCredentialMaterial;

export interface UpdateRelayAccountInput {
  label?: string;
  status?: RelayAccountStatus;
  plan?: RelayAccountPlan;
  maxRoutes?: number;
  maxDevicesPerRoute?: number;
}

export interface RelayAccountStore {
  readonly mode: RelayAccountStoreMode;
  createAccount(input: CreateRelayAccountInput, now?: number): RelayAccountRecord;
  getAccount(id: string): RelayAccountRecord | undefined;
  listAccounts(options?: { includeDeleted?: boolean }): RelayAccountRecord[];
  /** Verify ownership for recovery without granting a suspended account route access. */
  verifyCredential(credential: string): RelayAccountRecord | undefined;
  authenticate(credential: string): RelayAccountRecord | undefined;
  /** Constant-time comparison for idempotent control-plane provisioning and credential rotation. */
  credentialMatches(id: string, credential: RelayAccountCredentialInput): boolean;
  updateAccount(
    id: string,
    input: UpdateRelayAccountInput,
    expectedRevision: number,
    now?: number,
  ): RelayAccountRecord | undefined;
  rotateCredential(
    id: string,
    credential: RelayAccountCredentialInput,
    expectedRevision: number,
    now?: number,
  ): RelayAccountRecord | undefined;
  close(): void;
}

export interface OpenRelayAccountStoreOptions {
  dbPath: string;
  generateAccountId?: () => string;
  loadDatabase?: () => typeof import("better-sqlite3");
}

export class RelayAccountRevisionConflictError extends Error {
  constructor(readonly current: RelayAccountRecord) {
    super("relay account revision conflict");
    this.name = "RelayAccountRevisionConflictError";
  }
}

const PLAN_DEFAULTS: Record<RelayAccountPlan, { maxRoutes: number; maxDevicesPerRoute: number }> = {
  free: { maxRoutes: 3, maxDevicesPerRoute: 16 },
  team: { maxRoutes: 25, maxDevicesPerRoute: 64 },
  enterprise: { maxRoutes: 500, maxDevicesPerRoute: 500 },
};
const UNSAFE_TERMINAL_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function safeId(value: unknown): string {
  if (typeof value !== "string" || !/^rra_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new Error("invalid relay account id");
  }
  return value;
}

function safeLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("relay account label is required");
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 120 || UNSAFE_TERMINAL_TEXT.test(label)) {
    throw new Error("invalid relay account label");
  }
  return label;
}

function safeCredential(value: unknown): string {
  if (typeof value !== "string" || !/^rrk_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("invalid relay account credential");
  }
  return value;
}

function digest(label: string, credential: string): string {
  return createHash("sha256").update(label).update("\0").update(safeCredential(credential)).digest("base64url");
}

export function relayAccountCredentialHash(credential: string): string {
  return `sha256:${digest("roamcode-relay-account-credential-v1", credential)}`;
}

export function relayAccountCredentialLookup(credential: string): string {
  return `lookup:${digest("roamcode-relay-account-lookup-v1", credential)}`;
}

export function generateRelayAccountCredential(): string {
  return `rrk_${randomBytes(32).toString("base64url")}`;
}

function safeHash(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("invalid relay account credential hash");
  }
  return value;
}

function safeLookup(value: unknown): string {
  if (typeof value !== "string" || !/^lookup:[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("invalid relay account credential lookup");
  }
  return value;
}

function credentialMaterial(
  input: RelayAccountCredentialInput | CreateRelayAccountInput,
): RelayAccountCredentialMaterial {
  if (typeof input === "string") {
    return {
      credentialHash: relayAccountCredentialHash(input),
      credentialLookup: relayAccountCredentialLookup(input),
    };
  }
  if ("credential" in input && input.credential !== undefined) {
    if (input.credentialHash !== undefined || input.credentialLookup !== undefined) {
      throw new Error("relay account credential must be raw or pre-hashed, not both");
    }
    return {
      credentialHash: relayAccountCredentialHash(input.credential),
      credentialLookup: relayAccountCredentialLookup(input.credential),
    };
  }
  return {
    credentialHash: safeHash(input.credentialHash),
    credentialLookup: safeLookup(input.credentialLookup),
  };
}

function hashMatches(expected: string, credential: string): boolean {
  try {
    const left = Buffer.from(safeHash(expected));
    const right = Buffer.from(relayAccountCredentialHash(credential));
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function storedCredentialMatches(
  expectedHash: string,
  expectedLookup: string,
  credential: RelayAccountCredentialInput,
): boolean {
  try {
    const actual = credentialMaterial(credential);
    const expectedHashBytes = Buffer.from(safeHash(expectedHash));
    const actualHashBytes = Buffer.from(actual.credentialHash);
    const expectedLookupBytes = Buffer.from(safeLookup(expectedLookup));
    const actualLookupBytes = Buffer.from(actual.credentialLookup);
    return (
      expectedHashBytes.length === actualHashBytes.length &&
      expectedLookupBytes.length === actualLookupBytes.length &&
      timingSafeEqual(expectedHashBytes, actualHashBytes) &&
      timingSafeEqual(expectedLookupBytes, actualLookupBytes)
    );
  } catch {
    return false;
  }
}

function safePlan(value: unknown): RelayAccountPlan {
  if (value !== "free" && value !== "team" && value !== "enterprise") throw new Error("invalid relay account plan");
  return value;
}

function boundedLimit(value: unknown, fallback: number, maximum: number, field: string): number {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > maximum) {
    throw new Error(`invalid relay account ${field}`);
  }
  return candidate as number;
}

function safeStatus(value: unknown): RelayAccountStatus {
  if (value !== "active" && value !== "suspended" && value !== "deleted") {
    throw new Error("invalid relay account status");
  }
  return value;
}

function clone(record: RelayAccountRecord): RelayAccountRecord {
  return {
    id: record.id,
    label: record.label,
    status: record.status,
    plan: record.plan,
    maxRoutes: record.maxRoutes,
    maxDevicesPerRoute: record.maxDevicesPerRoute,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function createMemoryStore(options: OpenRelayAccountStoreOptions): RelayAccountStore {
  const accounts = new Map<string, RelayAccountRecord & { credentialHash: string; credentialLookup: string }>();
  const lookup = new Map<string, string>();
  const generateAccountId = options.generateAccountId ?? (() => `rra_${randomBytes(18).toString("base64url")}`);
  const verifyCredential = (credential: string): RelayAccountRecord | undefined => {
    let credentialLookup: string;
    try {
      credentialLookup = relayAccountCredentialLookup(credential);
    } catch {
      return;
    }
    const id = lookup.get(credentialLookup);
    const record = id ? accounts.get(id) : undefined;
    return record && record.status !== "deleted" && hashMatches(record.credentialHash, credential)
      ? clone(record)
      : undefined;
  };

  return {
    mode: "memory",
    createAccount(input, now = Date.now()) {
      const id = safeId(input.id ?? generateAccountId());
      if (accounts.has(id)) throw new Error("relay account already exists");
      const plan = safePlan(input.plan ?? "free");
      const { credentialHash, credentialLookup } = credentialMaterial(input);
      if (lookup.has(credentialLookup)) throw new Error("relay account credential already exists");
      const defaults = PLAN_DEFAULTS[plan];
      const record = {
        id,
        label: safeLabel(input.label),
        status: "active" as const,
        plan,
        maxRoutes: boundedLimit(input.maxRoutes, defaults.maxRoutes, 10_000, "route limit"),
        maxDevicesPerRoute: boundedLimit(
          input.maxDevicesPerRoute,
          defaults.maxDevicesPerRoute,
          100_000,
          "device limit",
        ),
        revision: 1,
        createdAt: now,
        updatedAt: now,
        credentialHash,
        credentialLookup,
      };
      accounts.set(id, record);
      lookup.set(credentialLookup, id);
      return clone(record);
    },
    getAccount(id) {
      const record = accounts.get(safeId(id));
      return record ? clone(record) : undefined;
    },
    listAccounts({ includeDeleted = false } = {}) {
      return [...accounts.values()]
        .filter((record) => includeDeleted || record.status !== "deleted")
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map(clone);
    },
    verifyCredential,
    authenticate(credential) {
      const record = verifyCredential(credential);
      return record?.status === "active" ? record : undefined;
    },
    credentialMatches(id, credential) {
      try {
        const record = accounts.get(safeId(id));
        return !!record && storedCredentialMatches(record.credentialHash, record.credentialLookup, credential);
      } catch {
        return false;
      }
    },
    updateAccount(id, input, expectedRevision, now = Date.now()) {
      const current = accounts.get(safeId(id));
      if (!current) return undefined;
      if (current.revision !== expectedRevision) throw new RelayAccountRevisionConflictError(clone(current));
      if (current.status === "deleted") throw new Error("deleted relay account is immutable");
      const plan = input.plan === undefined ? current.plan : safePlan(input.plan);
      const status = input.status === undefined ? current.status : safeStatus(input.status);
      const defaults = PLAN_DEFAULTS[plan];
      const next = {
        ...current,
        ...(input.label === undefined ? {} : { label: safeLabel(input.label) }),
        status,
        plan,
        maxRoutes: boundedLimit(
          input.maxRoutes,
          input.plan === undefined ? current.maxRoutes : defaults.maxRoutes,
          10_000,
          "route limit",
        ),
        maxDevicesPerRoute: boundedLimit(
          input.maxDevicesPerRoute,
          input.plan === undefined ? current.maxDevicesPerRoute : defaults.maxDevicesPerRoute,
          100_000,
          "device limit",
        ),
        revision: current.revision + 1,
        updatedAt: now,
      };
      accounts.set(current.id, next);
      return clone(next);
    },
    rotateCredential(id, credential, expectedRevision, now = Date.now()) {
      const current = accounts.get(safeId(id));
      if (!current) return undefined;
      if (current.revision !== expectedRevision) throw new RelayAccountRevisionConflictError(clone(current));
      if (current.status === "deleted") throw new Error("deleted relay account is immutable");
      const { credentialHash, credentialLookup } = credentialMaterial(credential);
      const owner = lookup.get(credentialLookup);
      if (owner && owner !== current.id) throw new Error("relay account credential already exists");
      lookup.delete(current.credentialLookup);
      lookup.set(credentialLookup, current.id);
      const next = {
        ...current,
        credentialHash,
        credentialLookup,
        revision: current.revision + 1,
        updatedAt: now,
      };
      accounts.set(current.id, next);
      return clone(next);
    },
    close() {
      accounts.clear();
      lookup.clear();
    },
  };
}

interface AccountRow {
  id: string;
  label: string;
  status: RelayAccountStatus;
  plan: RelayAccountPlan;
  max_routes: number;
  max_devices_per_route: number;
  revision: number;
  credential_hash: string;
  credential_lookup: string;
  created_at: number;
  updated_at: number;
}

function normalizeSqliteAccountConstraint(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  if (code === "SQLITE_CONSTRAINT_UNIQUE" && message.includes("relay_accounts.credential_lookup")) {
    throw new Error("relay account credential already exists");
  }
  if (code === "SQLITE_CONSTRAINT_UNIQUE" && message.includes("relay_accounts.id")) {
    throw new Error("relay account already exists");
  }
  throw error;
}

function fromRow(row: AccountRow): RelayAccountRecord {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    plan: row.plan,
    maxRoutes: row.max_routes,
    maxDevicesPerRoute: row.max_devices_per_route,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function openRelayAccountStore(options: OpenRelayAccountStoreOptions): RelayAccountStore {
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'suspended', 'deleted')),
      plan TEXT NOT NULL CHECK(plan IN ('free', 'team', 'enterprise')),
      max_routes INTEGER NOT NULL,
      max_devices_per_route INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      credential_hash TEXT NOT NULL,
      credential_lookup TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS relay_accounts_status_idx ON relay_accounts(status);
  `);
  const generateAccountId = options.generateAccountId ?? (() => `rra_${randomBytes(18).toString("base64url")}`);
  const rowById = (id: string) =>
    db.prepare("SELECT * FROM relay_accounts WHERE id = ?").get(id) as AccountRow | undefined;
  const verifyCredential = (credential: string): RelayAccountRecord | undefined => {
    let credentialLookup: string;
    try {
      credentialLookup = relayAccountCredentialLookup(credential);
    } catch {
      return;
    }
    const row = db
      .prepare("SELECT * FROM relay_accounts WHERE credential_lookup = ? AND status != 'deleted'")
      .get(credentialLookup) as AccountRow | undefined;
    return row && hashMatches(row.credential_hash, credential) ? fromRow(row) : undefined;
  };
  const createAccount = db.transaction((input: CreateRelayAccountInput, now: number): RelayAccountRecord => {
    const id = safeId(input.id ?? generateAccountId());
    if (rowById(id)) throw new Error("relay account already exists");
    const plan = safePlan(input.plan ?? "free");
    const { credentialHash, credentialLookup } = credentialMaterial(input);
    const defaults = PLAN_DEFAULTS[plan];
    const record: RelayAccountRecord = {
      id,
      label: safeLabel(input.label),
      status: "active",
      plan,
      maxRoutes: boundedLimit(input.maxRoutes, defaults.maxRoutes, 10_000, "route limit"),
      maxDevicesPerRoute: boundedLimit(input.maxDevicesPerRoute, defaults.maxDevicesPerRoute, 100_000, "device limit"),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      db.prepare(
        `INSERT INTO relay_accounts
         (id, label, status, plan, max_routes, max_devices_per_route, revision, credential_hash,
          credential_lookup, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.label,
        record.status,
        record.plan,
        record.maxRoutes,
        record.maxDevicesPerRoute,
        record.revision,
        credentialHash,
        credentialLookup,
        record.createdAt,
        record.updatedAt,
      );
    } catch (error) {
      normalizeSqliteAccountConstraint(error);
    }
    return record;
  });

  return {
    mode: "sqlite",
    createAccount: (input, now = Date.now()) => clone(createAccount(input, now)),
    getAccount(id) {
      const row = rowById(safeId(id));
      return row ? fromRow(row) : undefined;
    },
    listAccounts({ includeDeleted = false } = {}) {
      const rows = db
        .prepare(
          `SELECT * FROM relay_accounts ${includeDeleted ? "" : "WHERE status != 'deleted'"}
           ORDER BY created_at, id`,
        )
        .all() as AccountRow[];
      return rows.map(fromRow);
    },
    verifyCredential,
    authenticate(credential) {
      const record = verifyCredential(credential);
      return record?.status === "active" ? record : undefined;
    },
    credentialMatches(id, credential) {
      try {
        const row = rowById(safeId(id));
        return !!row && storedCredentialMatches(row.credential_hash, row.credential_lookup, credential);
      } catch {
        return false;
      }
    },
    updateAccount(id, input, expectedRevision, now = Date.now()) {
      const safeAccountId = safeId(id);
      const currentRow = rowById(safeAccountId);
      if (!currentRow) return undefined;
      const current = fromRow(currentRow);
      if (current.revision !== expectedRevision) throw new RelayAccountRevisionConflictError(current);
      if (current.status === "deleted") throw new Error("deleted relay account is immutable");
      const plan = input.plan === undefined ? current.plan : safePlan(input.plan);
      const defaults = PLAN_DEFAULTS[plan];
      const next: RelayAccountRecord = {
        ...current,
        ...(input.label === undefined ? {} : { label: safeLabel(input.label) }),
        status: input.status === undefined ? current.status : safeStatus(input.status),
        plan,
        maxRoutes: boundedLimit(
          input.maxRoutes,
          input.plan === undefined ? current.maxRoutes : defaults.maxRoutes,
          10_000,
          "route limit",
        ),
        maxDevicesPerRoute: boundedLimit(
          input.maxDevicesPerRoute,
          input.plan === undefined ? current.maxDevicesPerRoute : defaults.maxDevicesPerRoute,
          100_000,
          "device limit",
        ),
        revision: current.revision + 1,
        updatedAt: now,
      };
      const result = db
        .prepare(
          `UPDATE relay_accounts SET label = ?, status = ?, plan = ?, max_routes = ?,
           max_devices_per_route = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`,
        )
        .run(
          next.label,
          next.status,
          next.plan,
          next.maxRoutes,
          next.maxDevicesPerRoute,
          next.revision,
          next.updatedAt,
          next.id,
          expectedRevision,
        );
      if (result.changes !== 1) {
        const latest = rowById(safeAccountId);
        if (latest) throw new RelayAccountRevisionConflictError(fromRow(latest));
        return undefined;
      }
      return next;
    },
    rotateCredential(id, credential, expectedRevision, now = Date.now()) {
      const safeAccountId = safeId(id);
      const currentRow = rowById(safeAccountId);
      if (!currentRow) return undefined;
      const current = fromRow(currentRow);
      if (current.revision !== expectedRevision) throw new RelayAccountRevisionConflictError(current);
      if (current.status === "deleted") throw new Error("deleted relay account is immutable");
      const { credentialHash, credentialLookup } = credentialMaterial(credential);
      let result: ReturnType<ReturnType<typeof db.prepare>["run"]>;
      try {
        result = db
          .prepare(
            `UPDATE relay_accounts SET credential_hash = ?, credential_lookup = ?, revision = revision + 1,
             updated_at = ? WHERE id = ? AND revision = ?`,
          )
          .run(credentialHash, credentialLookup, now, safeAccountId, expectedRevision);
      } catch (error) {
        normalizeSqliteAccountConstraint(error);
      }
      if (result.changes !== 1) {
        const latest = rowById(safeAccountId);
        if (latest) throw new RelayAccountRevisionConflictError(fromRow(latest));
        return undefined;
      }
      return fromRow(rowById(safeAccountId)!);
    },
    close: () => db.close(),
  };
}
