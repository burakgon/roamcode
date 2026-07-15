import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type PolicyStoreMode = "sqlite" | "memory-fallback";
export type ExtensionPolicyMode = "allow-integrity" | "signed-only" | "deny";
export type UpdatePolicyMode = "stable-only" | "deny";

export interface EnterprisePolicy {
  enforcementEnabled: boolean;
  allowedHostIds: string[] | null;
  allowedWorkspaceIds: string[] | null;
  allowedProviderIds: string[] | null;
  allowDangerousProviderModes: boolean;
  allowFileTransfer: boolean;
  extensionMode: ExtensionPolicyMode;
  allowRelay: boolean;
  updateMode: UpdatePolicyMode;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnterprisePolicyUpdate {
  enforcementEnabled?: boolean;
  allowedHostIds?: string[] | null;
  allowedWorkspaceIds?: string[] | null;
  allowedProviderIds?: string[] | null;
  allowDangerousProviderModes?: boolean;
  allowFileTransfer?: boolean;
  extensionMode?: ExtensionPolicyMode;
  allowRelay?: boolean;
  updateMode?: UpdatePolicyMode;
}

export type EnterprisePolicyAction =
  "access" | "session.launch" | "file.transfer" | "extension.mutate" | "relay.access" | "update.mutate";

export interface EnterprisePolicyContext {
  hostId: string;
  workspaceId?: string;
  providerId?: string;
  dangerousProviderMode?: boolean;
  extensionTrust?: "signed" | "integrity";
  updateChannel?: "stable" | "beta" | "nightly";
}

export interface EnterprisePolicyDecision {
  allowed: boolean;
  reason:
    | "not-enforced"
    | "allowed"
    | "host-denied"
    | "workspace-denied"
    | "provider-denied"
    | "dangerous-mode-denied"
    | "file-transfer-denied"
    | "extension-denied"
    | "extension-signature-required"
    | "relay-denied"
    | "updates-denied"
    | "update-channel-denied";
}

export interface PolicyStore {
  readonly mode: PolicyStoreMode;
  get(): EnterprisePolicy;
  update(input: EnterprisePolicyUpdate, expectedRevision: number, now?: number): EnterprisePolicy;
  close(): void;
}

export interface OpenPolicyStoreOptions {
  dbPath: string;
  loadDatabase?: () => typeof import("better-sqlite3");
  now?: number;
}

export class EnterprisePolicyRevisionConflictError extends Error {
  constructor(readonly current: EnterprisePolicy) {
    super("enterprise policy revision conflict");
    this.name = "EnterprisePolicyRevisionConflictError";
  }
}

const DEFAULT_POLICY: Omit<EnterprisePolicy, "revision" | "createdAt" | "updatedAt"> = {
  enforcementEnabled: false,
  allowedHostIds: null,
  allowedWorkspaceIds: null,
  allowedProviderIds: null,
  allowDangerousProviderModes: false,
  allowFileTransfer: true,
  extensionMode: "allow-integrity",
  allowRelay: true,
  updateMode: "stable-only",
};

function clone(policy: EnterprisePolicy): EnterprisePolicy {
  return {
    ...policy,
    allowedHostIds: policy.allowedHostIds ? [...policy.allowedHostIds] : null,
    allowedWorkspaceIds: policy.allowedWorkspaceIds ? [...policy.allowedWorkspaceIds] : null,
    allowedProviderIds: policy.allowedProviderIds ? [...policy.allowedProviderIds] : null,
  };
}

function safeIds(value: unknown, field: string, provider = false): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 1_000) throw new Error(`invalid ${field}`);
  const pattern = provider ? /^[a-z][a-z0-9-]{0,63}$/ : /^[A-Za-z0-9._:-]{1,256}$/;
  if (value.some((item) => typeof item !== "string" || !pattern.test(item))) throw new Error(`invalid ${field}`);
  return [...new Set(value)].sort();
}

function safeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
  return value;
}

