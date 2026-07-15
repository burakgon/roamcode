import { createRequire } from "node:module";
import { parseProviderOptions } from "./providers/options.js";
import type { CodexSessionOptions, ProviderId, ProviderSessionOptions } from "./providers/types.js";
import {
  normalizeSessionDefaults,
  SessionDefaultsConflictError,
  type SessionDefaults,
  type StoredSessionDefaults,
} from "./session-defaults.js";
const require = createRequire(import.meta.url);

export type StoredStatus = "running" | "dormant" | "errored" | "stopped";

export type SessionFileDirection = "sent" | "received";
export type SessionFileStorage = "managed" | "workspace";
export type SessionFileKind = "image" | "pdf" | "text" | "binary";

/** Durable metadata for one file exchanged in a terminal session. Bytes for `managed` files live in
 *  RoamCode's scratch directory; `workspace` files are references and are never deleted by the app. */
export interface StoredSessionFile {
  id: string;
  sessionId: string;
  direction: SessionFileDirection;
  storage: SessionFileStorage;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  kind: SessionFileKind;
  caption?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  derivedFromId?: string;
  hiddenAt?: number;
}

interface StoredSessionBase {
  id: string;
  cwd: string;
  status: StoredStatus;
  createdAt: number;
  lastActivityAt: number;
  /** Always "terminal" — the only session kind. Kept so rehydrate can filter/guard on it. */
  mode: "terminal";
  /** Optional user-set display name (PATCH /sessions/:id). Absent = unnamed (the UI shows the cwd). */
  name?: string;
}

export interface StoredClaudeSession extends StoredSessionBase {
  provider: "claude";
  externalAdapter?: never;
  dangerouslySkip: boolean;
  /** The USER-chosen spawn flags the session was created with (`--model`/`--effort`/`--permission-mode`/
   *  `--dangerously-skip-permissions`/`--add-dir …`) — everything EXCEPT the ephemeral per-session
   *  `--mcp-config`/`--settings` paths (those are regenerated per spawn). Persisted so a RESTART can
   *  respawn the ended session with the same settings instead of a bare claude. Absent = no extra flags. */
  spawnArgs?: string[];
  providerSessionId?: never;
  launchOptions?: never;
  integrationStatus?: never;
}

export interface StoredIntegrationStatus {
  attachments: "ready" | "degraded";
  activity: "ready" | "degraded";
  detail?: string;
}

export interface StoredCodexSession extends StoredSessionBase {
  provider: "codex";
  externalAdapter?: never;
  launchOptions: CodexSessionOptions;
  providerSessionId?: string;
  integrationStatus?: StoredIntegrationStatus;
  dangerouslySkip?: never;
  spawnArgs?: never;
}

export interface StoredExternalSession extends StoredSessionBase {
  provider: ProviderId;
  /** Discriminator that keeps additive third-party rows separate from rollback-readable built-in tables. */
  externalAdapter: true;
  launchOptions: ProviderSessionOptions;
  providerSessionId?: string;
  integrationStatus?: StoredIntegrationStatus;
  dangerouslySkip?: never;
  spawnArgs?: never;
}

export type StoredSession = StoredClaudeSession | StoredCodexSession | StoredExternalSession;

function isStoredExternalSession(session: StoredSession): session is StoredExternalSession {
  return session.externalAdapter === true;
}

function isStoredClaudeSession(session: StoredSession): session is StoredClaudeSession {
  return session.externalAdapter !== true && session.provider === "claude";
}

function isStoredCodexSession(session: StoredSession): session is StoredCodexSession {
  return session.externalAdapter !== true && session.provider === "codex";
}

/** How a store is actually backed: "sqlite" (durable) or "memory-fallback" (the native module failed to
 *  load — NOT durable across restarts). Surfaced so start.ts can warn loudly + /diag can report it. */
export type StoreMode = "sqlite" | "memory-fallback";

export interface SessionStore {
  /** Atomically claim a brand-new physical id. Rejects any existing owner without changing its data. */
  claimNew(session: StoredSession): void;
  upsert(session: StoredSession): void;
  /** True when any physical provider table owns the id, including corrupt or cross-table ambiguous rows. */
  has(id: string): boolean;
  get(id: string): StoredSession | undefined;
  list(): StoredSession[];
  setStatus(id: string, status: StoredStatus): void;
  touch(id: string, at: number): void;
  /** Set/clear a session's display name (undefined clears — the row's `name` goes back to NULL). */
  setName(id: string, name: string | undefined): void;
  /** Persist/clear the exact resumable identity for Codex sessions only. Claude rows are never touched. */
  setProviderSessionId(id: string, value: string | undefined): void;
  /** Claim a hidden, non-resumable identity pending exact-thread cross-check. */
  markProvisionalProviderSessionId(id: string, value: string): void;
  /** Remove only the matching hidden provisional identity. */
  clearProvisionalProviderSessionId(id: string, value: string): void;
  /** Atomically promote only the matching hidden provisional identity to resumable state. */
  commitProvisionalProviderSessionId(id: string, value: string): void;
  getSessionDefaults(): StoredSessionDefaults | undefined;
  putSessionDefaults(defaults: SessionDefaults, expectedRevision: number, updatedAt: number): StoredSessionDefaults;
  /** Server-owned last-launch write. Replaces the remembered choices and advances the revision atomically. */
  rememberSessionDefaults(defaults: SessionDefaults, updatedAt: number): StoredSessionDefaults;
  putFile(file: StoredSessionFile): void;
  getFile(sessionId: string, id: string): StoredSessionFile | undefined;
  listFiles(sessionId: string, includeHidden?: boolean): StoredSessionFile[];
  setFileHidden(sessionId: string, id: string, hiddenAt: number | undefined): void;
  deleteFile(sessionId: string, id: string): void;
  pruneFiles(expiredBefore: number): StoredSessionFile[];
  delete(id: string): void;
  close(): void;
  /** "sqlite" when better-sqlite3 loaded; "memory-fallback" when it didn't (non-durable). */
  readonly mode: StoreMode;
}

const concreteSessionStores = new WeakSet<object>();

/** Internal trust check used by security-sensitive capabilities; only stores opened by this module are accepted. */
export function isConcreteSessionStore(store: SessionStore): boolean {
  return concreteSessionStores.has(store);
}

