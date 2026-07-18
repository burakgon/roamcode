import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

export type SessionAutomationStoreMode = "sqlite" | "memory-fallback";
export type AutomationOwnerType = "person" | "organization";
export type SessionAutomationTrigger = { type: "manual" };
export type SessionAutomationRunStatus = "starting" | "running" | "needs-input" | "ready" | "failed" | "cancelled";
export type SessionAutomationBootstrapState = "pending" | "submitting" | "submitted";
export type SessionAutomationBootstrapClaim = "claimed" | "already-started" | "missing";

export interface SessionAutomationDefinition {
  id: string;
  owner: { type: AutomationOwnerType; id: string };
  name: string;
  enabled: boolean;
  nodeId: string;
  agentRuntimeId: string;
  provider: string;
  cwd: string;
  instruction: string;
  runtimeOptions: Record<string, unknown>;
  trigger: SessionAutomationTrigger;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionAutomationRun {
  id: string;
  automationId: string;
  definitionRevision: number;
  invocationId: string;
  sessionId: string;
  nodeId: string;
  agentRuntimeId: string;
  cwd: string;
  status: SessionAutomationRunStatus;
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Private, immutable launch input captured with a Run. It is intentionally separate from SessionAutomationRun so
 * ordinary API projections cannot accidentally disclose instructions or provider launch options.
 */
export interface SessionAutomationRunInputSnapshot {
  runId: string;
  automationId: string;
  definitionRevision: number;
  provider: string;
  instruction: string;
  runtimeOptions: Record<string, unknown>;
  bootstrapState: SessionAutomationBootstrapState;
}

export interface CreateSessionAutomationRunInput {
  automationId: string;
  definitionRevision: number;
  invocationId: string;
  sessionId: string;
  nodeId: string;
  agentRuntimeId: string;
  cwd: string;
  /** Explicit values preserve the exact revision selected by a caller racing a later definition update. */
  provider?: string;
  instruction?: string;
  runtimeOptions?: Record<string, unknown>;
}

export interface CreateSessionAutomationInput {
  owner: { type: AutomationOwnerType; id: string };
  name: string;
  enabled?: boolean;
  nodeId: string;
  agentRuntimeId: string;
  provider: string;
  cwd: string;
  instruction: string;
  runtimeOptions?: Record<string, unknown>;
  trigger?: SessionAutomationTrigger;
}

export interface UpdateSessionAutomationInput {
  name?: string;
  enabled?: boolean;
  nodeId?: string;
  agentRuntimeId?: string;
  provider?: string;
  cwd?: string;
  instruction?: string;
  runtimeOptions?: Record<string, unknown>;
  trigger?: SessionAutomationTrigger;
}

export interface SessionAutomationStore {
  readonly mode: SessionAutomationStoreMode;
  getNodeOwner(nodeId: string): { type: AutomationOwnerType; id: string } | undefined;
  list(owner?: { type: AutomationOwnerType; id: string }): SessionAutomationDefinition[];
  get(id: string): SessionAutomationDefinition | undefined;
  getIncludingRemoved(id: string): SessionAutomationDefinition | undefined;
  create(input: CreateSessionAutomationInput, now?: number): SessionAutomationDefinition;
  update(
    id: string,
    input: UpdateSessionAutomationInput,
    expectedRevision: number,
    now?: number,
  ): SessionAutomationDefinition | undefined;
  transferOwner(
    from: { type: AutomationOwnerType; id: string },
    to: { type: AutomationOwnerType; id: string },
    nodeId: string,
    now?: number,
  ): number;
  remove(id: string): boolean;
  getRun(id: string): SessionAutomationRun | undefined;
  getRunInputSnapshot(id: string): SessionAutomationRunInputSnapshot | undefined;
  getRunByInvocationId(invocationId: string): SessionAutomationRun | undefined;
  getRunBySessionId(sessionId: string): SessionAutomationRun | undefined;
  createRun(input: CreateSessionAutomationRunInput, now?: number): SessionAutomationRun;
  beginRunBootstrap(id: string): SessionAutomationBootstrapClaim;
  completeRunBootstrap(id: string, now?: number): SessionAutomationRun | undefined;
  setRunStatus(
    id: string,
    status: Exclude<SessionAutomationRunStatus, "starting" | "failed">,
    now?: number,
  ): SessionAutomationRun | undefined;
  markRunFailed(id: string, failureCode: string, now?: number): SessionAutomationRun | undefined;
  listRuns(automationId?: string, limit?: number): SessionAutomationRun[];
  close(): void;
}

export interface OpenSessionAutomationStoreOptions {
  dbPath: string;
  generateAutomationId?: () => string;
  generateRunId?: () => string;
  loadDatabase?: () => typeof import("better-sqlite3");
}

export class SessionAutomationRevisionConflictError extends Error {
  constructor(readonly current: SessionAutomationDefinition) {
    super("session automation revision conflict");
    this.name = "SessionAutomationRevisionConflictError";
  }
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const SAFE_PROVIDER = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const UNSAFE_LABEL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const UNSAFE_INSTRUCTION = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_OPTIONS_BYTES = 64 * 1024;
const MAX_INSTRUCTION_BYTES = 32 * 1024;

function randomId(prefix: "rca2" | "rcar"): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`invalid ${field}`);
  return value;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new Error("automation name is required");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80 || UNSAFE_LABEL.test(name)) throw new Error("invalid automation name");
  return name;
}

