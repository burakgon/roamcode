import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";

const require = createRequire(import.meta.url);

export type CommandCenterStoreMode = "sqlite" | "memory-fallback";
export type WorkspaceKind = "directory" | "worktree";
export type AgentActivity = "blocked" | "working" | "done" | "idle" | "ended" | "unknown";
export type AttentionKind = "blocked" | "done" | "error" | "file" | "policy";
export type AttentionState = "open" | "acknowledged" | "snoozed" | "resolved";

export interface HostRecord {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceRecord {
  id: string;
  label: string;
  cwd: string;
  kind: WorkspaceKind;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface SessionPlacement {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  createdAt: number;
}

export interface AgentRecord {
  id: string;
  sessionId: string;
  workspaceId: string;
  provider: string;
  activity: AgentActivity;
  createdAt: number;
  updatedAt: number;
}

export interface AttentionItem {
  id: string;
  workspaceId: string;
  sessionId: string;
  agentId: string;
  kind: AttentionKind;
  state: AttentionState;
  title: string;
  detail?: string;
  urgency: number;
  occurrenceCount: number;
  createdAt: number;
  updatedAt: number;
  acknowledgedAt?: number;
  snoozedUntil?: number;
  resolvedAt?: number;
}

export interface CommandEvent {
  id: number;
  type: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface CommandLayoutEnvelope {
  document: Record<string, unknown> | null;
  revision: number;
  updatedAt?: number;
}

export class CommandCenterRevisionConflictError extends Error {
  constructor(readonly current: CommandLayoutEnvelope) {
    super("command center revision conflict");
    this.name = "CommandCenterRevisionConflictError";
  }
}

export interface CreateWorkspaceInput {
  cwd: string;
  label?: string;
  kind?: WorkspaceKind;
}

export interface UpdateWorkspaceInput {
  label?: string;
  sortOrder?: number;
  archived?: boolean;
}

export interface UpsertAgentInput {
  sessionId: string;
  workspaceId: string;
  provider: string;
  activity: AgentActivity;
  createdAt: number;
}

export interface RecordAttentionInput {
  workspaceId: string;
  sessionId: string;
  agentId: string;
  kind: AttentionKind;
  title: string;
  detail?: string;
  urgency?: number;
  /** Stable transition identity, e.g. `blocked:<sessionId>`. Only one unresolved item exists per key. */
  dedupeKey: string;
}

export interface CommandCenterStore {
  readonly mode: CommandCenterStoreMode;
  getHost(): HostRecord;
  renameHost(label: string, now?: number): HostRecord;
  listWorkspaces(opts?: { includeArchived?: boolean }): WorkspaceRecord[];
  getWorkspace(id: string): WorkspaceRecord | undefined;
  createWorkspace(input: CreateWorkspaceInput, now?: number): WorkspaceRecord;
  updateWorkspace(id: string, input: UpdateWorkspaceInput, now?: number): WorkspaceRecord | undefined;
  ensureSession(sessionId: string, cwd: string, now?: number): SessionPlacement;
  placementForSession(sessionId: string): SessionPlacement | undefined;
  removeSession(sessionId: string, now?: number): void;
  upsertAgent(input: UpsertAgentInput, now?: number): AgentRecord;
  getAgent(id: string): AgentRecord | undefined;
  listAgents(): AgentRecord[];
  recordAttention(input: RecordAttentionInput, now?: number): AttentionItem;
  listAttention(opts?: { includeResolved?: boolean; includeSnoozed?: boolean; now?: number }): AttentionItem[];
  acknowledgeAttention(id: string, now?: number): AttentionItem | undefined;
  snoozeAttention(id: string, until: number, now?: number): AttentionItem | undefined;
  resolveAttention(id: string, now?: number): AttentionItem | undefined;
  resolveAttentionByDedupeKey(dedupeKey: string, now?: number): number;
  markSessionViewed(sessionId: string, now?: number): number;
  appendEvent(
    type: string,
    resourceType: string,
    resourceId: string,
    payload?: Record<string, unknown>,
    now?: number,
  ): CommandEvent;
  listEvents(afterId?: number, limit?: number): CommandEvent[];
  eventBounds(): { earliest: number; latest: number };
  subscribeEvents(listener: (event: CommandEvent) => void): () => void;
  getLayout(): CommandLayoutEnvelope;
  putLayout(document: Record<string, unknown>, expectedRevision: number, now?: number): CommandLayoutEnvelope;
  close(): void;
}

export interface OpenCommandCenterStoreOptions {
  dbPath: string;
  hostLabel?: string;
  generateHostId?: () => string;
  generateWorkspaceId?: () => string;
  generateAttentionId?: () => string;
  /** Test/embedding seam; throwing selects the non-durable in-memory fallback. */
  loadDatabase?: () => typeof import("better-sqlite3");
}

interface HostRow {
  id: string;
  label: string;
  created_at: number;
  updated_at: number;
}

interface WorkspaceRow {
  id: string;
  label: string;
  cwd: string;
  kind: WorkspaceKind;
  sort_order: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface PlacementRow {
  session_id: string;
  workspace_id: string;
  agent_id: string;
  created_at: number;
}

interface AgentRow {
  id: string;
  session_id: string;
  workspace_id: string;
  provider: string;
  activity: AgentActivity;
  created_at: number;
  updated_at: number;
}

interface AttentionRow {
  id: string;
  workspace_id: string;
  session_id: string;
  agent_id: string;
  kind: AttentionKind;
  state: AttentionState;
  title: string;
  detail: string | null;
  urgency: number;
  occurrence_count: number;
  dedupe_key: string;
  created_at: number;
  updated_at: number;
  acknowledged_at: number | null;
  snoozed_until: number | null;
  resolved_at: number | null;
}

interface EventRow {
  id: number;
  type: string;
  resource_type: string;
  resource_id: string;
  payload_json: string;
  created_at: number;
}

function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 80 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(label)) return undefined;
  return label;
}

function normalizeCwd(value: string): string {
  if (!value.trim()) throw new Error("workspace cwd is required");
  return resolve(value);
}

function defaultWorkspaceLabel(cwd: string): string {
  return basename(cwd) || cwd;
}

function randomId(prefix: "rch" | "rcw" | "rci"): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function agentIdForSession(sessionId: string): string {
  return `agent_${sessionId}`;
}

function hostFromRow(row: HostRow): HostRecord {
  return { id: row.id, label: row.label, createdAt: row.created_at, updatedAt: row.updated_at };
}

function workspaceFromRow(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    label: row.label,
    cwd: row.cwd,
    kind: row.kind,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
  };
}

function placementFromRow(row: PlacementRow): SessionPlacement {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    createdAt: row.created_at,
  };
}