function brandSessionStore(store: SessionStore): SessionStore {
  concreteSessionStores.add(store);
  return store;
}

export interface OpenSessionStoreOptions {
  /** Path to the SQLite file. ":memory:" uses an in-process DB. */
  dbPath: string;
  /** Injectable better-sqlite3 loader (the seam tests use to FORCE the in-memory fallback by throwing).
   *  Defaults to `require("better-sqlite3")`. */
  loadDatabase?: () => typeof import("better-sqlite3");
}

/** Row <-> StoredSession mapping (SQLite stores booleans as 0/1). */
interface LegacyRow {
  id: string;
  cwd: string;
  dangerously_skip: number;
  status: string;
  created_at: number;
  last_activity_at: number;
  mode: string | null;
  name: string | null;
  spawn_args: string | null;
}

interface ProviderRow {
  id: string;
  provider: string;
  cwd: string;
  status: string;
  created_at: number;
  last_activity_at: number;
  name: string | null;
  provider_session_id: string | null;
  launch_options_json: string;
  integration_status_json: string | null;
}

interface AppSettingRow {
  key: string;
  value_json: string;
  revision: number;
  updated_at: number;
}

interface SessionFileRow {
  id: string;
  session_id: string;
  direction: string;
  storage: string;
  name: string;
  path: string;
  mime_type: string;
  size: number;
  kind: string;
  caption: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  derived_from_id: string | null;
  hidden_at: number | null;
}

function sessionFileRowToStored(row: SessionFileRow): StoredSessionFile {
  return {
    id: row.id,
    sessionId: row.session_id,
    direction: row.direction as SessionFileDirection,
    storage: row.storage as SessionFileStorage,
    name: row.name,
    path: row.path,
    mimeType: row.mime_type,
    size: row.size,
    kind: row.kind as SessionFileKind,
    ...(row.caption ? { caption: row.caption } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    ...(row.derived_from_id ? { derivedFromId: row.derived_from_id } : {}),
    ...(row.hidden_at !== null ? { hiddenAt: row.hidden_at } : {}),
  };
}

/** Parse the stored spawn_args JSON back into a string[] — tolerant: a NULL, malformed, or non-array value
 *  (an ancient row, a hand-edited DB) yields undefined so the session simply respawns flag-less, never throws. */
function parseSpawnArgs(raw: string | null): string[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
  } catch {
    return undefined;
  }
}

function legacyRowToSession(r: LegacyRow): StoredClaudeSession {
  const spawnArgs = parseSpawnArgs(r.spawn_args);
  return {
    provider: "claude",
    id: r.id,
    cwd: r.cwd,
    dangerouslySkip: r.dangerously_skip === 1,
    status: r.status as StoredStatus,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
    mode: "terminal",
    // Only carry a REAL name — NULL/"" stays absent so consumers can `?? cwd` and toEqual-style tests
    // of unnamed rows don't grow a noise field.
    ...(typeof r.name === "string" && r.name.length > 0 ? { name: r.name } : {}),
    ...(spawnArgs && spawnArgs.length > 0 ? { spawnArgs } : {}),
  };
}

function parseCodexOptions(raw: unknown): CodexSessionOptions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid Codex launch options");
  }
  const { provider, ...options } = raw as Record<string, unknown>;
  if (provider !== "codex") throw new Error("Invalid Codex launch options provider");
  return parseProviderOptions("codex", options) as CodexSessionOptions;
}

function parseExternalOptions(raw: unknown, provider: string): ProviderSessionOptions {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider) || provider === "claude" || provider === "codex") {
    throw new Error("Invalid external provider id");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid external launch options");
  }
  const record = raw as Record<string, unknown>;
  if (record.provider !== provider || Buffer.byteLength(JSON.stringify(record), "utf8") > 16 * 1024) {
    throw new Error("Invalid external launch options provider");
  }
  const validate = (value: unknown, depth: number): boolean => {
    if (depth > 6) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 64 && value.every((item) => validate(item, depth + 1));
    if (typeof value !== "object") return false;
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length <= 64 &&
      entries.every(
        ([key, item]) =>
          /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) &&
          !["__proto__", "prototype", "constructor"].includes(key) &&
          validate(item, depth + 1),
      )
    );
  };
  if (!validate(record, 0)) throw new Error("Invalid external launch options value");
  return JSON.parse(JSON.stringify(record)) as ProviderSessionOptions;
}

function validateCodexOptions(options: ProviderSessionOptions): CodexSessionOptions {
  return parseCodexOptions(options);
}

function validateProviderSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 2048 ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  ) {
    throw new Error("Invalid provider session id");
  }
  return value;
}

function validateIntegrationStatus(value: unknown): StoredIntegrationStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid integration status");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some((key) => !["attachments", "activity", "detail"].includes(key)) ||
    (record.attachments !== "ready" && record.attachments !== "degraded") ||
    (record.activity !== "ready" && record.activity !== "degraded") ||
    (record.detail !== undefined && (typeof record.detail !== "string" || record.detail.length > 2048))
  ) {
    throw new Error("Invalid integration status");
  }
  return {
    attachments: record.attachments,
    activity: record.activity,
    ...(typeof record.detail === "string" && record.detail.length > 0 ? { detail: record.detail } : {}),
  };
}

function parseIntegrationStatus(raw: string | null): StoredIntegrationStatus | undefined {
  if (raw === null || raw.length === 0) return undefined;
  return validateIntegrationStatus(JSON.parse(raw) as unknown);
}

function providerRowToSession(r: ProviderRow): StoredCodexSession | undefined {
  try {
    if (r.provider !== "codex") return undefined;
    const launchOptions = parseCodexOptions(JSON.parse(r.launch_options_json) as unknown);
    const integrationStatus = parseIntegrationStatus(r.integration_status_json);
    return {
      provider: "codex",
      id: r.id,
      cwd: r.cwd,
      status: r.status as StoredStatus,
      createdAt: r.created_at,
      lastActivityAt: r.last_activity_at,
      mode: "terminal",
      launchOptions,
      ...(typeof r.name === "string" && r.name.length > 0 ? { name: r.name } : {}),
      ...(typeof r.provider_session_id === "string" && r.provider_session_id.length > 0
        ? { providerSessionId: r.provider_session_id }
        : {}),
      ...(integrationStatus ? { integrationStatus } : {}),
    };
  } catch {
    // Keep corrupt rows in SQLite for diagnostics, but never surface them to a launcher.
    return undefined;
  }
}