function normalizeInstruction(value: unknown): string {
  if (typeof value !== "string") throw new Error("automation instruction is required");
  const instruction = value.trim();
  if (
    !instruction ||
    Buffer.byteLength(instruction, "utf8") > MAX_INSTRUCTION_BYTES ||
    UNSAFE_INSTRUCTION.test(instruction)
  ) {
    throw new Error("invalid automation instruction");
  }
  return instruction;
}

function normalizeProvider(value: unknown): string {
  if (typeof value !== "string" || !SAFE_PROVIDER.test(value)) throw new Error("invalid automation provider");
  return value;
}

function normalizeCwd(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("invalid automation cwd");
  const cwd = resolve(value);
  if (!cwd.startsWith("/")) throw new Error("invalid automation cwd");
  return cwd;
}

function normalizeOwner(value: unknown): { type: AutomationOwnerType; id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("automation owner is required");
  const raw = value as Record<string, unknown>;
  if (raw.type !== "person" && raw.type !== "organization") throw new Error("invalid automation owner");
  return { type: raw.type, id: normalizeId(raw.id, "automation owner id") };
}

function normalizeTrigger(value: unknown): SessionAutomationTrigger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid automation trigger");
  const raw = value as Record<string, unknown>;
  if (raw.type !== "manual" || Object.keys(raw).some((key) => key !== "type")) {
    throw new Error("invalid automation trigger");
  }
  return { type: "manual" };
}

function normalizeRuntimeOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid runtime options");
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("invalid runtime options");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_OPTIONS_BYTES) throw new Error("runtime options are too large");
  const parsed = JSON.parse(encoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid runtime options");
  return parsed as Record<string, unknown>;
}

function normalizeCreate(
  input: CreateSessionAutomationInput,
): Omit<SessionAutomationDefinition, "id" | "revision" | "createdAt" | "updatedAt"> {
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new Error("invalid automation enabled state");
  return {
    owner: normalizeOwner(input.owner),
    name: normalizeName(input.name),
    enabled: input.enabled ?? true,
    nodeId: normalizeId(input.nodeId, "node id"),
    agentRuntimeId: normalizeId(input.agentRuntimeId, "agent runtime id"),
    provider: normalizeProvider(input.provider),
    cwd: normalizeCwd(input.cwd),
    instruction: normalizeInstruction(input.instruction),
    runtimeOptions: normalizeRuntimeOptions(input.runtimeOptions ?? {}),
    trigger: normalizeTrigger(input.trigger ?? { type: "manual" }),
  };
}