function normalizeUpdate(current: EnterprisePolicy, input: EnterprisePolicyUpdate): EnterprisePolicy {
  const allowedKeys = new Set<keyof EnterprisePolicyUpdate>([
    "enforcementEnabled",
    "allowedHostIds",
    "allowedWorkspaceIds",
    "allowedProviderIds",
    "allowDangerousProviderModes",
    "allowFileTransfer",
    "extensionMode",
    "allowRelay",
    "updateMode",
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key as keyof EnterprisePolicyUpdate))) {
    throw new Error("invalid enterprise policy field");
  }
  if (Object.keys(input).length === 0) throw new Error("enterprise policy update is empty");
  const output: EnterprisePolicyUpdate = {};
  if (input.enforcementEnabled !== undefined) {
    output.enforcementEnabled = safeBoolean(input.enforcementEnabled, "policy enforcement flag");
  }
  if (input.allowedHostIds !== undefined) output.allowedHostIds = safeIds(input.allowedHostIds, "allowed host ids");
  if (input.allowedWorkspaceIds !== undefined) {
    output.allowedWorkspaceIds = safeIds(input.allowedWorkspaceIds, "allowed workspace ids");
  }
  if (input.allowedProviderIds !== undefined) {
    output.allowedProviderIds = safeIds(input.allowedProviderIds, "allowed provider ids", true);
  }
  if (input.allowDangerousProviderModes !== undefined) {
    output.allowDangerousProviderModes = safeBoolean(input.allowDangerousProviderModes, "dangerous-mode flag");
  }
  if (input.allowFileTransfer !== undefined) {
    output.allowFileTransfer = safeBoolean(input.allowFileTransfer, "file-transfer flag");
  }
  if (input.extensionMode !== undefined) {
    if (!(["allow-integrity", "signed-only", "deny"] as unknown[]).includes(input.extensionMode)) {
      throw new Error("invalid extension policy");
    }
    output.extensionMode = input.extensionMode;
  }
  if (input.allowRelay !== undefined) output.allowRelay = safeBoolean(input.allowRelay, "relay flag");
  if (input.updateMode !== undefined) {
    if (input.updateMode !== "stable-only" && input.updateMode !== "deny") throw new Error("invalid update policy");
    output.updateMode = input.updateMode;
  }
  return { ...current, ...output };
}

export function evaluateEnterprisePolicy(
  policy: EnterprisePolicy,
  action: EnterprisePolicyAction,
  context: EnterprisePolicyContext,
): EnterprisePolicyDecision {
  if (!policy.enforcementEnabled) return { allowed: true, reason: "not-enforced" };
  if (policy.allowedHostIds && !policy.allowedHostIds.includes(context.hostId)) {
    return { allowed: false, reason: "host-denied" };
  }
  if (context.workspaceId && policy.allowedWorkspaceIds && !policy.allowedWorkspaceIds.includes(context.workspaceId)) {
    return { allowed: false, reason: "workspace-denied" };
  }
  if (action === "session.launch") {
    if (policy.allowedWorkspaceIds && !context.workspaceId) {
      return { allowed: false, reason: "workspace-denied" };
    }
    if (context.providerId && policy.allowedProviderIds && !policy.allowedProviderIds.includes(context.providerId)) {
      return { allowed: false, reason: "provider-denied" };
    }
    if (context.dangerousProviderMode && !policy.allowDangerousProviderModes) {
      return { allowed: false, reason: "dangerous-mode-denied" };
    }
  }
  if (action === "file.transfer" && !policy.allowFileTransfer) {
    return { allowed: false, reason: "file-transfer-denied" };
  }
  if (action === "extension.mutate") {
    if (policy.extensionMode === "deny") return { allowed: false, reason: "extension-denied" };
    if (policy.extensionMode === "signed-only" && context.extensionTrust !== "signed") {
      return { allowed: false, reason: "extension-signature-required" };
    }
  }
  if (action === "relay.access" && !policy.allowRelay) return { allowed: false, reason: "relay-denied" };
  if (action === "update.mutate") {
    if (policy.updateMode === "deny") return { allowed: false, reason: "updates-denied" };
    if ((context.updateChannel ?? "stable") !== "stable") {
      return { allowed: false, reason: "update-channel-denied" };
    }
  }
  return { allowed: true, reason: "allowed" };
}

function createMemoryStore(options: OpenPolicyStoreOptions): PolicyStore {
  const now = options.now ?? Date.now();
  let policy: EnterprisePolicy = { ...DEFAULT_POLICY, revision: 1, createdAt: now, updatedAt: now };
  return {
    mode: "memory-fallback",
    get: () => clone(policy),
    update(input, expectedRevision, at = Date.now()) {
      if (policy.revision !== expectedRevision) throw new EnterprisePolicyRevisionConflictError(clone(policy));
      const normalized = normalizeUpdate(policy, input);
      policy = { ...policy, ...normalized, revision: policy.revision + 1, updatedAt: at };
      return clone(policy);
    },
    close() {},
  };
}

interface PolicyRow {
  enforcement_enabled: number;
  allowed_host_ids_json: string | null;
  allowed_workspace_ids_json: string | null;
  allowed_provider_ids_json: string | null;
  allow_dangerous_provider_modes: number;
  allow_file_transfer: number;
  extension_mode: ExtensionPolicyMode;
  allow_relay: number;
  update_mode: UpdatePolicyMode;
  revision: number;
  created_at: number;
  updated_at: number;
}