function externalRowToSession(r: ProviderRow): StoredExternalSession | undefined {
  try {
    const launchOptions = parseExternalOptions(JSON.parse(r.launch_options_json) as unknown, r.provider);
    const integrationStatus = parseIntegrationStatus(r.integration_status_json);
    return {
      provider: r.provider,
      externalAdapter: true,
      id: r.id,
      cwd: r.cwd,
      status: r.status as StoredStatus,
      createdAt: r.created_at,
      lastActivityAt: r.last_activity_at,
      mode: "terminal",
      launchOptions,
      ...(typeof r.name === "string" && r.name.length > 0 ? { name: r.name } : {}),
      ...(typeof r.provider_session_id === "string" && r.provider_session_id.length > 0
        ? { providerSessionId: r.provider_session_id }
        : {}),
      ...(integrationStatus ? { integrationStatus } : {}),
    };
  } catch {
    return undefined;
  }
}

function compareSessions(a: StoredSession, b: StoredSession): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function cloneSession(session: StoredSession): StoredSession {
  if (isStoredClaudeSession(session)) {
    return { ...session, ...(session.spawnArgs ? { spawnArgs: [...session.spawnArgs] } : {}) };
  }
  const cloned = {
    ...session,
    launchOptions: {
      ...session.launchOptions,
      ...(session.launchOptions.addDirs ? { addDirs: [...session.launchOptions.addDirs] } : {}),
    },
    ...(session.integrationStatus ? { integrationStatus: { ...session.integrationStatus } } : {}),
  };
  return cloned as StoredSession;
}