function applyUpdate(
  current: SessionAutomationDefinition,
  input: UpdateSessionAutomationInput,
  now: number,
): SessionAutomationDefinition {
  const candidate: CreateSessionAutomationInput = {
    owner: current.owner,
    name: input.name ?? current.name,
    enabled: input.enabled ?? current.enabled,
    nodeId: input.nodeId ?? current.nodeId,
    agentRuntimeId: input.agentRuntimeId ?? current.agentRuntimeId,
    provider: input.provider ?? current.provider,
    cwd: input.cwd ?? current.cwd,
    instruction: input.instruction ?? current.instruction,
    runtimeOptions: input.runtimeOptions ?? current.runtimeOptions,
    trigger: input.trigger ?? current.trigger,
  };
  if (Object.values(input).some((value) => value === undefined) || typeof candidate.enabled !== "boolean") {
    throw new Error("invalid automation update");
  }
  return {
    ...normalizeCreate(candidate),
    id: current.id,
    revision: current.revision + 1,
    createdAt: current.createdAt,
    updatedAt: now,
  };
}

function normalizeFailureCode(value: unknown): string {
  if (typeof value !== "string" || !SAFE_FAILURE_CODE.test(value)) throw new Error("invalid failure code");
  return value;
}

function createMemoryStore(opts: OpenSessionAutomationStoreOptions): SessionAutomationStore {
  const definitions = new Map<string, SessionAutomationDefinition>();
  const removedDefinitions = new Set<string>();
  const runs = new Map<string, SessionAutomationRun>();
  const runInputSnapshots = new Map<string, SessionAutomationRunInputSnapshot>();
  const nodeOwners = new Map<string, { type: AutomationOwnerType; id: string }>();
  const generateAutomationId = opts.generateAutomationId ?? (() => randomId("rca2"));
  const generateRunId = opts.generateRunId ?? (() => randomId("rcar"));
  return {
    mode: "memory-fallback",
    getNodeOwner(nodeId) {
      const owner = nodeOwners.get(normalizeId(nodeId, "node id"));
      return owner ? clone(owner) : undefined;
    },
    list(owner) {
      return [...definitions.values()]
        .filter(
          (item) =>
            !removedDefinitions.has(item.id) &&
            (!owner || (item.owner.type === owner.type && item.owner.id === owner.id)),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
        .map(clone);
    },
    get(id) {
      if (removedDefinitions.has(id)) return undefined;
      const item = definitions.get(id);
      return item ? clone(item) : undefined;
    },
    getIncludingRemoved(id) {
      const item = definitions.get(id);
      return item ? clone(item) : undefined;
    },
    create(input, now = Date.now()) {
      const normalized = normalizeCreate(input);
      const id = normalizeId(generateAutomationId(), "automation id");
      if (definitions.has(id)) throw new Error("automation id already exists");
      const definition: SessionAutomationDefinition = {
        id,
        ...normalized,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      definitions.set(id, definition);
      return clone(definition);
    },
    update(id, input, expectedRevision, now = Date.now()) {
      if (removedDefinitions.has(id)) return undefined;
      const current = definitions.get(id);
      if (!current) return undefined;
      if (current.revision !== expectedRevision) throw new SessionAutomationRevisionConflictError(clone(current));
      const next = applyUpdate(current, input, now);
      definitions.set(id, next);
      return clone(next);
    },
    transferOwner(from, to, nodeId, now = Date.now()) {
      const normalizedFrom = normalizeOwner(from);
      const normalizedTo = normalizeOwner(to);
      const normalizedNodeId = normalizeId(nodeId, "node id");
      const persisted = nodeOwners.get(normalizedNodeId);
      if (persisted && (persisted.type !== normalizedFrom.type || persisted.id !== normalizedFrom.id)) {
        if (persisted.type === normalizedTo.type && persisted.id === normalizedTo.id) return 0;
        throw new Error("node automation owner conflict");
      }
      if (normalizedFrom.type === normalizedTo.type && normalizedFrom.id === normalizedTo.id) {
        nodeOwners.set(normalizedNodeId, normalizedTo);
        return 0;
      }
      let transferred = 0;
      for (const [id, current] of definitions) {
        if (
          current.nodeId !== normalizedNodeId ||
          current.owner.type !== normalizedFrom.type ||
          current.owner.id !== normalizedFrom.id
        ) {
          continue;
        }
        definitions.set(id, {
          ...current,
          owner: normalizedTo,
          revision: current.revision + 1,
          updatedAt: now,
        });
        transferred += 1;
      }
      nodeOwners.set(normalizedNodeId, normalizedTo);
      return transferred;
    },
    remove(id) {
      if (!definitions.has(id) || removedDefinitions.has(id)) return false;
      removedDefinitions.add(id);
      return true;
    },
    getRun(id) {
      const run = runs.get(id);
      return run ? clone(run) : undefined;
    },
    getRunInputSnapshot(id) {
      const snapshot = runInputSnapshots.get(id);
      return snapshot ? clone(snapshot) : undefined;
    },
    getRunByInvocationId(invocationId) {
      const run = [...runs.values()].find((candidate) => candidate.invocationId === invocationId);
      return run ? clone(run) : undefined;
    },
    getRunBySessionId(sessionId) {
      const run = [...runs.values()].find((candidate) => candidate.sessionId === sessionId);
      return run ? clone(run) : undefined;
    },
    createRun(input, now = Date.now()) {
      const definition = definitions.get(input.automationId);
      if (!definition || removedDefinitions.has(input.automationId)) {
        throw new Error("automation not found");
      }
      if (
        [...runs.values()].some((run) => run.sessionId === input.sessionId || run.invocationId === input.invocationId)
      ) {
        throw new Error("automation run identity already exists");
      }
      const id = normalizeId(generateRunId(), "automation run id");
      if (runs.has(id)) throw new Error("automation run id already exists");
      if (!Number.isSafeInteger(input.definitionRevision) || input.definitionRevision < 1) {
        throw new Error("invalid automation definition revision");
      }
      const run: SessionAutomationRun = {
        id,
        automationId: normalizeId(input.automationId, "automation id"),
        definitionRevision: input.definitionRevision,
        invocationId: normalizeId(input.invocationId, "invocation id"),
        sessionId: normalizeId(input.sessionId, "session id"),
        nodeId: normalizeId(input.nodeId, "node id"),
        agentRuntimeId: normalizeId(input.agentRuntimeId, "agent runtime id"),
        cwd: normalizeCwd(input.cwd),
        status: "starting",
        createdAt: now,
        updatedAt: now,
      };
      const snapshot: SessionAutomationRunInputSnapshot = {
        runId: run.id,
        automationId: run.automationId,
        definitionRevision: run.definitionRevision,
        provider: normalizeProvider(input.provider ?? definition.provider),
        instruction: normalizeInstruction(input.instruction ?? definition.instruction),
        runtimeOptions: normalizeRuntimeOptions(input.runtimeOptions ?? definition.runtimeOptions),
        bootstrapState: "pending",
      };
      runs.set(id, run);
      runInputSnapshots.set(id, snapshot);
      return clone(run);
    },
    beginRunBootstrap(id) {
      const snapshot = runInputSnapshots.get(id);
      if (!snapshot) return "missing";
      if (snapshot.bootstrapState !== "pending") return "already-started";
      runInputSnapshots.set(id, { ...snapshot, bootstrapState: "submitting" });
      return "claimed";
    },
    completeRunBootstrap(id, now = Date.now()) {
      const current = runs.get(id);
      const snapshot = runInputSnapshots.get(id);
      if (!current || current.status !== "starting" || snapshot?.bootstrapState !== "submitting") return undefined;
      const next: SessionAutomationRun = {
        ...current,
        status: "running",
        failureCode: undefined,
        updatedAt: now,
      };
      runs.set(id, next);
      runInputSnapshots.set(id, { ...snapshot, bootstrapState: "submitted" });
      return clone(next);
    },
    setRunStatus(id, status, now = Date.now()) {
      const current = runs.get(id);
      if (!current) return undefined;
      if (!(["running", "needs-input", "ready", "cancelled"] as const).includes(status)) {
        throw new Error("invalid automation run status");
      }
      const next: SessionAutomationRun = {
        ...current,
        status,
        failureCode: undefined,
        updatedAt: now,
      };
      runs.set(id, next);
      return clone(next);
    },
    markRunFailed(id, failureCode, now = Date.now()) {
      const current = runs.get(id);
      if (!current) return undefined;
      const next: SessionAutomationRun = {
        ...current,
        status: "failed",
        failureCode: normalizeFailureCode(failureCode),
        updatedAt: now,
      };
      runs.set(id, next);
      return clone(next);
    },
    listRuns(automationId, limit = 100) {
      const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
      return [...runs.values()]
        .filter((run) => !automationId || run.automationId === automationId)
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .slice(0, bounded)
        .map(clone);
    },
    close() {
      definitions.clear();
      removedDefinitions.clear();
      runs.clear();
      runInputSnapshots.clear();
      nodeOwners.clear();
    },
  };
}

interface DefinitionRow {
  id: string;
  owner_type: AutomationOwnerType;
  owner_id: string;
  name: string;
  enabled: number;
  node_id: string;
  agent_runtime_id: string;
  provider: string;
  cwd: string;
  instruction: string;
  runtime_options_json: string;
  trigger_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface RunRow {
  id: string;
  automation_id: string;
  definition_revision: number;
  invocation_id: string;
  session_id: string;
  node_id: string;
  agent_runtime_id: string;
  cwd: string;
  status: SessionAutomationRunStatus;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
}

interface RunInputSnapshotRow {
  run_id: string;
  automation_id: string;
  definition_revision: number;
  provider: string;
  instruction: string;
  runtime_options_json: string;
  bootstrap_state: SessionAutomationBootstrapState;
}

function definitionFromRow(row: DefinitionRow): SessionAutomationDefinition {
  return {
    id: row.id,
    owner: { type: row.owner_type, id: row.owner_id },
    name: row.name,
    enabled: row.enabled === 1,
    nodeId: row.node_id,
    agentRuntimeId: row.agent_runtime_id,
    provider: row.provider,
    cwd: row.cwd,
    instruction: row.instruction,
    runtimeOptions: JSON.parse(row.runtime_options_json) as Record<string, unknown>,
    trigger: normalizeTrigger(JSON.parse(row.trigger_json)),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row: RunRow): SessionAutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    definitionRevision: row.definition_revision,
    invocationId: row.invocation_id,
    sessionId: row.session_id,
    nodeId: row.node_id,
    agentRuntimeId: row.agent_runtime_id,
    cwd: row.cwd,
    status: row.status,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runInputSnapshotFromRow(row: RunInputSnapshotRow): SessionAutomationRunInputSnapshot {
  return {
    runId: row.run_id,
    automationId: row.automation_id,
    definitionRevision: row.definition_revision,
    provider: row.provider,
    instruction: row.instruction,
    runtimeOptions: JSON.parse(row.runtime_options_json) as Record<string, unknown>,
    bootstrapState: row.bootstrap_state,
  };
}

export function openSessionAutomationStore(opts: OpenSessionAutomationStoreOptions): SessionAutomationStore {
  let Database: typeof import("better-sqlite3");
  try {
    Database = (opts.loadDatabase ?? (() => require("better-sqlite3") as typeof import("better-sqlite3")))();
  } catch {
    return createMemoryStore(opts);
  }
  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_automations (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('person','organization')),
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      node_id TEXT NOT NULL,
      agent_runtime_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      instruction TEXT NOT NULL,
      runtime_options_json TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS session_automations_owner_idx
      ON session_automations(owner_type, owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS session_automation_node_owners (
      node_id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('person','organization')),
      owner_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES session_automations(id) ON DELETE CASCADE,
      definition_revision INTEGER NOT NULL,
      invocation_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL UNIQUE,
      node_id TEXT NOT NULL,
      agent_runtime_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('starting','running','needs-input','ready','failed','cancelled')),
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_automation_runs_automation_idx
      ON session_automation_runs(automation_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS session_automation_run_inputs (
      run_id TEXT PRIMARY KEY REFERENCES session_automation_runs(id) ON DELETE CASCADE,
      automation_id TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      provider TEXT NOT NULL,
      instruction TEXT NOT NULL,
      runtime_options_json TEXT NOT NULL,
      bootstrap_state TEXT NOT NULL DEFAULT 'pending'
        CHECK(bootstrap_state IN ('pending','submitting','submitted'))
    );
  `);
  const automationColumns = db.pragma("table_info(session_automations)") as Array<{ name: string }>;
  if (!automationColumns.some((column) => column.name === "deleted_at")) {
    db.exec("ALTER TABLE session_automations ADD COLUMN deleted_at INTEGER");
  }
  const runInputColumns = db.pragma("table_info(session_automation_run_inputs)") as Array<{ name: string }>;
  if (!runInputColumns.some((column) => column.name === "bootstrap_state")) {
    db.exec(
      "ALTER TABLE session_automation_run_inputs ADD COLUMN bootstrap_state TEXT NOT NULL DEFAULT 'pending' " +
        "CHECK(bootstrap_state IN ('pending','submitting','submitted'))",
    );
  }

  const generateAutomationId = opts.generateAutomationId ?? (() => randomId("rca2"));
  const generateRunId = opts.generateRunId ?? (() => randomId("rcar"));
  const getDefinition = db.prepare("SELECT * FROM session_automations WHERE id = ? AND deleted_at IS NULL");
  const getDefinitionIncludingRemoved = db.prepare("SELECT * FROM session_automations WHERE id = ?");
  const listAll = db.prepare("SELECT * FROM session_automations WHERE deleted_at IS NULL ORDER BY updated_at DESC, id");
  const listOwner = db.prepare(
    "SELECT * FROM session_automations WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id",
  );
  const insertDefinition = db.prepare(`
    INSERT INTO session_automations(
      id,owner_type,owner_id,name,enabled,node_id,agent_runtime_id,provider,cwd,instruction,
      runtime_options_json,trigger_json,revision,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const updateDefinition = db.prepare(`
    UPDATE session_automations SET
      name=?,enabled=?,node_id=?,agent_runtime_id=?,provider=?,cwd=?,instruction=?,runtime_options_json=?,
      trigger_json=?,revision=?,updated_at=?
    WHERE id=? AND revision=?
  `);
  const getRun = db.prepare("SELECT * FROM session_automation_runs WHERE id = ?");
  const selectRunInputSnapshot = db.prepare("SELECT * FROM session_automation_run_inputs WHERE run_id = ?");
  const getRunByInvocationId = db.prepare("SELECT * FROM session_automation_runs WHERE invocation_id = ?");
  const getRunBySessionId = db.prepare("SELECT * FROM session_automation_runs WHERE session_id = ?");
  const listRunsAll = db.prepare("SELECT * FROM session_automation_runs ORDER BY created_at DESC, id DESC LIMIT ?");
  const listRunsForAutomation = db.prepare(
    "SELECT * FROM session_automation_runs WHERE automation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
  );

  return {
    mode: "sqlite",
    getNodeOwner(nodeId) {
      const row = db
        .prepare("SELECT owner_type,owner_id FROM session_automation_node_owners WHERE node_id=?")
        .get(normalizeId(nodeId, "node id")) as { owner_type: AutomationOwnerType; owner_id: string } | undefined;
      return row ? { type: row.owner_type, id: row.owner_id } : undefined;
    },
    list(owner) {
      const rows = owner ? listOwner.all(owner.type, owner.id) : listAll.all();
      return (rows as DefinitionRow[]).map(definitionFromRow);
    },
    get(id) {
      const row = getDefinition.get(id) as DefinitionRow | undefined;
      return row ? definitionFromRow(row) : undefined;
    },
    getIncludingRemoved(id) {
      const row = getDefinitionIncludingRemoved.get(id) as DefinitionRow | undefined;
      return row ? definitionFromRow(row) : undefined;
    },
    create(input, now = Date.now()) {
      const normalized = normalizeCreate(input);
      const definition: SessionAutomationDefinition = {
        id: normalizeId(generateAutomationId(), "automation id"),
        ...normalized,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      insertDefinition.run(
        definition.id,
        definition.owner.type,
        definition.owner.id,
        definition.name,
        definition.enabled ? 1 : 0,
        definition.nodeId,
        definition.agentRuntimeId,
        definition.provider,
        definition.cwd,
        definition.instruction,
        JSON.stringify(definition.runtimeOptions),
        JSON.stringify(definition.trigger),
        definition.revision,
        definition.createdAt,
        definition.updatedAt,
      );
      return definition;
    },
    update(id, input, expectedRevision, now = Date.now()) {
      const row = getDefinition.get(id) as DefinitionRow | undefined;
      if (!row) return undefined;
      const current = definitionFromRow(row);
      if (current.revision !== expectedRevision) throw new SessionAutomationRevisionConflictError(current);
      const next = applyUpdate(current, input, now);
      const result = updateDefinition.run(
        next.name,
        next.enabled ? 1 : 0,
        next.nodeId,
        next.agentRuntimeId,
        next.provider,
        next.cwd,
        next.instruction,
        JSON.stringify(next.runtimeOptions),
        JSON.stringify(next.trigger),
        next.revision,
        next.updatedAt,
        next.id,
        expectedRevision,
      );
      if (result.changes !== 1) {
        const latest = getDefinition.get(id) as DefinitionRow | undefined;
        if (latest) throw new SessionAutomationRevisionConflictError(definitionFromRow(latest));
        return undefined;
      }
      return next;
    },
    transferOwner(from, to, nodeId, now = Date.now()) {
      const normalizedFrom = normalizeOwner(from);
      const normalizedTo = normalizeOwner(to);
      const normalizedNodeId = normalizeId(nodeId, "node id");
      return db.transaction(() => {
        const persisted = db
          .prepare("SELECT owner_type,owner_id FROM session_automation_node_owners WHERE node_id=?")
          .get(normalizedNodeId) as { owner_type: AutomationOwnerType; owner_id: string } | undefined;
        if (persisted && (persisted.owner_type !== normalizedFrom.type || persisted.owner_id !== normalizedFrom.id)) {
          if (persisted.owner_type === normalizedTo.type && persisted.owner_id === normalizedTo.id) return 0;
          throw new Error("node automation owner conflict");
        }
        if (normalizedFrom.type === normalizedTo.type && normalizedFrom.id === normalizedTo.id) {
          db.prepare(
            `INSERT INTO session_automation_node_owners(node_id,owner_type,owner_id,updated_at) VALUES(?,?,?,?)
             ON CONFLICT(node_id) DO NOTHING`,
          ).run(normalizedNodeId, normalizedTo.type, normalizedTo.id, now);
          return 0;
        }
        const changes = db
          .prepare(
            `UPDATE session_automations
             SET owner_type=?,owner_id=?,revision=revision+1,updated_at=?
             WHERE owner_type=? AND owner_id=? AND node_id=?`,
          )
          .run(
            normalizedTo.type,
            normalizedTo.id,
            now,
            normalizedFrom.type,
            normalizedFrom.id,
            normalizedNodeId,
          ).changes;
        db.prepare(
          `INSERT INTO session_automation_node_owners(node_id,owner_type,owner_id,updated_at) VALUES(?,?,?,?)
           ON CONFLICT(node_id) DO UPDATE SET owner_type=excluded.owner_type,owner_id=excluded.owner_id,updated_at=excluded.updated_at`,
        ).run(normalizedNodeId, normalizedTo.type, normalizedTo.id, now);
        return changes;
      })();
    },
    remove(id) {
      const now = Date.now();
      return (
        db
          .prepare("UPDATE session_automations SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL")
          .run(now, now, id).changes === 1
      );
    },
    getRun(id) {
      const row = getRun.get(id) as RunRow | undefined;
      return row ? runFromRow(row) : undefined;
    },
    getRunInputSnapshot(id) {
      const row = selectRunInputSnapshot.get(id) as RunInputSnapshotRow | undefined;
      return row ? runInputSnapshotFromRow(row) : undefined;
    },
    getRunByInvocationId(invocationId) {
      const row = getRunByInvocationId.get(invocationId) as RunRow | undefined;
      return row ? runFromRow(row) : undefined;
    },
    getRunBySessionId(sessionId) {
      const row = getRunBySessionId.get(sessionId) as RunRow | undefined;
      return row ? runFromRow(row) : undefined;
    },
    createRun(input, now = Date.now()) {
      return db.transaction(() => {
        const definitionRow = getDefinition.get(input.automationId) as DefinitionRow | undefined;
        if (!definitionRow) throw new Error("automation not found");
        const definition = definitionFromRow(definitionRow);
        if (!Number.isSafeInteger(input.definitionRevision) || input.definitionRevision < 1) {
          throw new Error("invalid automation definition revision");
        }
        const run: SessionAutomationRun = {
          id: normalizeId(generateRunId(), "automation run id"),
          automationId: normalizeId(input.automationId, "automation id"),
          definitionRevision: input.definitionRevision,
          invocationId: normalizeId(input.invocationId, "invocation id"),
          sessionId: normalizeId(input.sessionId, "session id"),
          nodeId: normalizeId(input.nodeId, "node id"),
          agentRuntimeId: normalizeId(input.agentRuntimeId, "agent runtime id"),
          cwd: normalizeCwd(input.cwd),
          status: "starting",
          createdAt: now,
          updatedAt: now,
        };
        const snapshot: SessionAutomationRunInputSnapshot = {
          runId: run.id,
          automationId: run.automationId,
          definitionRevision: run.definitionRevision,
          provider: normalizeProvider(input.provider ?? definition.provider),
          instruction: normalizeInstruction(input.instruction ?? definition.instruction),
          runtimeOptions: normalizeRuntimeOptions(input.runtimeOptions ?? definition.runtimeOptions),
          bootstrapState: "pending",
        };
        db.prepare(
          `INSERT INTO session_automation_runs(
            id,automation_id,definition_revision,invocation_id,session_id,node_id,agent_runtime_id,cwd,status,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          run.id,
          run.automationId,
          run.definitionRevision,
          run.invocationId,
          run.sessionId,
          run.nodeId,
          run.agentRuntimeId,
          run.cwd,
          run.status,
          run.createdAt,
          run.updatedAt,
        );
        db.prepare(
          `INSERT INTO session_automation_run_inputs(
            run_id,automation_id,definition_revision,provider,instruction,runtime_options_json,bootstrap_state
          ) VALUES(?,?,?,?,?,?,?)`,
        ).run(
          snapshot.runId,
          snapshot.automationId,
          snapshot.definitionRevision,
          snapshot.provider,
          snapshot.instruction,
          JSON.stringify(snapshot.runtimeOptions),
          snapshot.bootstrapState,
        );
        return run;
      })();
    },
    beginRunBootstrap(id) {
      const result = db
        .prepare(
          "UPDATE session_automation_run_inputs SET bootstrap_state='submitting' WHERE run_id=? AND bootstrap_state='pending'",
        )
        .run(id);
      if (result.changes === 1) return "claimed";
      return selectRunInputSnapshot.get(id) ? "already-started" : "missing";
    },
    completeRunBootstrap(id, now = Date.now()) {
      return db.transaction(() => {
        const snapshot = selectRunInputSnapshot.get(id) as RunInputSnapshotRow | undefined;
        if (!snapshot || snapshot.bootstrap_state !== "submitting") return undefined;
        const result = db
          .prepare(
            "UPDATE session_automation_runs SET status='running',failure_code=NULL,updated_at=? WHERE id=? AND status='starting'",
          )
          .run(now, id);
        if (result.changes !== 1) return undefined;
        const completed = db
          .prepare(
            "UPDATE session_automation_run_inputs SET bootstrap_state='submitted' WHERE run_id=? AND bootstrap_state='submitting'",
          )
          .run(id);
        if (completed.changes !== 1) throw new Error("automation bootstrap state conflict");
        return runFromRow(getRun.get(id) as RunRow);
      })();
    },
    setRunStatus(id, status, now = Date.now()) {
      if (!(["running", "needs-input", "ready", "cancelled"] as const).includes(status)) {
        throw new Error("invalid automation run status");
      }
      const result = db
        .prepare("UPDATE session_automation_runs SET status=?,failure_code=NULL,updated_at=? WHERE id=?")
        .run(status, now, id);
      if (result.changes !== 1) return undefined;
      return runFromRow(getRun.get(id) as RunRow);
    },
    markRunFailed(id, failureCode, now = Date.now()) {
      const normalized = normalizeFailureCode(failureCode);
      const result = db
        .prepare("UPDATE session_automation_runs SET status='failed',failure_code=?,updated_at=? WHERE id=?")
        .run(normalized, now, id);
      if (result.changes !== 1) return undefined;
      return runFromRow(getRun.get(id) as RunRow);
    },
    listRuns(automationId, limit = 100) {
      const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
      const rows = automationId ? listRunsForAutomation.all(automationId, bounded) : listRunsAll.all(bounded);
      return (rows as RunRow[]).map(runFromRow);
    },
    close() {
      db.close();
    },
  };
}