function agentFromRow(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    activity: row.activity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attentionFromRow(row: AttentionRow): AttentionItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    kind: row.kind,
    state: row.state,
    title: row.title,
    ...(row.detail === null ? {} : { detail: row.detail }),
    urgency: row.urgency,
    occurrenceCount: row.occurrence_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.acknowledged_at === null ? {} : { acknowledgedAt: row.acknowledged_at }),
    ...(row.snoozed_until === null ? {} : { snoozedUntil: row.snoozed_until }),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  };
}

function eventFromRow(row: EventRow): CommandEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    /* an old/corrupt event remains observable with an empty payload */
  }
  return {
    id: row.id,
    type: row.type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload,
    createdAt: row.created_at,
  };
}

function urgencyFor(kind: AttentionKind): number {
  switch (kind) {
    case "blocked":
      return 100;
    case "error":
      return 90;
    case "policy":
      return 80;
    case "file":
      return 60;
    case "done":
      return 40;
  }
}

function withoutDedupeKey(item: AttentionItem & { dedupeKey: string }): AttentionItem {
  const publicItem: AttentionItem & { dedupeKey?: string } = { ...item };
  delete publicItem.dedupeKey;
  return publicItem;
}

function createMemoryStore(opts: OpenCommandCenterStoreOptions): CommandCenterStore {
  const now = Date.now();
  let host: HostRecord = {
    id: (opts.generateHostId ?? (() => randomId("rch")))(),
    label: normalizeLabel(opts.hostLabel) ?? "This host",
    createdAt: now,
    updatedAt: now,
  };
  const workspaces = new Map<string, WorkspaceRecord>();
  const placements = new Map<string, SessionPlacement>();
  const agents = new Map<string, AgentRecord>();
  const attention = new Map<string, AttentionItem & { dedupeKey: string }>();
  const events: CommandEvent[] = [];
  let layout: CommandLayoutEnvelope = { document: null, revision: 0 };
  const eventListeners = new Set<(event: CommandEvent) => void>();
  let nextEventId = 1;
  const generateWorkspaceId = opts.generateWorkspaceId ?? (() => randomId("rcw"));
  const generateAttentionId = opts.generateAttentionId ?? (() => randomId("rci"));

  const appendEvent = (
    type: string,
    resourceType: string,
    resourceId: string,
    payload: Record<string, unknown> = {},
    at = Date.now(),
  ): CommandEvent => {
    const event = { id: nextEventId++, type, resourceType, resourceId, payload: { ...payload }, createdAt: at };
    events.push(event);
    if (events.length > 10_000) events.splice(0, events.length - 10_000);
    for (const listener of eventListeners) {
      try {
        listener({ ...event, payload: { ...event.payload } });
      } catch {
        /* an observer must never roll back a product mutation */
      }
    }
    return event;
  };

  const createWorkspace = (input: CreateWorkspaceInput, at = Date.now()): WorkspaceRecord => {
    const cwd = normalizeCwd(input.cwd);
    const existing = [...workspaces.values()].find((workspace) => workspace.cwd === cwd);
    if (existing) return { ...existing };
    const workspace: WorkspaceRecord = {
      id: generateWorkspaceId(),
      label: normalizeLabel(input.label) ?? defaultWorkspaceLabel(cwd),
      cwd,
      kind: input.kind ?? "directory",
      sortOrder: workspaces.size,
      createdAt: at,
      updatedAt: at,
    };
    workspaces.set(workspace.id, workspace);
    appendEvent("workspace.created", "workspace", workspace.id, {}, at);
    return { ...workspace };
  };

  const mutateAttention = (
    id: string,
    state: AttentionState,
    at: number,
    extra: Partial<AttentionItem> = {},
  ): AttentionItem | undefined => {
    const item = attention.get(id);
    if (!item) return undefined;
    const next = { ...item, ...extra, state, updatedAt: at };
    attention.set(id, next);
    appendEvent(`attention.${state}`, "attention", id, { sessionId: item.sessionId }, at);
    return withoutDedupeKey(next);
  };

  return {
    mode: "memory-fallback",
    getHost: () => ({ ...host }),
    renameHost(label, at = Date.now()) {
      const normalized = normalizeLabel(label);
      if (!normalized) throw new Error("invalid host label");
      host = { ...host, label: normalized, updatedAt: at };
      appendEvent("host.updated", "host", host.id, { label: normalized }, at);
      return { ...host };
    },
    listWorkspaces: ({ includeArchived = false } = {}) =>
      [...workspaces.values()]
        .filter((workspace) => includeArchived || workspace.archivedAt === undefined)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
        .map((workspace) => ({ ...workspace })),
    getWorkspace: (id) => {
      const workspace = workspaces.get(id);
      return workspace ? { ...workspace } : undefined;
    },
    createWorkspace,
    updateWorkspace(id, input, at = Date.now()) {
      const workspace = workspaces.get(id);
      if (!workspace) return undefined;
      const label = input.label === undefined ? workspace.label : normalizeLabel(input.label);
      if (!label) throw new Error("invalid workspace label");
      const next: WorkspaceRecord = {
        ...workspace,
        label,
        sortOrder: input.sortOrder ?? workspace.sortOrder,
        updatedAt: at,
        ...(input.archived === true
          ? { archivedAt: at }
          : input.archived === false
            ? { archivedAt: undefined }
            : workspace.archivedAt === undefined
              ? {}
              : { archivedAt: workspace.archivedAt }),
      };
      workspaces.set(id, next);
      appendEvent("workspace.updated", "workspace", id, { archived: next.archivedAt !== undefined }, at);
      return { ...next };
    },
    ensureSession(sessionId, cwd, at = Date.now()) {
      const existing = placements.get(sessionId);
      if (existing) return { ...existing };
      const normalized = normalizeCwd(cwd);
      const workspace =
        [...workspaces.values()].find((candidate) => candidate.cwd === normalized) ?? createWorkspace({ cwd }, at);
      const placement = {
        sessionId,
        workspaceId: workspace.id,
        agentId: agentIdForSession(sessionId),
        createdAt: at,
      };
      placements.set(sessionId, placement);
      appendEvent("session.placed", "session", sessionId, { workspaceId: workspace.id }, at);
      return { ...placement };
    },
    placementForSession: (sessionId) => {
      const placement = placements.get(sessionId);
      return placement ? { ...placement } : undefined;
    },
    removeSession(sessionId, at = Date.now()) {
      const hadPlacement = placements.delete(sessionId);
      const agentId = agentIdForSession(sessionId);
      const hadAgent = agents.delete(agentId);
      let hadAttention = false;
      for (const [id, item] of attention) {
        if (item.sessionId === sessionId && item.resolvedAt === undefined) {
          hadAttention = true;
          mutateAttention(id, "resolved", at, { resolvedAt: at });
        }
      }
      if (!hadPlacement && !hadAgent && !hadAttention) return;
      appendEvent("session.removed", "session", sessionId, {}, at);
    },
    upsertAgent(input, at = Date.now()) {
      const id = agentIdForSession(input.sessionId);
      const existing = agents.get(id);
      const agent: AgentRecord = {
        id,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        activity: input.activity,
        createdAt: existing?.createdAt ?? input.createdAt,
        updatedAt: at,
      };
      agents.set(id, agent);
      if (!existing || existing.activity !== agent.activity) {
        appendEvent("agent.activity_changed", "agent", id, { activity: agent.activity }, at);
      }
      return { ...agent };
    },
    getAgent: (id) => {
      const agent = agents.get(id);
      return agent ? { ...agent } : undefined;
    },
    listAgents: () => [...agents.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((agent) => ({ ...agent })),
    recordAttention(input, at = Date.now()) {
      const existing = [...attention.values()].find(
        (item) => item.dedupeKey === input.dedupeKey && item.resolvedAt === undefined,
      );
      if (existing) {
        const updated = {
          ...existing,
          state: "open" as const,
          title: input.title,
          detail: input.detail,
          urgency: input.urgency ?? urgencyFor(input.kind),
          occurrenceCount: existing.occurrenceCount + 1,
          updatedAt: at,
          acknowledgedAt: undefined,
          snoozedUntil: undefined,
        };
        attention.set(existing.id, updated);
        appendEvent("attention.updated", "attention", existing.id, { kind: input.kind }, at);
        return withoutDedupeKey(updated);
      }
      const item: AttentionItem & { dedupeKey: string } = {
        id: generateAttentionId(),
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        kind: input.kind,
        state: "open",
        title: input.title,
        ...(input.detail ? { detail: input.detail } : {}),
        urgency: input.urgency ?? urgencyFor(input.kind),
        occurrenceCount: 1,
        dedupeKey: input.dedupeKey,
        createdAt: at,
        updatedAt: at,
      };
      attention.set(item.id, item);
      appendEvent("attention.created", "attention", item.id, { kind: item.kind, sessionId: item.sessionId }, at);
      return withoutDedupeKey(item);
    },
    listAttention: ({ includeResolved = false, includeSnoozed = false, now: at = Date.now() } = {}) =>
      [...attention.values()]
        .filter((item) => includeResolved || item.resolvedAt === undefined)
        .filter((item) => includeSnoozed || item.snoozedUntil === undefined || item.snoozedUntil <= at)
        .sort((a, b) => b.urgency - a.urgency || b.updatedAt - a.updatedAt)
        .map(withoutDedupeKey),
    acknowledgeAttention: (id, at = Date.now()) =>
      mutateAttention(id, "acknowledged", at, { acknowledgedAt: at, snoozedUntil: undefined }),
    snoozeAttention: (id, until, at = Date.now()) => {
      if (!Number.isFinite(until) || until <= at) throw new Error("snooze time must be in the future");
      return mutateAttention(id, "snoozed", at, { snoozedUntil: until });
    },
    resolveAttention: (id, at = Date.now()) => mutateAttention(id, "resolved", at, { resolvedAt: at }),
    resolveAttentionByDedupeKey(dedupeKey, at = Date.now()) {
      let count = 0;
      for (const [id, item] of attention) {
        if (item.dedupeKey !== dedupeKey || item.resolvedAt !== undefined) continue;
        mutateAttention(id, "resolved", at, { resolvedAt: at });
        count += 1;
      }
      return count;
    },
    markSessionViewed(sessionId, at = Date.now()) {
      let count = 0;
      for (const [id, item] of attention) {
        if (item.sessionId !== sessionId || item.kind !== "done" || item.resolvedAt !== undefined) continue;
        mutateAttention(id, "resolved", at, { resolvedAt: at });
        count += 1;
      }
      return count;
    },
    appendEvent,
    listEvents: (afterId = 0, limit = 500) =>
      events
        .filter((event) => event.id > afterId)
        .slice(0, Math.max(1, Math.min(1000, Math.trunc(limit))))
        .map((event) => ({ ...event, payload: { ...event.payload } })),
    eventBounds: () => ({ earliest: events[0]?.id ?? 0, latest: events.at(-1)?.id ?? 0 }),
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    getLayout: () => ({
      ...layout,
      document: layout.document === null ? null : JSON.parse(JSON.stringify(layout.document)),
    }),
    putLayout(document, expectedRevision, at = Date.now()) {
      if (expectedRevision !== layout.revision) throw new CommandCenterRevisionConflictError(this.getLayout());
      layout = { document: JSON.parse(JSON.stringify(document)), revision: layout.revision + 1, updatedAt: at };
      appendEvent("layout.updated", "layout", "shared", { revision: layout.revision }, at);
      return this.getLayout();
    },
    close() {
      eventListeners.clear();
      workspaces.clear();
      placements.clear();
      agents.clear();
      attention.clear();
      events.length = 0;
      layout = { document: null, revision: 0 };
    },
  };
}

export function openCommandCenterStore(opts: OpenCommandCenterStoreOptions): CommandCenterStore {
  let Database: typeof import("better-sqlite3");
  try {
    if (opts.loadDatabase) {
      Database = opts.loadDatabase();
    } else {
      const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
      Database = (mod.default ?? mod) as typeof import("better-sqlite3");
    }
  } catch {
    return createMemoryStore(opts);
  }

  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_host (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS command_workspaces (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      cwd TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('directory', 'worktree')),
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS command_session_placements (
      session_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES command_workspaces(id),
      agent_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS command_agents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL REFERENCES command_workspaces(id),
      provider TEXT NOT NULL,
      activity TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS command_attention (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES command_workspaces(id),
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      urgency INTEGER NOT NULL,
      occurrence_count INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      snoozed_until INTEGER,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS command_attention_open_idx
      ON command_attention(resolved_at, urgency DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS command_attention_dedupe_idx
      ON command_attention(dedupe_key, resolved_at);
    CREATE TABLE IF NOT EXISTS command_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS command_events_created_idx ON command_events(created_at);
    CREATE TABLE IF NOT EXISTS command_layout (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      document_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const generateHostId = opts.generateHostId ?? (() => randomId("rch"));
  const generateWorkspaceId = opts.generateWorkspaceId ?? (() => randomId("rcw"));
  const generateAttentionId = opts.generateAttentionId ?? (() => randomId("rci"));
  const hostGet = db.prepare("SELECT id, label, created_at, updated_at FROM command_host WHERE singleton = 1");
  const hostInsert = db.prepare(
    "INSERT INTO command_host (singleton, id, label, created_at, updated_at) VALUES (1, ?, ?, ?, ?)",
  );
  const hostUpdate = db.prepare("UPDATE command_host SET label = ?, updated_at = ? WHERE singleton = 1");
  const initialNow = Date.now();
  if (!hostGet.get()) {
    hostInsert.run(generateHostId(), normalizeLabel(opts.hostLabel) ?? "This host", initialNow, initialNow);
  }

  const workspaceList = db.prepare(
    "SELECT * FROM command_workspaces WHERE archived_at IS NULL ORDER BY sort_order ASC, created_at ASC",
  );
  const workspaceListAll = db.prepare("SELECT * FROM command_workspaces ORDER BY sort_order ASC, created_at ASC");
  const workspaceGet = db.prepare("SELECT * FROM command_workspaces WHERE id = ?");
  const workspaceByCwd = db.prepare("SELECT * FROM command_workspaces WHERE cwd = ?");
  const workspaceNextOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM command_workspaces");
  const workspaceInsert = db.prepare(`
    INSERT INTO command_workspaces (id, label, cwd, kind, sort_order, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  const workspaceUpdate = db.prepare(`
    UPDATE command_workspaces SET label = ?, sort_order = ?, updated_at = ?, archived_at = ? WHERE id = ?
  `);
  const placementGet = db.prepare("SELECT * FROM command_session_placements WHERE session_id = ?");
  const placementInsert = db.prepare(`
    INSERT INTO command_session_placements (session_id, workspace_id, agent_id, created_at) VALUES (?, ?, ?, ?)
  `);
  const placementDelete = db.prepare("DELETE FROM command_session_placements WHERE session_id = ?");
  const agentGet = db.prepare("SELECT * FROM command_agents WHERE id = ?");
  const agentBySessionGet = db.prepare("SELECT id FROM command_agents WHERE session_id = ?");
  const agentList = db.prepare("SELECT * FROM command_agents ORDER BY updated_at DESC, created_at DESC");
  const agentUpsert = db.prepare(`
    INSERT INTO command_agents (id, session_id, workspace_id, provider, activity, created_at, updated_at)
    VALUES (@id, @session_id, @workspace_id, @provider, @activity, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, provider=excluded.provider,
      activity=excluded.activity, updated_at=excluded.updated_at
  `);
  const agentDeleteBySession = db.prepare("DELETE FROM command_agents WHERE session_id = ?");
  const attentionGet = db.prepare("SELECT * FROM command_attention WHERE id = ?");
  const attentionByDedupe = db.prepare(
    "SELECT * FROM command_attention WHERE dedupe_key = ? AND resolved_at IS NULL ORDER BY created_at ASC LIMIT 1",
  );
  const attentionInsert = db.prepare(`
    INSERT INTO command_attention (
      id, workspace_id, session_id, agent_id, kind, state, title, detail, urgency, occurrence_count,
      dedupe_key, created_at, updated_at, acknowledged_at, snoozed_until, resolved_at
    ) VALUES (
      @id, @workspace_id, @session_id, @agent_id, @kind, @state, @title, @detail, @urgency, @occurrence_count,
      @dedupe_key, @created_at, @updated_at, NULL, NULL, NULL
    )
  `);
  const attentionReopen = db.prepare(`
    UPDATE command_attention SET state='open', title=?, detail=?, urgency=?, occurrence_count=occurrence_count+1,
      updated_at=?, acknowledged_at=NULL, snoozed_until=NULL WHERE id=?
  `);
  const attentionListOpen = db.prepare(`
    SELECT * FROM command_attention
    WHERE resolved_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?)
    ORDER BY urgency DESC, updated_at DESC
  `);
  const attentionListOpenWithSnoozed = db.prepare(`
    SELECT * FROM command_attention WHERE resolved_at IS NULL ORDER BY urgency DESC, updated_at DESC
  `);
  const attentionListAll = db.prepare("SELECT * FROM command_attention ORDER BY urgency DESC, updated_at DESC");
  const attentionStateUpdate = db.prepare(`
    UPDATE command_attention SET state=@state, updated_at=@updated_at, acknowledged_at=@acknowledged_at,
      snoozed_until=@snoozed_until, resolved_at=@resolved_at WHERE id=@id
  `);
  const attentionUnresolvedByDedupe = db.prepare(
    "SELECT id FROM command_attention WHERE dedupe_key = ? AND resolved_at IS NULL",
  );
  const attentionDoneBySession = db.prepare(
    "SELECT id FROM command_attention WHERE session_id = ? AND kind = 'done' AND resolved_at IS NULL",
  );
  const attentionUnresolvedBySession = db.prepare(
    "SELECT id FROM command_attention WHERE session_id = ? AND resolved_at IS NULL",
  );
  const eventInsert = db.prepare(
    "INSERT INTO command_events (type, resource_type, resource_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const eventsAfter = db.prepare("SELECT * FROM command_events WHERE id > ? ORDER BY id ASC LIMIT ?");
  const eventBoundsGet = db.prepare(
    "SELECT COALESCE(MIN(id), 0) AS earliest, COALESCE(MAX(id), 0) AS latest FROM command_events",
  );
  const eventsPrune = db.prepare(`
    DELETE FROM command_events WHERE id NOT IN (SELECT id FROM command_events ORDER BY id DESC LIMIT 10000)
  `);
  const eventListeners = new Set<(event: CommandEvent) => void>();
  const layoutGet = db.prepare("SELECT document_json, revision, updated_at FROM command_layout WHERE singleton = 1");
  const layoutInsert = db.prepare(
    "INSERT INTO command_layout (singleton, document_json, revision, updated_at) VALUES (1, ?, 1, ?)",
  );
  const layoutUpdate = db.prepare(
    "UPDATE command_layout SET document_json = ?, revision = revision + 1, updated_at = ? WHERE singleton = 1 AND revision = ?",
  );

  const readLayout = (): CommandLayoutEnvelope => {
    const row = layoutGet.get() as { document_json: string; revision: number; updated_at: number } | undefined;
    if (!row) return { document: null, revision: 0 };
    try {
      const document = JSON.parse(row.document_json) as Record<string, unknown>;
      return { document, revision: row.revision, updatedAt: row.updated_at };
    } catch {
      return { document: null, revision: row.revision, updatedAt: row.updated_at };
    }
  };

  const appendEvent = (
    type: string,
    resourceType: string,
    resourceId: string,
    payload: Record<string, unknown> = {},
    at = Date.now(),
  ): CommandEvent => {
    const result = eventInsert.run(type, resourceType, resourceId, JSON.stringify(payload), at);
    if (Number(result.lastInsertRowid) % 100 === 0) eventsPrune.run();
    const event = { id: Number(result.lastInsertRowid), type, resourceType, resourceId, payload, createdAt: at };
    for (const listener of eventListeners) {
      try {
        listener({ ...event, payload: { ...event.payload } });
      } catch {
        /* an observer must never roll back a product mutation */
      }
    }
    return event;
  };

  const createWorkspace = (input: CreateWorkspaceInput, at = Date.now()): WorkspaceRecord => {
    const cwd = normalizeCwd(input.cwd);
    const existing = workspaceByCwd.get(cwd) as WorkspaceRow | undefined;
    if (existing) return workspaceFromRow(existing);
    const id = generateWorkspaceId();
    const label = normalizeLabel(input.label) ?? defaultWorkspaceLabel(cwd);
    const nextOrder = Number((workspaceNextOrder.get() as { value: number }).value);
    workspaceInsert.run(id, label, cwd, input.kind ?? "directory", nextOrder, at, at);
    appendEvent("workspace.created", "workspace", id, {}, at);
    return workspaceFromRow(workspaceGet.get(id) as WorkspaceRow);
  };

  const ensureSessionTransaction = db.transaction((sessionId: string, cwd: string, at: number): SessionPlacement => {
    const current = placementGet.get(sessionId) as PlacementRow | undefined;
    if (current) return placementFromRow(current);
    const workspace = createWorkspace({ cwd }, at);
    const agentId = agentIdForSession(sessionId);
    placementInsert.run(sessionId, workspace.id, agentId, at);
    appendEvent("session.placed", "session", sessionId, { workspaceId: workspace.id }, at);
    return { sessionId, workspaceId: workspace.id, agentId, createdAt: at };
  });

  const mutateAttention = (
    id: string,
    state: AttentionState,
    at: number,
    values: { acknowledgedAt?: number; snoozedUntil?: number; resolvedAt?: number } = {},
  ): AttentionItem | undefined => {
    const current = attentionGet.get(id) as AttentionRow | undefined;
    if (!current) return undefined;
    attentionStateUpdate.run({
      id,
      state,
      updated_at: at,
      acknowledged_at: values.acknowledgedAt ?? current.acknowledged_at,
      snoozed_until: values.snoozedUntil ?? null,
      resolved_at: values.resolvedAt ?? current.resolved_at,
    });
    appendEvent(`attention.${state}`, "attention", id, { sessionId: current.session_id }, at);
    return attentionFromRow(attentionGet.get(id) as AttentionRow);
  };

  return {
    mode: "sqlite",
    getHost: () => hostFromRow(hostGet.get() as HostRow),
    renameHost(label, at = Date.now()) {
      const normalized = normalizeLabel(label);
      if (!normalized) throw new Error("invalid host label");
      hostUpdate.run(normalized, at);
      const host = hostFromRow(hostGet.get() as HostRow);
      appendEvent("host.updated", "host", host.id, { label: normalized }, at);
      return host;
    },
    listWorkspaces: ({ includeArchived = false } = {}) =>
      ((includeArchived ? workspaceListAll.all() : workspaceList.all()) as WorkspaceRow[]).map(workspaceFromRow),
    getWorkspace: (id) => {
      const row = workspaceGet.get(id) as WorkspaceRow | undefined;
      return row ? workspaceFromRow(row) : undefined;
    },
    createWorkspace,
    updateWorkspace(id, input, at = Date.now()) {
      const current = workspaceGet.get(id) as WorkspaceRow | undefined;
      if (!current) return undefined;
      const label = input.label === undefined ? current.label : normalizeLabel(input.label);
      if (!label) throw new Error("invalid workspace label");
      const archivedAt = input.archived === true ? at : input.archived === false ? null : current.archived_at;
      workspaceUpdate.run(label, input.sortOrder ?? current.sort_order, at, archivedAt, id);
      appendEvent("workspace.updated", "workspace", id, { archived: archivedAt !== null }, at);
      return workspaceFromRow(workspaceGet.get(id) as WorkspaceRow);
    },
    ensureSession: (sessionId, cwd, at = Date.now()) => ensureSessionTransaction.immediate(sessionId, cwd, at),
    placementForSession: (sessionId) => {
      const row = placementGet.get(sessionId) as PlacementRow | undefined;
      return row ? placementFromRow(row) : undefined;
    },
    removeSession(sessionId, at = Date.now()) {
      const transaction = db.transaction(() => {
        const placement = placementGet.get(sessionId) as PlacementRow | undefined;
        const agent = agentBySessionGet.get(sessionId) as { id: string } | undefined;
        const unresolved = attentionUnresolvedBySession.all(sessionId) as Array<{ id: string }>;
        if (!placement && !agent && unresolved.length === 0) return;
        for (const { id } of unresolved) mutateAttention(id, "resolved", at, { resolvedAt: at });
        agentDeleteBySession.run(sessionId);
        placementDelete.run(sessionId);
        appendEvent("session.removed", "session", sessionId, {}, at);
      });
      transaction.immediate();
    },
    upsertAgent(input, at = Date.now()) {
      const id = agentIdForSession(input.sessionId);
      const previous = agentGet.get(id) as AgentRow | undefined;
      agentUpsert.run({
        id,
        session_id: input.sessionId,
        workspace_id: input.workspaceId,
        provider: input.provider,
        activity: input.activity,
        created_at: previous?.created_at ?? input.createdAt,
        updated_at: at,
      });
      if (!previous || previous.activity !== input.activity) {
        appendEvent("agent.activity_changed", "agent", id, { activity: input.activity }, at);
      }
      return agentFromRow(agentGet.get(id) as AgentRow);
    },
    getAgent: (id) => {
      const row = agentGet.get(id) as AgentRow | undefined;
      return row ? agentFromRow(row) : undefined;
    },
    listAgents: () => (agentList.all() as AgentRow[]).map(agentFromRow),
    recordAttention(input, at = Date.now()) {
      const existing = attentionByDedupe.get(input.dedupeKey) as AttentionRow | undefined;
      if (existing) {
        attentionReopen.run(
          input.title,
          input.detail ?? null,
          input.urgency ?? urgencyFor(input.kind),
          at,
          existing.id,
        );
        appendEvent("attention.updated", "attention", existing.id, { kind: input.kind }, at);
        return attentionFromRow(attentionGet.get(existing.id) as AttentionRow);
      }
      const id = generateAttentionId();
      attentionInsert.run({
        id,
        workspace_id: input.workspaceId,
        session_id: input.sessionId,
        agent_id: input.agentId,
        kind: input.kind,
        state: "open",
        title: input.title,
        detail: input.detail ?? null,
        urgency: input.urgency ?? urgencyFor(input.kind),
        occurrence_count: 1,
        dedupe_key: input.dedupeKey,
        created_at: at,
        updated_at: at,
      });
      appendEvent("attention.created", "attention", id, { kind: input.kind, sessionId: input.sessionId }, at);
      return attentionFromRow(attentionGet.get(id) as AttentionRow);
    },
    listAttention: ({ includeResolved = false, includeSnoozed = false, now: at = Date.now() } = {}) => {
      const rows = includeResolved
        ? (attentionListAll.all() as AttentionRow[])
        : includeSnoozed
          ? (attentionListOpenWithSnoozed.all() as AttentionRow[])
          : (attentionListOpen.all(at) as AttentionRow[]);
      return rows.map(attentionFromRow);
    },
    acknowledgeAttention: (id, at = Date.now()) => mutateAttention(id, "acknowledged", at, { acknowledgedAt: at }),
    snoozeAttention: (id, until, at = Date.now()) => {
      if (!Number.isFinite(until) || until <= at) throw new Error("snooze time must be in the future");
      return mutateAttention(id, "snoozed", at, { snoozedUntil: until });
    },
    resolveAttention: (id, at = Date.now()) => mutateAttention(id, "resolved", at, { resolvedAt: at }),
    resolveAttentionByDedupeKey(dedupeKey, at = Date.now()) {
      const rows = attentionUnresolvedByDedupe.all(dedupeKey) as Array<{ id: string }>;
      for (const { id } of rows) mutateAttention(id, "resolved", at, { resolvedAt: at });
      return rows.length;
    },
    markSessionViewed(sessionId, at = Date.now()) {
      const rows = attentionDoneBySession.all(sessionId) as Array<{ id: string }>;
      for (const { id } of rows) mutateAttention(id, "resolved", at, { resolvedAt: at });
      return rows.length;
    },
    appendEvent,
    listEvents: (afterId = 0, limit = 500) =>
      (eventsAfter.all(afterId, Math.max(1, Math.min(1000, Math.trunc(limit)))) as EventRow[]).map(eventFromRow),
    eventBounds: () => eventBoundsGet.get() as { earliest: number; latest: number },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    getLayout: readLayout,
    putLayout(document, expectedRevision, at = Date.now()) {
      const serialized = JSON.stringify(document);
      let changed = 0;
      if (expectedRevision === 0 && !layoutGet.get()) {
        try {
          changed = layoutInsert.run(serialized, at).changes;
        } catch {
          changed = 0;
        }
      } else {
        changed = layoutUpdate.run(serialized, at, expectedRevision).changes;
      }
      if (changed === 0) throw new CommandCenterRevisionConflictError(readLayout());
      const next = readLayout();
      appendEvent("layout.updated", "layout", "shared", { revision: next.revision }, at);
      return next;
    },
    close: () => {
      eventListeners.clear();
      db.close();
    },
  };
}

/** Exposed for API adapters and tests; one current RoamCode session owns one current agent. */
export const currentAgentIdForSession = agentIdForSession;

/** Re-exported validation keeps transport and stores on one label contract. */
export const normalizeCommandCenterLabel = normalizeLabel;