function cloneStoredSessionDefaults(value: StoredSessionDefaults): StoredSessionDefaults {
  return {
    defaults: normalizeSessionDefaults(value.defaults),
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
}

function cloneStoredSessionFile(value: StoredSessionFile): StoredSessionFile {
  return { ...value };
}

function appSettingRowToSessionDefaults(row: AppSettingRow | undefined): StoredSessionDefaults | undefined {
  if (!row) return undefined;
  try {
    return {
      defaults: normalizeSessionDefaults(JSON.parse(row.value_json) as unknown),
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  } catch {
    return undefined;
  }
}

/**
 * In-memory fallback used when the native better-sqlite3 module cannot load
 * (no toolchain / unsupported platform) so the server still boots. NOT durable
 * across process restarts — surfaced as a diagnostic by the caller.
 */
function inMemoryStore(): SessionStore {
  const map = new Map<string, StoredSession>();
  const files = new Map<string, StoredSessionFile>();
  const provisionalProviderSessionIds = new Map<string, string>();
  let sessionDefaults: StoredSessionDefaults | undefined;
  const write = (s: StoredSession): void => {
    provisionalProviderSessionIds.delete(s.id);
    if (isStoredExternalSession(s)) {
      const launchOptions = parseExternalOptions(s.launchOptions, s.provider);
      const integrationStatus = s.integrationStatus ? validateIntegrationStatus(s.integrationStatus) : undefined;
      const providerSessionId = validateProviderSessionId(s.providerSessionId);
      map.set(
        s.id,
        cloneSession({
          ...s,
          mode: "terminal",
          launchOptions,
          ...(providerSessionId ? { providerSessionId } : {}),
          ...(integrationStatus ? { integrationStatus } : {}),
        }),
      );
      return;
    }
    if (isStoredCodexSession(s)) {
      const launchOptions = validateCodexOptions(s.launchOptions);
      const integrationStatus = s.integrationStatus ? validateIntegrationStatus(s.integrationStatus) : undefined;
      const providerSessionId = validateProviderSessionId(s.providerSessionId);
      map.set(
        s.id,
        cloneSession({
          ...s,
          mode: "terminal",
          launchOptions,
          ...(providerSessionId ? { providerSessionId } : {}),
          ...(integrationStatus ? { integrationStatus } : {}),
        }),
      );
      return;
    }
    if (isStoredClaudeSession(s)) {
      map.set(s.id, cloneSession({ ...s, mode: "terminal" }));
      return;
    }
    throw new Error("Unknown session provider");
  };
  return {
    claimNew: (s) => {
      if (map.has(s.id)) throw new Error(`Session id ${s.id} already exists`);
      write(s);
    },
    upsert: (s) => {
      const existing = map.get(s.id);
      if (existing && existing.provider !== s.provider) {
        throw new Error(`Session id ${s.id} already belongs to ${existing.provider}`);
      }
      write(s);
    },
    has: (id) => map.has(id),
    get: (id) => {
      const v = map.get(id);
      return v ? cloneSession(v) : undefined;
    },
    list: () => [...map.values()].map(cloneSession).sort(compareSessions),
    setStatus: (id, status) => {
      const v = map.get(id);
      if (v) v.status = status;
    },
    touch: (id, at) => {
      const v = map.get(id);
      if (v) v.lastActivityAt = at;
    },
    setName: (id, name) => {
      const v = map.get(id);
      if (!v) return;
      if (name === undefined)
        delete v.name; // clear = the field goes back to absent, mirroring NULL
      else v.name = name;
    },
    setProviderSessionId: (id, value) => {
      const v = map.get(id);
      if (!v || v.provider === "claude") return;
      const providerSessionId = validateProviderSessionId(value);
      provisionalProviderSessionIds.delete(id);
      if (providerSessionId === undefined) delete v.providerSessionId;
      else v.providerSessionId = providerSessionId;
    },
    markProvisionalProviderSessionId: (id, value) => {
      const v = map.get(id);
      const providerSessionId = validateProviderSessionId(value);
      if (!v || v.provider !== "codex" || v.providerSessionId !== undefined || provisionalProviderSessionIds.has(id)) {
        throw new Error("Provisional provider identity unavailable");
      }
      provisionalProviderSessionIds.set(id, providerSessionId!);
    },
    clearProvisionalProviderSessionId: (id, value) => {
      if (provisionalProviderSessionIds.get(id) !== value) throw new Error("Provisional provider identity changed");
      provisionalProviderSessionIds.delete(id);
    },
    commitProvisionalProviderSessionId: (id, value) => {
      const v = map.get(id);
      if (
        !v ||
        v.provider !== "codex" ||
        v.providerSessionId !== undefined ||
        provisionalProviderSessionIds.get(id) !== value
      ) {
        throw new Error("Provisional provider identity changed");
      }
      v.providerSessionId = value;
      provisionalProviderSessionIds.delete(id);
    },
    getSessionDefaults: () => (sessionDefaults ? cloneStoredSessionDefaults(sessionDefaults) : undefined),
    putSessionDefaults: (defaults, expectedRevision, updatedAt) => {
      if ((sessionDefaults?.revision ?? 0) !== expectedRevision) {
        throw new SessionDefaultsConflictError(
          sessionDefaults ? cloneStoredSessionDefaults(sessionDefaults) : undefined,
        );
      }
      sessionDefaults = {
        defaults: normalizeSessionDefaults(defaults),
        revision: expectedRevision + 1,
        updatedAt,
      };
      return cloneStoredSessionDefaults(sessionDefaults);
    },
    rememberSessionDefaults: (defaults, updatedAt) => {
      sessionDefaults = {
        defaults: normalizeSessionDefaults(defaults),
        revision: (sessionDefaults?.revision ?? 0) + 1,
        updatedAt,
      };
      return cloneStoredSessionDefaults(sessionDefaults);
    },
    putFile: (file) => files.set(`${file.sessionId}:${file.id}`, cloneStoredSessionFile(file)),
    getFile: (sessionId, id) => {
      const value = files.get(`${sessionId}:${id}`);
      return value ? cloneStoredSessionFile(value) : undefined;
    },
    listFiles: (sessionId, includeHidden = false) =>
      [...files.values()]
        .filter((file) => file.sessionId === sessionId && (includeHidden || file.hiddenAt === undefined))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .map(cloneStoredSessionFile),
    setFileHidden: (sessionId, id, hiddenAt) => {
      const file = files.get(`${sessionId}:${id}`);
      if (!file) return;
      if (hiddenAt === undefined) delete file.hiddenAt;
      else file.hiddenAt = hiddenAt;
      file.updatedAt = Date.now();
    },
    deleteFile: (sessionId, id) => void files.delete(`${sessionId}:${id}`),
    pruneFiles: (expiredBefore) => {
      const removed: StoredSessionFile[] = [];
      for (const [key, file] of files) {
        if (file.expiresAt > expiredBefore) continue;
        removed.push(cloneStoredSessionFile(file));
        files.delete(key);
      }
      return removed;
    },
    delete: (id) => {
      provisionalProviderSessionIds.delete(id);
      map.delete(id);
      for (const [key, file] of files) if (file.sessionId === id) files.delete(key);
    },
    close: () => {
      provisionalProviderSessionIds.clear();
      map.clear();
      files.clear();
      sessionDefaults = undefined;
    },
    mode: "memory-fallback",
  };
}

export function openSessionStore(opts: OpenSessionStoreOptions): SessionStore {
  let Database: typeof import("better-sqlite3");
  try {
    // Dynamic require keeps the native dep out of the module graph until needed
    // and lets us fall back gracefully if the build is missing. Injectable so tests force the fallback.
    if (opts.loadDatabase) {
      Database = opts.loadDatabase();
    } else {
      const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
      Database = (mod.default ?? mod) as typeof import("better-sqlite3");
    }
  } catch {
    return brandSessionStore(inMemoryStore());
  }

  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      dangerously_skip INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'terminal',
      name TEXT
    )
  `);

  // TERMINAL-ONLY MIGRATION: a chat-era DB carries dead columns (model, effort, permission_mode,
  // display_name, context_window) and possibly stale mode!='terminal' rows the app never surfaces.
  // Drop the dead columns and prune the stale rows so the schema matches the terminal-only model. All
  // guarded (best-effort): on a FRESH DB the columns don't exist ("no such column"); on an ancient SQLite
  // DROP COLUMN may be unsupported — either way we swallow and boot with the columns simply unused.
  for (const col of ["model", "effort", "permission_mode", "display_name", "context_window"]) {
    try {
      db.exec(`ALTER TABLE sessions DROP COLUMN ${col}`);
    } catch {
      // column already gone (fresh DB) or DROP COLUMN unsupported — harmless, leave it be
    }
  }
  // A pre-`mode` (Plan-5) DB lacks the column entirely; add it so the prune + queries below work.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'terminal'");
  } catch {
    // column already exists — nothing to do
  }
  // Session-name migration: a pre-name DB gains the nullable column; existing rows read back name-less
  // (NULL → the field stays absent), so old sessions are simply "unnamed" — no backfill needed.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
  } catch {
    // column already exists — nothing to do
  }
  // spawn-args migration: the user's chosen spawn flags (JSON), so a RESTART can respawn an ended session
  // with the same model/effort/permission/danger/add-dir. A pre-spawn_args DB gains the nullable column;
  // existing rows read back NULL → those sessions respawn flag-less (the old behavior), no backfill needed.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN spawn_args TEXT");
  } catch {
    // column already exists — nothing to do
  }
  // Prune leftover non-terminal (chat) rows — never adopted or surfaced by the terminal app, just cruft.
  try {
    db.exec("DELETE FROM sessions WHERE mode IS NOT NULL AND mode != 'terminal'");
  } catch {
    // best-effort — never block boot on the prune
  }

  // Rollback-safe provider migration: Codex rows live only in this additive table. The legacy `sessions`
  // table remains byte-for-byte compatible with older builds, which continue to see Claude rows only.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider = 'codex'),
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      name TEXT,
      provider_session_id TEXT,
      provisional_provider_session_id TEXT,
      launch_options_json TEXT NOT NULL,
      integration_status_json TEXT
    );
    CREATE INDEX IF NOT EXISTS provider_sessions_activity_idx
      ON provider_sessions(last_activity_at DESC);

    CREATE TABLE IF NOT EXISTS external_provider_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      name TEXT,
      provider_session_id TEXT,
      launch_options_json TEXT NOT NULL,
      integration_status_json TEXT
    );
    CREATE INDEX IF NOT EXISTS external_provider_sessions_activity_idx
      ON external_provider_sessions(last_activity_at DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_files (
      id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('sent', 'received')),
      storage TEXT NOT NULL CHECK (storage IN ('managed', 'workspace')),
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'text', 'binary')),
      caption TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      derived_from_id TEXT,
      hidden_at INTEGER,
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS session_files_session_created_idx
      ON session_files(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS session_files_expiry_idx ON session_files(expires_at);
  `);
  try {
    db.exec("ALTER TABLE provider_sessions ADD COLUMN provisional_provider_session_id TEXT");
  } catch {
    // Column already exists on fresh/current databases.
  }
  // A previous process can only leave provisional state by terminating before cross-check/rollback.
  // It is never resumable and is safe to discard before this process accepts work.
  db.exec("UPDATE provider_sessions SET provisional_provider_session_id = NULL");

  const legacyUpsertStmt = db.prepare(`
    INSERT INTO sessions (id, cwd, dangerously_skip, status, created_at, last_activity_at, mode, name, spawn_args)
    VALUES (@id, @cwd, @dangerously_skip, @status, @created_at, @last_activity_at, @mode, @name, @spawn_args)
    ON CONFLICT(id) DO UPDATE SET
      cwd=excluded.cwd, dangerously_skip=excluded.dangerously_skip,
      status=excluded.status, created_at=excluded.created_at, last_activity_at=excluded.last_activity_at,
      mode=excluded.mode, name=excluded.name, spawn_args=excluded.spawn_args
  `);
  const providerUpsertStmt = db.prepare(`
    INSERT INTO provider_sessions (
      id, provider, cwd, status, created_at, last_activity_at, name,
      provider_session_id, provisional_provider_session_id, launch_options_json, integration_status_json
    ) VALUES (
      @id, @provider, @cwd, @status, @created_at, @last_activity_at, @name,
      @provider_session_id, NULL, @launch_options_json, @integration_status_json
    )
    ON CONFLICT(id) DO UPDATE SET
      provider=excluded.provider, cwd=excluded.cwd, status=excluded.status,
      created_at=excluded.created_at, last_activity_at=excluded.last_activity_at,
      name=excluded.name, provider_session_id=excluded.provider_session_id,
      provisional_provider_session_id=NULL, launch_options_json=excluded.launch_options_json,
      integration_status_json=excluded.integration_status_json
  `);
  const externalUpsertStmt = db.prepare(`
    INSERT INTO external_provider_sessions (
      id, provider, cwd, status, created_at, last_activity_at, name,
      provider_session_id, launch_options_json, integration_status_json
    ) VALUES (
      @id, @provider, @cwd, @status, @created_at, @last_activity_at, @name,
      @provider_session_id, @launch_options_json, @integration_status_json
    )
    ON CONFLICT(id) DO UPDATE SET
      provider=excluded.provider, cwd=excluded.cwd, status=excluded.status,
      created_at=excluded.created_at, last_activity_at=excluded.last_activity_at,
      name=excluded.name, provider_session_id=excluded.provider_session_id,
      launch_options_json=excluded.launch_options_json,
      integration_status_json=excluded.integration_status_json
  `);
  const legacyInsertStmt = db.prepare(`
    INSERT INTO sessions (id, cwd, dangerously_skip, status, created_at, last_activity_at, mode, name, spawn_args)
    VALUES (@id, @cwd, @dangerously_skip, @status, @created_at, @last_activity_at, @mode, @name, @spawn_args)
  `);
  const providerInsertStmt = db.prepare(`
    INSERT INTO provider_sessions (
      id, provider, cwd, status, created_at, last_activity_at, name,
      provider_session_id, provisional_provider_session_id, launch_options_json, integration_status_json
    ) VALUES (
      @id, @provider, @cwd, @status, @created_at, @last_activity_at, @name,
      @provider_session_id, NULL, @launch_options_json, @integration_status_json
    )
  `);
  const externalInsertStmt = db.prepare(`
    INSERT INTO external_provider_sessions (
      id, provider, cwd, status, created_at, last_activity_at, name,
      provider_session_id, launch_options_json, integration_status_json
    ) VALUES (
      @id, @provider, @cwd, @status, @created_at, @last_activity_at, @name,
      @provider_session_id, @launch_options_json, @integration_status_json
    )
  `);
  const legacyGetStmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const providerGetStmt = db.prepare("SELECT * FROM provider_sessions WHERE id = ?");
  const externalGetStmt = db.prepare("SELECT * FROM external_provider_sessions WHERE id = ?");
  const legacyListStmt = db.prepare("SELECT * FROM sessions");
  const providerListStmt = db.prepare("SELECT * FROM provider_sessions");
  const externalListStmt = db.prepare("SELECT * FROM external_provider_sessions");
  const legacyStatusStmt = db.prepare("UPDATE sessions SET status = ? WHERE id = ?");
  const providerStatusStmt = db.prepare("UPDATE provider_sessions SET status = ? WHERE id = ?");
  const externalStatusStmt = db.prepare("UPDATE external_provider_sessions SET status = ? WHERE id = ?");
  const legacyTouchStmt = db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?");
  const providerTouchStmt = db.prepare("UPDATE provider_sessions SET last_activity_at = ? WHERE id = ?");
  const externalTouchStmt = db.prepare("UPDATE external_provider_sessions SET last_activity_at = ? WHERE id = ?");
  const legacyNameStmt = db.prepare("UPDATE sessions SET name = ? WHERE id = ?");
  const providerNameStmt = db.prepare("UPDATE provider_sessions SET name = ? WHERE id = ?");
  const externalNameStmt = db.prepare("UPDATE external_provider_sessions SET name = ? WHERE id = ?");
  const providerSessionIdStmt = db.prepare(
    "UPDATE provider_sessions SET provider_session_id = ?, provisional_provider_session_id = NULL WHERE id = ?",
  );
  const externalSessionIdStmt = db.prepare(
    "UPDATE external_provider_sessions SET provider_session_id = ? WHERE id = ?",
  );
  const providerMarkProvisionalStmt = db.prepare(`
    UPDATE provider_sessions
    SET provisional_provider_session_id = ?
    WHERE id = ? AND provider_session_id IS NULL AND provisional_provider_session_id IS NULL
  `);
  const providerClearProvisionalStmt = db.prepare(`
    UPDATE provider_sessions
    SET provisional_provider_session_id = NULL
    WHERE id = ? AND provider_session_id IS NULL AND provisional_provider_session_id = ?
  `);
  const providerCommitProvisionalStmt = db.prepare(`
    UPDATE provider_sessions
    SET provider_session_id = ?, provisional_provider_session_id = NULL
    WHERE id = ? AND provider_session_id IS NULL AND provisional_provider_session_id = ?
  `);
  const legacyDeleteStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
  const providerDeleteStmt = db.prepare("DELETE FROM provider_sessions WHERE id = ?");
  const externalDeleteStmt = db.prepare("DELETE FROM external_provider_sessions WHERE id = ?");
  const sessionDefaultsGetStmt = db.prepare("SELECT * FROM app_settings WHERE key = 'session_defaults'");
  const sessionDefaultsPutStmt = db.prepare(`
    INSERT INTO app_settings (key, value_json, revision, updated_at)
    VALUES ('session_defaults', ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json=excluded.value_json, revision=excluded.revision, updated_at=excluded.updated_at
  `);
  const filePutStmt = db.prepare(`
    INSERT INTO session_files (
      id, session_id, direction, storage, name, path, mime_type, size, kind, caption,
      created_at, updated_at, expires_at, derived_from_id, hidden_at
    ) VALUES (
      @id, @session_id, @direction, @storage, @name, @path, @mime_type, @size, @kind, @caption,
      @created_at, @updated_at, @expires_at, @derived_from_id, @hidden_at
    ) ON CONFLICT(session_id, id) DO UPDATE SET
      direction=excluded.direction, storage=excluded.storage, name=excluded.name, path=excluded.path,
      mime_type=excluded.mime_type, size=excluded.size, kind=excluded.kind, caption=excluded.caption,
      updated_at=excluded.updated_at, expires_at=excluded.expires_at,
      derived_from_id=excluded.derived_from_id, hidden_at=excluded.hidden_at
  `);
  const fileGetStmt = db.prepare("SELECT * FROM session_files WHERE session_id = ? AND id = ?");
  const fileListStmt = db.prepare(
    "SELECT * FROM session_files WHERE session_id = ? AND hidden_at IS NULL ORDER BY created_at DESC, id DESC",
  );
  const fileListAllStmt = db.prepare(
    "SELECT * FROM session_files WHERE session_id = ? ORDER BY created_at DESC, id DESC",
  );
  const fileHideStmt = db.prepare(
    "UPDATE session_files SET hidden_at = ?, updated_at = ? WHERE session_id = ? AND id = ?",
  );
  const fileDeleteStmt = db.prepare("DELETE FROM session_files WHERE session_id = ? AND id = ?");
  const filesForSessionDeleteStmt = db.prepare("DELETE FROM session_files WHERE session_id = ?");
  const expiredFilesStmt = db.prepare("SELECT * FROM session_files WHERE expires_at <= ?");
  const pruneFilesStmt = db.prepare("DELETE FROM session_files WHERE expires_at <= ?");

  const physicalProviderOf = (id: string): string | undefined => {
    const legacy = legacyGetStmt.get(id);
    const provider = providerGetStmt.get(id) as ProviderRow | undefined;
    const external = externalGetStmt.get(id) as ProviderRow | undefined;
    const owners = [legacy ? "claude" : undefined, provider?.provider, external?.provider].filter(
      (value): value is string => value !== undefined,
    );
    if (owners.length === 0) return undefined;
    return owners.length === 1 ? owners[0] : "another provider";
  };

  const ownerOf = (id: string): "claude" | "codex" | "external" | undefined => {
    const hasLegacy = legacyGetStmt.get(id) !== undefined;
    const hasProvider = providerGetStmt.get(id) !== undefined;
    const hasExternal = externalGetStmt.get(id) !== undefined;
    // A cross-table id collision is ambiguous. Fail closed instead of mutating or launching the wrong owner.
    if (Number(hasLegacy) + Number(hasProvider) + Number(hasExternal) !== 1) return undefined;
    return hasLegacy ? "claude" : hasProvider ? "codex" : "external";
  };

  const upsertLegacyAtomically = db.transaction((s: StoredClaudeSession) => {
    const owner = physicalProviderOf(s.id);
    if (owner !== undefined && owner !== "claude") {
      throw new Error(`Session id ${s.id} already belongs to ${owner}`);
    }
    legacyUpsertStmt.run({
      id: s.id,
      cwd: s.cwd,
      dangerously_skip: s.dangerouslySkip ? 1 : 0,
      status: s.status,
      created_at: s.createdAt,
      last_activity_at: s.lastActivityAt,
      mode: s.mode ?? "terminal",
      name: s.name ?? null,
      spawn_args: s.spawnArgs && s.spawnArgs.length > 0 ? JSON.stringify(s.spawnArgs) : null,
    });
  });
  const upsertProviderAtomically = db.transaction(
    (
      s: StoredCodexSession,
      launchOptions: CodexSessionOptions,
      integrationStatus: StoredIntegrationStatus | undefined,
      providerSessionId: string | undefined,
    ) => {
      const owner = physicalProviderOf(s.id);
      if (owner !== undefined && owner !== "codex") {
        throw new Error(`Session id ${s.id} already belongs to ${owner}`);
      }
      providerUpsertStmt.run({
        id: s.id,
        provider: "codex",
        cwd: s.cwd,
        status: s.status,
        created_at: s.createdAt,
        last_activity_at: s.lastActivityAt,
        name: s.name ?? null,
        provider_session_id: providerSessionId ?? null,
        launch_options_json: JSON.stringify(launchOptions),
        integration_status_json: integrationStatus ? JSON.stringify(integrationStatus) : null,
      });
    },
  );
  const upsertExternalAtomically = db.transaction(
    (
      s: StoredExternalSession,
      launchOptions: ProviderSessionOptions,
      integrationStatus: StoredIntegrationStatus | undefined,
      providerSessionId: string | undefined,
    ) => {
      const owner = physicalProviderOf(s.id);
      if (owner !== undefined && owner !== s.provider) {
        throw new Error(`Session id ${s.id} already belongs to ${owner}`);
      }
      externalUpsertStmt.run({
        id: s.id,
        provider: s.provider,
        cwd: s.cwd,
        status: s.status,
        created_at: s.createdAt,
        last_activity_at: s.lastActivityAt,
        name: s.name ?? null,
        provider_session_id: providerSessionId ?? null,
        launch_options_json: JSON.stringify(launchOptions),
        integration_status_json: integrationStatus ? JSON.stringify(integrationStatus) : null,
      });
    },
  );
  const claimLegacyAtomically = db.transaction((s: StoredClaudeSession) => {
    if (
      legacyGetStmt.get(s.id) !== undefined ||
      providerGetStmt.get(s.id) !== undefined ||
      externalGetStmt.get(s.id) !== undefined
    ) {
      throw new Error(`Session id ${s.id} already exists`);
    }
    legacyInsertStmt.run({
      id: s.id,
      cwd: s.cwd,
      dangerously_skip: s.dangerouslySkip ? 1 : 0,
      status: s.status,
      created_at: s.createdAt,
      last_activity_at: s.lastActivityAt,
      mode: s.mode ?? "terminal",
      name: s.name ?? null,
      spawn_args: s.spawnArgs && s.spawnArgs.length > 0 ? JSON.stringify(s.spawnArgs) : null,
    });
  });
  const claimProviderAtomically = db.transaction(
    (
      s: StoredCodexSession,
      launchOptions: CodexSessionOptions,
      integrationStatus: StoredIntegrationStatus | undefined,
      providerSessionId: string | undefined,
    ) => {
      if (
        legacyGetStmt.get(s.id) !== undefined ||
        providerGetStmt.get(s.id) !== undefined ||
        externalGetStmt.get(s.id) !== undefined
      ) {
        throw new Error(`Session id ${s.id} already exists`);
      }
      providerInsertStmt.run({
        id: s.id,
        provider: "codex",
        cwd: s.cwd,
        status: s.status,
        created_at: s.createdAt,
        last_activity_at: s.lastActivityAt,
        name: s.name ?? null,
        provider_session_id: providerSessionId ?? null,
        launch_options_json: JSON.stringify(launchOptions),
        integration_status_json: integrationStatus ? JSON.stringify(integrationStatus) : null,
      });
    },
  );
  const claimExternalAtomically = db.transaction(
    (
      s: StoredExternalSession,
      launchOptions: ProviderSessionOptions,
      integrationStatus: StoredIntegrationStatus | undefined,
      providerSessionId: string | undefined,
    ) => {
      if (
        legacyGetStmt.get(s.id) !== undefined ||
        providerGetStmt.get(s.id) !== undefined ||
        externalGetStmt.get(s.id) !== undefined
      ) {
        throw new Error(`Session id ${s.id} already exists`);
      }
      externalInsertStmt.run({
        id: s.id,
        provider: s.provider,
        cwd: s.cwd,
        status: s.status,
        created_at: s.createdAt,
        last_activity_at: s.lastActivityAt,
        name: s.name ?? null,
        provider_session_id: providerSessionId ?? null,
        launch_options_json: JSON.stringify(launchOptions),
        integration_status_json: integrationStatus ? JSON.stringify(integrationStatus) : null,
      });
    },
  );
  const putSessionDefaultsAtomically = db.transaction(
    (defaults: SessionDefaults, expectedRevision: number, updatedAt: number): StoredSessionDefaults => {
      const row = sessionDefaultsGetStmt.get() as AppSettingRow | undefined;
      const current = appSettingRowToSessionDefaults(row);
      if (row !== undefined && current === undefined) {
        throw new SessionDefaultsConflictError(undefined);
      }
      if ((row?.revision ?? 0) !== expectedRevision) {
        throw new SessionDefaultsConflictError(current ? cloneStoredSessionDefaults(current) : undefined);
      }
      const stored = {
        defaults,
        revision: (row?.revision ?? 0) + 1,
        updatedAt,
      };
      sessionDefaultsPutStmt.run(JSON.stringify(defaults), stored.revision, updatedAt);
      return cloneStoredSessionDefaults(stored);
    },
  );
  const rememberSessionDefaultsAtomically = db.transaction(
    (defaults: SessionDefaults, updatedAt: number): StoredSessionDefaults => {
      const row = sessionDefaultsGetStmt.get() as AppSettingRow | undefined;
      const revision = Number.isSafeInteger(row?.revision) && (row?.revision ?? -1) >= 0 ? row!.revision + 1 : 1;
      const stored = { defaults, revision, updatedAt };
      sessionDefaultsPutStmt.run(JSON.stringify(defaults), revision, updatedAt);
      return cloneStoredSessionDefaults(stored);
    },
  );

  return brandSessionStore({
    claimNew: (s) => {
      if (isStoredExternalSession(s)) {
        const launchOptions = parseExternalOptions(s.launchOptions, s.provider);
        const integrationStatus = s.integrationStatus ? validateIntegrationStatus(s.integrationStatus) : undefined;
        const providerSessionId = validateProviderSessionId(s.providerSessionId);
        claimExternalAtomically.immediate(s, launchOptions, integrationStatus, providerSessionId);
        return;
      }
      if (isStoredClaudeSession(s)) {
        claimLegacyAtomically.immediate(s);
        return;
      }
      if (isStoredCodexSession(s)) {
        const launchOptions = validateCodexOptions(s.launchOptions);
        const integrationStatus = s.integrationStatus ? validateIntegrationStatus(s.integrationStatus) : undefined;
        const providerSessionId = validateProviderSessionId(s.providerSessionId);
        claimProviderAtomically.immediate(s, launchOptions, integrationStatus, providerSessionId);
        return;
      }
      throw new Error("Unknown session provider");
    },
    upsert: (s) => {
      if (isStoredExternalSession(s)) {
        const launchOptions = parseExternalOptions(s.launchOptions, s.provider);
        const integrationStatus = s.integrationStatus ? validateIntegrationStatus(s.integrationStatus) : undefined;
        const providerSessionId = validateProviderSessionId(s.providerSessionId);
        upsertExternalAtomically.immediate(s, launchOptions, integrationStatus, providerSessionId);
        return;
      }
      if (isStoredClaudeSession(s)) {
        upsertLegacyAtomically.immediate(s);
        return;
      }
      if (isStoredCodexSession(s)) {
        const launchOptions = validateCodexOptions(s.launchOptions);
        const integrationStatus = s.integrationStatus ? validateIntegrationStatus(s.integrationStatus) : undefined;
        const providerSessionId = validateProviderSessionId(s.providerSessionId);
        upsertProviderAtomically.immediate(s, launchOptions, integrationStatus, providerSessionId);
        return;
      }
      throw new Error("Unknown session provider");
    },
    has: (id) =>
      legacyGetStmt.get(id) !== undefined ||
      providerGetStmt.get(id) !== undefined ||
      externalGetStmt.get(id) !== undefined,
    get: (id) => {
      const owner = ownerOf(id);
      if (owner === "claude") {
        return legacyRowToSession(legacyGetStmt.get(id) as LegacyRow);
      }
      if (owner === "codex") {
        return providerRowToSession(providerGetStmt.get(id) as ProviderRow);
      }
      if (owner === "external") return externalRowToSession(externalGetStmt.get(id) as ProviderRow);
      return undefined;
    },
    list: () => {
      const legacyRows = legacyListStmt.all() as LegacyRow[];
      const providerRows = providerListStmt.all() as ProviderRow[];
      const externalRows = externalListStmt.all() as ProviderRow[];
      const counts = new Map<string, number>();
      for (const row of [...legacyRows, ...providerRows, ...externalRows])
        counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
      const ambiguousIds = new Set([...counts].filter(([, count]) => count !== 1).map(([id]) => id));
      const legacy = legacyRows.filter((row) => !ambiguousIds.has(row.id)).map(legacyRowToSession);
      const provider = providerRows
        .filter((row) => !ambiguousIds.has(row.id))
        .map(providerRowToSession)
        .filter((session): session is StoredCodexSession => session !== undefined);
      const external = externalRows
        .filter((row) => !ambiguousIds.has(row.id))
        .map(externalRowToSession)
        .filter((session): session is StoredExternalSession => session !== undefined);
      return [...legacy, ...provider, ...external].sort(compareSessions);
    },
    setStatus: (id, status) => {
      const owner = ownerOf(id);
      if (owner === "claude") legacyStatusStmt.run(status, id);
      else if (owner === "codex") providerStatusStmt.run(status, id);
      else if (owner === "external") externalStatusStmt.run(status, id);
    },
    touch: (id, at) => {
      const owner = ownerOf(id);
      if (owner === "claude") legacyTouchStmt.run(at, id);
      else if (owner === "codex") providerTouchStmt.run(at, id);
      else if (owner === "external") externalTouchStmt.run(at, id);
    },
    setName: (id, name) => {
      const owner = ownerOf(id);
      if (owner === "claude") legacyNameStmt.run(name ?? null, id);
      else if (owner === "codex") providerNameStmt.run(name ?? null, id);
      else if (owner === "external") externalNameStmt.run(name ?? null, id);
    },
    setProviderSessionId: (id, value) => {
      const owner = ownerOf(id);
      if (owner === "codex") providerSessionIdStmt.run(validateProviderSessionId(value) ?? null, id);
      else if (owner === "external") externalSessionIdStmt.run(validateProviderSessionId(value) ?? null, id);
    },
    markProvisionalProviderSessionId: (id, value) => {
      const providerSessionId = validateProviderSessionId(value)!;
      if (providerMarkProvisionalStmt.run(providerSessionId, id).changes !== 1) {
        throw new Error("Provisional provider identity unavailable");
      }
    },
    clearProvisionalProviderSessionId: (id, value) => {
      if (providerClearProvisionalStmt.run(id, validateProviderSessionId(value)!).changes !== 1) {
        throw new Error("Provisional provider identity changed");
      }
    },
    commitProvisionalProviderSessionId: (id, value) => {
      const providerSessionId = validateProviderSessionId(value)!;
      if (providerCommitProvisionalStmt.run(providerSessionId, id, providerSessionId).changes !== 1) {
        throw new Error("Provisional provider identity changed");
      }
    },
    getSessionDefaults: () => appSettingRowToSessionDefaults(sessionDefaultsGetStmt.get() as AppSettingRow | undefined),
    putSessionDefaults: (defaults, expectedRevision, updatedAt) =>
      putSessionDefaultsAtomically.immediate(normalizeSessionDefaults(defaults), expectedRevision, updatedAt),
    rememberSessionDefaults: (defaults, updatedAt) =>
      rememberSessionDefaultsAtomically.immediate(normalizeSessionDefaults(defaults), updatedAt),
    putFile: (file) => {
      filePutStmt.run({
        id: file.id,
        session_id: file.sessionId,
        direction: file.direction,
        storage: file.storage,
        name: file.name,
        path: file.path,
        mime_type: file.mimeType,
        size: file.size,
        kind: file.kind,
        caption: file.caption ?? null,
        created_at: file.createdAt,
        updated_at: file.updatedAt,
        expires_at: file.expiresAt,
        derived_from_id: file.derivedFromId ?? null,
        hidden_at: file.hiddenAt ?? null,
      });
    },
    getFile: (sessionId, id) => {
      const row = fileGetStmt.get(sessionId, id) as SessionFileRow | undefined;
      return row ? sessionFileRowToStored(row) : undefined;
    },
    listFiles: (sessionId, includeHidden = false) => {
      const rows = (includeHidden ? fileListAllStmt.all(sessionId) : fileListStmt.all(sessionId)) as SessionFileRow[];
      return rows.map(sessionFileRowToStored);
    },
    setFileHidden: (sessionId, id, hiddenAt) => fileHideStmt.run(hiddenAt ?? null, Date.now(), sessionId, id),
    deleteFile: (sessionId, id) => void fileDeleteStmt.run(sessionId, id),
    pruneFiles: (expiredBefore) => {
      const rows = expiredFilesStmt.all(expiredBefore) as SessionFileRow[];
      pruneFilesStmt.run(expiredBefore);
      return rows.map(sessionFileRowToStored);
    },
    delete: (id) => {
      const owner = ownerOf(id);
      if (owner === "claude") legacyDeleteStmt.run(id);
      else if (owner === "codex") providerDeleteStmt.run(id);
      else if (owner === "external") externalDeleteStmt.run(id);
      filesForSessionDeleteStmt.run(id);
    },
    close: () => db.close(),
    mode: "sqlite",
  });
}
