import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type ControlStoreMode = "sqlite" | "memory-fallback";
export type AuditActorType = "host" | "device" | "local" | "automation" | "plugin" | "system";
export type AuditResult = "success" | "denied" | "error";

export interface IdempotencyRecord {
  actorId: string;
  key: string;
  fingerprint: string;
  statusCode: number;
  body: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuditRecord {
  id: number;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  result: AuditResult;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: number;
  previousHash: string;
  hash: string;
}

export type AutomationTrigger = {
  eventType: string;
  resourceType?: string;
};

export type AutomationAction =
  | { type: "acknowledge_attention"; target: "event-resource" | string }
  | { type: "resolve_attention"; target: "event-resource" | string }
  | { type: "snooze_attention"; target: "event-resource" | string; durationMs: number }
  | { type: "emit_event"; eventType: string; resourceType: string; resourceId: string };

export interface AutomationDefinition {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
  permissions: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRun {
  id: number;
  automationId: string;
  eventId?: number;
  status: "succeeded" | "skipped" | "failed";
  detail?: string;
  createdAt: number;
}

export interface CreateAutomationInput {
  name: string;
  enabled?: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
  permissions: string[];
}

export interface UpdateAutomationInput {
  name?: string;
  enabled?: boolean;
  trigger?: AutomationTrigger;
  action?: AutomationAction;
  permissions?: string[];
}

export interface ControlStore {
  readonly mode: ControlStoreMode;
  getIdempotency(actorId: string, key: string, now?: number): IdempotencyRecord | undefined;
  putIdempotency(record: IdempotencyRecord): void;
  appendAudit(input: Omit<AuditRecord, "id" | "previousHash" | "hash">): AuditRecord;
  listAudit(afterId?: number, limit?: number): AuditRecord[];
  listAuditLatest(limit?: number): AuditRecord[];
  verifyAuditChain(): { valid: boolean; count: number; head: string };
  listAutomations(): AutomationDefinition[];
  getAutomation(id: string): AutomationDefinition | undefined;
  createAutomation(input: CreateAutomationInput, now?: number): AutomationDefinition;
  updateAutomation(id: string, input: UpdateAutomationInput, now?: number): AutomationDefinition | undefined;
  removeAutomation(id: string): boolean;
  recordAutomationRun(input: Omit<AutomationRun, "id">): AutomationRun;
  listAutomationRuns(automationId?: string, limit?: number): AutomationRun[];
  close(): void;
}

export interface OpenControlStoreOptions {
  dbPath: string;
  generateAutomationId?: () => string;
  loadDatabase?: () => typeof import("better-sqlite3");
}

const EMPTY_HASH = "0".repeat(64);

function randomId(): string {
  return `rca_${randomBytes(18).toString("base64url")}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > max || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized)) return undefined;
  return normalized;
}

function validEventType(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_.-]{0,79}$/.test(value);
}

function normalizePermissions(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const permissions = [...new Set(value)];
  if (permissions.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9:_-]{0,79}$/.test(item))) {
    return undefined;
  }
  return permissions as string[];
}

export function normalizeAutomationTrigger(value: unknown): AutomationTrigger | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!validEventType(raw.eventType)) return undefined;
  if (raw.resourceType !== undefined && !validEventType(raw.resourceType)) return undefined;
  return {
    eventType: raw.eventType,
    ...(typeof raw.resourceType === "string" ? { resourceType: raw.resourceType } : {}),
  };
}

export function normalizeAutomationAction(value: unknown): AutomationAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type === "acknowledge_attention" || raw.type === "resolve_attention") {
    const target = boundedText(raw.target, 128);
    return target ? { type: raw.type, target } : undefined;
  }
  if (raw.type === "snooze_attention") {
    const target = boundedText(raw.target, 128);
    const durationMs = raw.durationMs;
    if (
      !target ||
      !Number.isSafeInteger(durationMs) ||
      (durationMs as number) < 60_000 ||
      (durationMs as number) > 30 * 86_400_000
    ) {
      return undefined;
    }
    return { type: raw.type, target, durationMs: durationMs as number };
  }
  if (raw.type === "emit_event") {
    const resourceId = boundedText(raw.resourceId, 128);
    if (!validEventType(raw.eventType) || !validEventType(raw.resourceType) || !resourceId) return undefined;
    return { type: raw.type, eventType: raw.eventType, resourceType: raw.resourceType, resourceId };
  }
  return undefined;
}

export function normalizeAutomationInput(value: unknown): CreateAutomationInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const name = boundedText(raw.name, 80);
  const trigger = normalizeAutomationTrigger(raw.trigger);
  const action = normalizeAutomationAction(raw.action);
  const permissions = normalizePermissions(raw.permissions);
  if (!name || !trigger || !action || !permissions || (raw.enabled !== undefined && typeof raw.enabled !== "boolean")) {
    return undefined;
  }
  return { name, trigger, action, permissions, ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}) };
}

const PRIVATE_METADATA_KEY =
  /(^|[_.-])(token|secret|authorization|cookie|prompt|content|terminal|path|cwd|source|body)($|[_.-])/i;

/** Retain only coarse, bounded audit metadata; content- or credential-shaped fields are dropped. */
export function privacySafeAuditMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value ?? {}).slice(0, 32)) {
    const semanticKey = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
    if (
      !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) ||
      PRIVATE_METADATA_KEY.test(semanticKey) ||
      semanticKey.toLowerCase() === "code"
    )
      continue;
    if (typeof item === "string") result[key] = item.slice(0, 160);
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "boolean" || item === null) result[key] = item;
  }
  return result;
}

function auditHash(input: Omit<AuditRecord, "id" | "hash">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.previousHash,
        input.actorType,
        input.actorId,
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.result,
        input.metadata,
        input.createdAt,
      ]),
    )
    .digest("hex");
}

function createMemoryStore(opts: OpenControlStoreOptions): ControlStore {
  const idempotency = new Map<string, IdempotencyRecord>();
  const audit: AuditRecord[] = [];
  const automations = new Map<string, AutomationDefinition>();
  const runs: AutomationRun[] = [];
  const generateAutomationId = opts.generateAutomationId ?? randomId;

  return {
    mode: "memory-fallback",
    getIdempotency(actorId, key, now = Date.now()) {
      const mapKey = `${actorId}\0${key}`;
      const record = idempotency.get(mapKey);
      if (!record || record.expiresAt <= now) {
        idempotency.delete(mapKey);
        return undefined;
      }
      return { ...record };
    },
    putIdempotency(record) {
      idempotency.set(`${record.actorId}\0${record.key}`, { ...record });
    },
    appendAudit(input) {
      const previousHash = audit.at(-1)?.hash ?? EMPTY_HASH;
      const material = { ...input, metadata: privacySafeAuditMetadata(input.metadata), previousHash };
      const record: AuditRecord = { id: audit.length + 1, ...material, hash: auditHash(material) };
      audit.push(record);
      return clone(record);
    },
    listAudit: (afterId = 0, limit = 500) =>
      audit
        .filter((record) => record.id > afterId)
        .slice(0, Math.max(1, Math.min(1000, limit)))
        .map(clone),
    listAuditLatest: (limit = 100) =>
      audit
        .slice(-Math.max(1, Math.min(1000, Math.trunc(limit))))
        .reverse()
        .map(clone),
    verifyAuditChain() {
      let previousHash = EMPTY_HASH;
      for (const record of audit) {
        const expected = auditHash({ ...record, previousHash });
        if (record.previousHash !== previousHash || record.hash !== expected) {
          return { valid: false, count: audit.length, head: audit.at(-1)?.hash ?? EMPTY_HASH };
        }
        previousHash = record.hash;
      }
      return { valid: true, count: audit.length, head: previousHash };
    },
    listAutomations: () => [...automations.values()].sort((a, b) => a.createdAt - b.createdAt).map(clone),
    getAutomation: (id) => {
      const definition = automations.get(id);
      return definition ? clone(definition) : undefined;
    },
    createAutomation(input, now = Date.now()) {
      const normalized = normalizeAutomationInput(input);
      if (!normalized) throw new Error("invalid automation");
      const definition: AutomationDefinition = {
        id: generateAutomationId(),
        ...normalized,
        enabled: normalized.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      };
      automations.set(definition.id, definition);
      return clone(definition);
    },
    updateAutomation(id, input, now = Date.now()) {
      const current = automations.get(id);
      if (!current) return undefined;
      const candidate = normalizeAutomationInput({ ...current, ...input });
      if (!candidate) throw new Error("invalid automation");
      const next = { ...current, ...candidate, enabled: candidate.enabled ?? current.enabled, updatedAt: now };
      automations.set(id, next);
      return clone(next);
    },
    removeAutomation: (id) => automations.delete(id),
    recordAutomationRun(input) {
      const run = { id: runs.length + 1, ...input };
      runs.push(run);
      if (runs.length > 10_000) runs.splice(0, runs.length - 10_000);
      return { ...run };
    },
    listAutomationRuns: (automationId, limit = 100) =>
      runs
        .filter((run) => automationId === undefined || run.automationId === automationId)
        .slice(-Math.max(1, Math.min(1000, limit)))
        .reverse()
        .map((run) => ({ ...run })),
    close() {
      idempotency.clear();
      audit.length = 0;
      automations.clear();
      runs.length = 0;
    },
  };
}

interface AuditRow {
  id: number;
  actor_type: AuditActorType;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  result: AuditResult;
  metadata_json: string;
  created_at: number;
  previous_hash: string;
  hash: string;
}

interface AutomationRow {
  id: string;
  name: string;
  enabled: number;
  trigger_json: string;
  action_json: string;
  permissions_json: string;
  created_at: number;
  updated_at: number;
}

function auditFromRow(row: AuditRow): AuditRecord {
  let metadata: AuditRecord["metadata"] = {};
  try {
    metadata = privacySafeAuditMetadata(JSON.parse(row.metadata_json) as Record<string, unknown>);
  } catch {
    /* corrupt metadata is omitted, while chain verification still uses the stored serialized record */
  }
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    ...(row.target_id ? { targetId: row.target_id } : {}),
    result: row.result,
    metadata,
    createdAt: row.created_at,
    previousHash: row.previous_hash,
    hash: row.hash,
  };
}

function automationFromRow(row: AutomationRow): AutomationDefinition | undefined {
  try {
    const normalized = normalizeAutomationInput({
      name: row.name,
      enabled: row.enabled === 1,
      trigger: JSON.parse(row.trigger_json),
      action: JSON.parse(row.action_json),
      permissions: JSON.parse(row.permissions_json),
    });
    return normalized
      ? {
          id: row.id,
          ...normalized,
          enabled: normalized.enabled ?? true,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export function openControlStore(opts: OpenControlStoreOptions): ControlStore {
  let Database: typeof import("better-sqlite3");
  try {
    if (opts.loadDatabase) Database = opts.loadDatabase();
    else {
      const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
      Database = (mod.default ?? mod) as typeof import("better-sqlite3");
    }
  } catch {
    return createMemoryStore(opts);
  }

  const db = new Database(opts.dbPath);
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
    CREATE TABLE IF NOT EXISTS control_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      result TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      previous_hash TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE
    );
    CREATE TRIGGER IF NOT EXISTS control_audit_no_update BEFORE UPDATE ON control_audit
      BEGIN SELECT RAISE(ABORT, 'audit records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS control_audit_no_delete BEFORE DELETE ON control_audit
      BEGIN SELECT RAISE(ABORT, 'audit records are append-only'); END;
    CREATE TABLE IF NOT EXISTS control_automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      trigger_json TEXT NOT NULL,
      action_json TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS control_automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id TEXT NOT NULL,
      event_id INTEGER,
      status TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS control_automation_runs_idx ON control_automation_runs(automation_id, id DESC);
  `);