function listFromJson(value: string | null, field: string, provider = false): string[] | null {
  if (value === null) return null;
  try {
    return safeIds(JSON.parse(value) as unknown, field, provider);
  } catch {
    throw new Error(`corrupt ${field}`);
  }
}

function fromRow(row: PolicyRow): EnterprisePolicy {
  return {
    enforcementEnabled: row.enforcement_enabled === 1,
    allowedHostIds: listFromJson(row.allowed_host_ids_json, "allowed host ids"),
    allowedWorkspaceIds: listFromJson(row.allowed_workspace_ids_json, "allowed workspace ids"),
    allowedProviderIds: listFromJson(row.allowed_provider_ids_json, "allowed provider ids", true),
    allowDangerousProviderModes: row.allow_dangerous_provider_modes === 1,
    allowFileTransfer: row.allow_file_transfer === 1,
    extensionMode: row.extension_mode,
    allowRelay: row.allow_relay === 1,
    updateMode: row.update_mode,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function openPolicyStore(options: OpenPolicyStoreOptions): PolicyStore {
  let Database: typeof import("better-sqlite3");
  try {
    if (options.loadDatabase) Database = options.loadDatabase();
    else {
      const module = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
      Database = (module.default ?? module) as typeof import("better-sqlite3");
    }
  } catch {
    return createMemoryStore(options);
  }
  const db = new Database(options.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS enterprise_policy (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      enforcement_enabled INTEGER NOT NULL,
      allowed_host_ids_json TEXT,
      allowed_workspace_ids_json TEXT,
      allowed_provider_ids_json TEXT,
      allow_dangerous_provider_modes INTEGER NOT NULL,
      allow_file_transfer INTEGER NOT NULL,
      extension_mode TEXT NOT NULL,
      allow_relay INTEGER NOT NULL,
      update_mode TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const getRow = db.prepare("SELECT * FROM enterprise_policy WHERE singleton = 1");
  const initialNow = options.now ?? Date.now();
  if (!getRow.get()) {
    db.prepare(
      `INSERT INTO enterprise_policy
       (singleton, enforcement_enabled, allowed_host_ids_json, allowed_workspace_ids_json,
        allowed_provider_ids_json, allow_dangerous_provider_modes, allow_file_transfer, extension_mode,
        allow_relay, update_mode, revision, created_at, updated_at)
       VALUES (1, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      Number(DEFAULT_POLICY.enforcementEnabled),
      Number(DEFAULT_POLICY.allowDangerousProviderModes),
      Number(DEFAULT_POLICY.allowFileTransfer),
      DEFAULT_POLICY.extensionMode,
      Number(DEFAULT_POLICY.allowRelay),
      DEFAULT_POLICY.updateMode,
      initialNow,
      initialNow,
    );
  }
  const updateRow = db.prepare(
    `UPDATE enterprise_policy SET enforcement_enabled = ?, allowed_host_ids_json = ?,
       allowed_workspace_ids_json = ?, allowed_provider_ids_json = ?, allow_dangerous_provider_modes = ?,
       allow_file_transfer = ?, extension_mode = ?, allow_relay = ?, update_mode = ?, revision = ?, updated_at = ?
     WHERE singleton = 1 AND revision = ?`,
  );
  const read = (): EnterprisePolicy => fromRow(getRow.get() as PolicyRow);
  return {
    mode: "sqlite",
    get: () => clone(read()),
    update(input, expectedRevision, now = Date.now()) {
      const current = read();
      if (current.revision !== expectedRevision) throw new EnterprisePolicyRevisionConflictError(clone(current));
      const normalized = normalizeUpdate(current, input);
      const next = { ...current, ...normalized, revision: current.revision + 1, updatedAt: now };
      const changed = updateRow.run(
        Number(next.enforcementEnabled),
        next.allowedHostIds === null ? null : JSON.stringify(next.allowedHostIds),
        next.allowedWorkspaceIds === null ? null : JSON.stringify(next.allowedWorkspaceIds),
        next.allowedProviderIds === null ? null : JSON.stringify(next.allowedProviderIds),
        Number(next.allowDangerousProviderModes),
        Number(next.allowFileTransfer),
        next.extensionMode,
        Number(next.allowRelay),
        next.updateMode,
        next.revision,
        next.updatedAt,
        expectedRevision,
      ).changes;
      if (changed !== 1) throw new EnterprisePolicyRevisionConflictError(clone(read()));
      return clone(next);
    },
    close: () => db.close(),
  };
}