  const getIdempotency = db.prepare(
    "SELECT actor_id, key, fingerprint, status_code, body, created_at, expires_at FROM control_idempotency WHERE actor_id=? AND key=?",
  );
  const putIdempotency = db.prepare(`
    INSERT INTO control_idempotency (actor_id, key, fingerprint, status_code, body, created_at, expires_at)
    VALUES (@actor_id, @key, @fingerprint, @status_code, @body, @created_at, @expires_at)
    ON CONFLICT(actor_id, key) DO NOTHING
  `);
  const pruneIdempotency = db.prepare("DELETE FROM control_idempotency WHERE expires_at <= ?");
  const auditHead = db.prepare("SELECT hash FROM control_audit ORDER BY id DESC LIMIT 1");
  const auditInsert = db.prepare(`
    INSERT INTO control_audit (
      actor_type, actor_id, action, target_type, target_id, result, metadata_json, created_at, previous_hash, hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const auditList = db.prepare("SELECT * FROM control_audit WHERE id > ? ORDER BY id ASC LIMIT ?");
  const auditLatest = db.prepare("SELECT * FROM control_audit ORDER BY id DESC LIMIT ?");
  const auditAll = db.prepare("SELECT * FROM control_audit ORDER BY id ASC");
  const automationList = db.prepare("SELECT * FROM control_automations ORDER BY created_at ASC, id ASC");
  const automationGet = db.prepare("SELECT * FROM control_automations WHERE id = ?");
  const automationInsert = db.prepare(`
    INSERT INTO control_automations (id, name, enabled, trigger_json, action_json, permissions_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const automationUpdate = db.prepare(`
    UPDATE control_automations SET name=?, enabled=?, trigger_json=?, action_json=?, permissions_json=?, updated_at=?
    WHERE id=?
  `);
  const automationDelete = db.prepare("DELETE FROM control_automations WHERE id = ?");
  const runInsert = db.prepare(
    "INSERT INTO control_automation_runs (automation_id, event_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const runsForAutomation = db.prepare(
    "SELECT * FROM control_automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?",
  );
  const runsAll = db.prepare("SELECT * FROM control_automation_runs ORDER BY id DESC LIMIT ?");
  const generateAutomationId = opts.generateAutomationId ?? randomId;

  return {
    mode: "sqlite",
    getIdempotency(actorId, key, now = Date.now()) {
      pruneIdempotency.run(now);
      const row = getIdempotency.get(actorId, key) as
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
    putIdempotency(record) {
      putIdempotency.run({
        actor_id: record.actorId,
        key: record.key,
        fingerprint: record.fingerprint,
        status_code: record.statusCode,
        body: record.body,
        created_at: record.createdAt,
        expires_at: record.expiresAt,
      });
    },
    appendAudit(input) {
      const metadata = privacySafeAuditMetadata(input.metadata);
      const previousHash = (auditHead.get() as { hash: string } | undefined)?.hash ?? EMPTY_HASH;
      const material = { ...input, metadata, previousHash };
      const hash = auditHash(material);
      const inserted = auditInsert.run(
        input.actorType,
        input.actorId,
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.result,
        JSON.stringify(metadata),
        input.createdAt,
        previousHash,
        hash,
      );
      return auditFromRow(
        db.prepare("SELECT * FROM control_audit WHERE id = ?").get(inserted.lastInsertRowid) as AuditRow,
      );
    },
    listAudit: (afterId = 0, limit = 500) =>
      (auditList.all(afterId, Math.max(1, Math.min(1000, Math.trunc(limit)))) as AuditRow[]).map(auditFromRow),
    listAuditLatest: (limit = 100) =>
      (auditLatest.all(Math.max(1, Math.min(1000, Math.trunc(limit)))) as AuditRow[]).map(auditFromRow),
    verifyAuditChain() {
      const rows = auditAll.all() as AuditRow[];
      let previousHash = EMPTY_HASH;
      for (const row of rows) {
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
        } catch {
          return { valid: false, count: rows.length, head: rows.at(-1)?.hash ?? EMPTY_HASH };
        }
        const expected = auditHash({
          actorType: row.actor_type,
          actorId: row.actor_id,
          action: row.action,
          targetType: row.target_type,
          ...(row.target_id ? { targetId: row.target_id } : {}),
          result: row.result,
          metadata: privacySafeAuditMetadata(metadata),
          createdAt: row.created_at,
          previousHash,
        });
        if (row.previous_hash !== previousHash || row.hash !== expected) {
          return { valid: false, count: rows.length, head: rows.at(-1)?.hash ?? EMPTY_HASH };
        }
        previousHash = row.hash;
      }
      return { valid: true, count: rows.length, head: previousHash };
    },
    listAutomations: () => (automationList.all() as AutomationRow[]).flatMap((row) => automationFromRow(row) ?? []),
    getAutomation(id) {
      const row = automationGet.get(id) as AutomationRow | undefined;
      return row ? automationFromRow(row) : undefined;
    },
    createAutomation(input, now = Date.now()) {
      const normalized = normalizeAutomationInput(input);
      if (!normalized) throw new Error("invalid automation");
      const id = generateAutomationId();
      automationInsert.run(
        id,
        normalized.name,
        normalized.enabled === false ? 0 : 1,
        JSON.stringify(normalized.trigger),
        JSON.stringify(normalized.action),
        JSON.stringify(normalized.permissions),
        now,
        now,
      );
      return automationFromRow(automationGet.get(id) as AutomationRow)!;
    },
    updateAutomation(id, input, now = Date.now()) {
      const currentRow = automationGet.get(id) as AutomationRow | undefined;
      const current = currentRow ? automationFromRow(currentRow) : undefined;
      if (!current) return undefined;
      const normalized = normalizeAutomationInput({ ...current, ...input });
      if (!normalized) throw new Error("invalid automation");
      automationUpdate.run(
        normalized.name,
        normalized.enabled === false ? 0 : 1,
        JSON.stringify(normalized.trigger),
        JSON.stringify(normalized.action),
        JSON.stringify(normalized.permissions),
        now,
        id,
      );
      return automationFromRow(automationGet.get(id) as AutomationRow)!;
    },
    removeAutomation: (id) => automationDelete.run(id).changes > 0,
    recordAutomationRun(input) {
      const result = runInsert.run(
        input.automationId,
        input.eventId ?? null,
        input.status,
        input.detail?.slice(0, 240) ?? null,
        input.createdAt,
      );
      return {
        id: Number(result.lastInsertRowid),
        ...input,
        ...(input.detail ? { detail: input.detail.slice(0, 240) } : {}),
      };
    },
    listAutomationRuns(automationId, limit = 100) {
      const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
      const rows = (
        automationId === undefined ? runsAll.all(safeLimit) : runsForAutomation.all(automationId, safeLimit)
      ) as Array<{
        id: number;
        automation_id: string;
        event_id: number | null;
        status: AutomationRun["status"];
        detail: string | null;
        created_at: number;
      }>;
      return rows.map((row) => ({
        id: row.id,
        automationId: row.automation_id,
        ...(row.event_id === null ? {} : { eventId: row.event_id }),
        status: row.status,
        ...(row.detail === null ? {} : { detail: row.detail }),
        createdAt: row.created_at,
      }));
    },
    close: () => db.close(),
  };
}

export const CONTROL_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
