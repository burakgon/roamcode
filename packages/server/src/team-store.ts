import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type TeamStoreMode = "sqlite" | "memory-fallback";
export type TeamMemberKind = "person" | "service";
export type TeamMemberStatus = "active" | "suspended" | "removed";
export type TeamRole =
  | "viewer"
  | "operator"
  | "node-admin"
  | "workspace-manager"
  | "extension-manager"
  | "policy-admin"
  | "organization-admin";
export type TeamScopeType = "team" | "host" | "workspace";
export type TeamPrincipalType = "device" | "host" | "local";
export type TeamPermission =
  | "team:read"
  | "sessions:read"
  | "sessions:operate"
  | "attention:read"
  | "attention:manage"
  | "presence:read"
  | "presence:write"
  | "workspaces:manage"
  | "extensions:manage"
  | "policy:manage"
  | "members:manage"
  | "node-access:manage"
  | "audit:read"
  | "fleet:read";

export interface TeamRecord {
  id: string;
  name: string;
  authorizationEnabled: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TeamMember {
  id: string;
  displayName: string;
  kind: TeamMemberKind;
  status: TeamMemberStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TeamRoleBinding {
  id: string;
  memberId: string;
  role: TeamRole;
  scopeType: TeamScopeType;
  scopeId?: string;
  createdAt: number;
}

export interface TeamPrincipalBinding {
  actorType: TeamPrincipalType;
  actorId: string;
  memberId: string;
  createdAt: number;
}

export interface TeamAuthorizationResource {
  hostId?: string;
  workspaceId?: string;
}

export interface TeamAuthorizationDecision {
  allowed: boolean;
  reason: "local-break-glass" | "not-enforced" | "unbound" | "inactive" | "role" | "missing-permission";
  member?: TeamMember;
  roles: TeamRole[];
}

export interface TeamStore {
  readonly mode: TeamStoreMode;
  getTeam(): TeamRecord | null;
  createTeam(
    input: {
      name: string;
      ownerName: string;
      ownerPrincipal: { actorType: TeamPrincipalType; actorId: string };
    },
    now?: number,
  ): { team: TeamRecord; owner: TeamMember };
  updateTeam(
    input: { name?: string; authorizationEnabled?: boolean },
    expectedRevision: number,
    now?: number,
  ): TeamRecord;
  listMembers(opts?: { includeRemoved?: boolean }): TeamMember[];
  getMember(id: string): TeamMember | undefined;
  createMember(input: { displayName: string; kind?: TeamMemberKind }, now?: number): TeamMember;
  updateMember(
    id: string,
    input: { displayName?: string; status?: TeamMemberStatus },
    expectedRevision: number,
    now?: number,
  ): TeamMember | undefined;
  listRoleBindings(memberId?: string): TeamRoleBinding[];
  grantRole(
    input: { memberId: string; role: TeamRole; scopeType?: TeamScopeType; scopeId?: string },
    now?: number,
  ): TeamRoleBinding;
  setNodeAccessRole(
    input: { memberId: string; nodeId: string; role: "viewer" | "operator" | "node-admin" },
    now?: number,
  ): TeamRoleBinding;
  revokeRole(id: string, now?: number): boolean;
  listPrincipalBindings(memberId?: string): TeamPrincipalBinding[];
  bindPrincipal(
    input: { memberId: string; actorType: TeamPrincipalType; actorId: string },
    now?: number,
  ): TeamPrincipalBinding;
  unbindPrincipal(actorType: TeamPrincipalType, actorId: string, now?: number): boolean;
  memberForPrincipal(actorType: TeamPrincipalType, actorId: string): TeamMember | undefined;
  authorize(
    actorType: TeamPrincipalType,
    actorId: string,
    permission: TeamPermission,
    resource?: TeamAuthorizationResource,
  ): TeamAuthorizationDecision;
  close(): void;
}

export interface OpenTeamStoreOptions {
  dbPath: string;
  generateTeamId?: () => string;
  generateMemberId?: () => string;
  generateRoleId?: () => string;
  loadDatabase?: () => typeof import("better-sqlite3");
}

export class TeamRevisionConflictError extends Error {
  constructor(readonly current: TeamRecord | TeamMember) {
    super("team revision conflict");
    this.name = "TeamRevisionConflictError";
  }
}

const ALL_PERMISSIONS: readonly TeamPermission[] = [
  "team:read",
  "sessions:read",
  "sessions:operate",
  "attention:read",
  "attention:manage",
  "presence:read",
  "presence:write",
  "workspaces:manage",
  "extensions:manage",
  "policy:manage",
  "members:manage",
  "node-access:manage",
  "audit:read",
  "fleet:read",
];

const ROLE_PERMISSIONS: Record<TeamRole, readonly TeamPermission[]> = {
  viewer: ["team:read", "sessions:read", "attention:read", "presence:read", "presence:write"],
  operator: [
    "team:read",
    "sessions:read",
    "sessions:operate",
    "attention:read",
    "attention:manage",
    "presence:read",
    "presence:write",
  ],
  "node-admin": [
    "team:read",
    "sessions:read",
    "sessions:operate",
    "attention:read",
    "attention:manage",
    "presence:read",
    "presence:write",
    "node-access:manage",
  ],
  "workspace-manager": [
    "team:read",
    "sessions:read",
    "sessions:operate",
    "attention:read",
    "attention:manage",
    "presence:read",
    "presence:write",
    "workspaces:manage",
  ],
  "extension-manager": ["team:read", "extensions:manage"],
  "policy-admin": ["team:read", "policy:manage", "audit:read", "fleet:read"],
  "organization-admin": ALL_PERMISSIONS,
};

const TEAM_ROLES = new Set<TeamRole>(Object.keys(ROLE_PERMISSIONS) as TeamRole[]);
const SCOPE_TYPES = new Set<TeamScopeType>(["team", "host", "workspace"]);

function randomId(prefix: "rct" | "rcm" | "rcr"): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function boundedLabel(value: unknown, max: number, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > max || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new Error(`invalid ${field}`);
  }
  return normalized;
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`invalid ${field}`);
  return value;
}

function normalizeRole(value: unknown): TeamRole {
  if (typeof value !== "string" || !TEAM_ROLES.has(value as TeamRole)) throw new Error("invalid team role");
  return value as TeamRole;
}

function normalizeScope(scopeType: unknown, scopeId: unknown): { scopeType: TeamScopeType; scopeId?: string } {
  const type = scopeType ?? "team";
  if (typeof type !== "string" || !SCOPE_TYPES.has(type as TeamScopeType)) throw new Error("invalid role scope");
  if (type === "team") {
    if (scopeId !== undefined && scopeId !== null && scopeId !== "") throw new Error("team scope cannot have an id");
    return { scopeType: "team" };
  }
  return { scopeType: type as TeamScopeType, scopeId: safeId(scopeId, "scope id") };
}

function scopeMatches(binding: TeamRoleBinding, resource: TeamAuthorizationResource | undefined): boolean {
  if (binding.scopeType === "team") return true;
  if (binding.scopeType === "host") return binding.scopeId === resource?.hostId;
  return binding.scopeId === resource?.workspaceId;
}

interface TeamRow {
  id: string;
  name: string;
  authorization_enabled: number;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface MemberRow {
  id: string;
  display_name: string;
  kind: TeamMemberKind;
  status: TeamMemberStatus;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface RoleRow {
  id: string;
  member_id: string;
  role: TeamRole;
  scope_type: TeamScopeType;
  scope_id: string | null;
  created_at: number;
}

interface PrincipalRow {
  actor_type: TeamPrincipalType;
  actor_id: string;
  member_id: string;
  created_at: number;
}

function teamFromRow(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    name: row.name,
    authorizationEnabled: row.authorization_enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memberFromRow(row: MemberRow): TeamMember {
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function roleFromRow(row: RoleRow): TeamRoleBinding {
  return {
    id: row.id,
    memberId: row.member_id,
    role: row.role,
    scopeType: row.scope_type,
    ...(row.scope_id === null ? {} : { scopeId: row.scope_id }),
    createdAt: row.created_at,
  };
}

function principalFromRow(row: PrincipalRow): TeamPrincipalBinding {
  return {
    actorType: row.actor_type,
    actorId: row.actor_id,
    memberId: row.member_id,
    createdAt: row.created_at,
  };
}

function decisionFor(
  team: TeamRecord | null,
  members: TeamMember[],
  roles: TeamRoleBinding[],
  principals: TeamPrincipalBinding[],
  actorType: TeamPrincipalType,
  actorId: string,
  permission: TeamPermission,
  resource?: TeamAuthorizationResource,
): TeamAuthorizationDecision {
  if (actorType === "host" || actorType === "local") {
    return { allowed: true, reason: "local-break-glass", roles: ["organization-admin"] };
  }
  if (!team?.authorizationEnabled) return { allowed: true, reason: "not-enforced", roles: [] };
  const binding = principals.find((candidate) => candidate.actorType === actorType && candidate.actorId === actorId);
  if (!binding) return { allowed: false, reason: "unbound", roles: [] };
  const member = members.find((candidate) => candidate.id === binding.memberId);
  if (!member || member.status !== "active") {
    return { allowed: false, reason: "inactive", ...(member ? { member: clone(member) } : {}), roles: [] };
  }
  const matching = roles.filter((candidate) => candidate.memberId === member.id && scopeMatches(candidate, resource));
  const roleNames = [...new Set(matching.map((candidate) => candidate.role))];
  const allowed = matching.some((candidate) => ROLE_PERMISSIONS[candidate.role].includes(permission));
  return {
    allowed,
    reason: allowed ? "role" : "missing-permission",
    member: clone(member),
    roles: roleNames,
  };
}

function createMemoryStore(opts: OpenTeamStoreOptions): TeamStore {
  let team: TeamRecord | null = null;
  const members = new Map<string, TeamMember>();
  const roles = new Map<string, TeamRoleBinding>();
  const principals = new Map<string, TeamPrincipalBinding>();
  const generateTeamId = opts.generateTeamId ?? (() => randomId("rct"));
  const generateMemberId = opts.generateMemberId ?? (() => randomId("rcm"));
  const generateRoleId = opts.generateRoleId ?? (() => randomId("rcr"));
  const bump = (now: number) => {
    if (team) team = { ...team, revision: team.revision + 1, updatedAt: now };
  };

  const store: TeamStore = {
    mode: "memory-fallback",
    getTeam: () => (team ? clone(team) : null),
    createTeam(input, now = Date.now()) {
      if (team) throw new Error("team already exists");
      const owner: TeamMember = {
        id: generateMemberId(),
        displayName: boundedLabel(input.ownerName, 120, "owner name"),
        kind: "person",
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const principal: TeamPrincipalBinding = {
        actorType: input.ownerPrincipal.actorType,
        actorId: safeId(input.ownerPrincipal.actorId, "actor id"),
        memberId: owner.id,
        createdAt: now,
      };
      const role: TeamRoleBinding = {
        id: generateRoleId(),
        memberId: owner.id,
        role: "organization-admin",
        scopeType: "team",
        createdAt: now,
      };
      team = {
        id: generateTeamId(),
        name: boundedLabel(input.name, 80, "team name"),
        authorizationEnabled: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      members.set(owner.id, owner);
      principals.set(`${principal.actorType}\0${principal.actorId}`, principal);
      roles.set(role.id, role);
      return { team: clone(team), owner: clone(owner) };
    },
    updateTeam(input, expectedRevision, now = Date.now()) {
      if (!team) throw new Error("team not found");
      if (team.revision !== expectedRevision) throw new TeamRevisionConflictError(clone(team));
      team = {
        ...team,
        ...(input.name === undefined ? {} : { name: boundedLabel(input.name, 80, "team name") }),
        ...(input.authorizationEnabled === undefined
          ? {}
          : { authorizationEnabled: input.authorizationEnabled === true }),
        revision: team.revision + 1,
        updatedAt: now,
      };
      return clone(team);
    },
    listMembers: ({ includeRemoved = false } = {}) =>
      [...members.values()]
        .filter((member) => includeRemoved || member.status !== "removed")
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map(clone),
    getMember: (id) => {
      const member = members.get(id);
      return member ? clone(member) : undefined;
    },
    createMember(input, now = Date.now()) {
      if (!team) throw new Error("team not found");
      const member: TeamMember = {
        id: generateMemberId(),
        displayName: boundedLabel(input.displayName, 120, "member name"),
        kind: input.kind === "service" ? "service" : "person",
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      members.set(member.id, member);
      bump(now);
      return clone(member);
    },
    updateMember(id, input, expectedRevision, now = Date.now()) {
      const current = members.get(id);
      if (!current) return undefined;
      if (current.revision !== expectedRevision) throw new TeamRevisionConflictError(clone(current));
      const status = input.status ?? current.status;
      if (!(["active", "suspended", "removed"] as TeamMemberStatus[]).includes(status)) {
        throw new Error("invalid member status");
      }
      const next: TeamMember = {
        ...current,
        ...(input.displayName === undefined
          ? {}
          : { displayName: boundedLabel(input.displayName, 120, "member name") }),
        status,
        revision: current.revision + 1,
        updatedAt: now,
      };
      members.set(id, next);
      bump(now);
      return clone(next);
    },
    listRoleBindings: (memberId) =>
      [...roles.values()]
        .filter((binding) => memberId === undefined || binding.memberId === memberId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map(clone),
    grantRole(input, now = Date.now()) {
      if (!members.has(input.memberId)) throw new Error("member not found");
      const role = normalizeRole(input.role);
      const scope = normalizeScope(input.scopeType, input.scopeId);
      const existing = [...roles.values()].find(
        (candidate) =>
          candidate.memberId === input.memberId &&
          candidate.role === role &&
          candidate.scopeType === scope.scopeType &&
          candidate.scopeId === scope.scopeId,
      );
      if (existing) return clone(existing);
      const binding: TeamRoleBinding = {
        id: generateRoleId(),
        memberId: input.memberId,
        role,
        ...scope,
        createdAt: now,
      };
      roles.set(binding.id, binding);
      bump(now);
      return clone(binding);
    },
    setNodeAccessRole(input, now = Date.now()) {
      if (!members.has(input.memberId)) throw new Error("member not found");
      const nodeId = safeId(input.nodeId, "node id");
      if (input.role !== "viewer" && input.role !== "operator" && input.role !== "node-admin") {
        throw new Error("invalid node access role");
      }
      const existing = [...roles.values()].filter(
        (candidate) =>
          candidate.memberId === input.memberId &&
          candidate.scopeType === "host" &&
          candidate.scopeId === nodeId &&
          (candidate.role === "viewer" || candidate.role === "operator" || candidate.role === "node-admin"),
      );
      const retained = existing.find((candidate) => candidate.role === input.role);
      if (retained && existing.length === 1) return clone(retained);
      for (const binding of existing) roles.delete(binding.id);
      const binding: TeamRoleBinding = retained ?? {
        id: generateRoleId(),
        memberId: input.memberId,
        role: input.role,
        scopeType: "host",
        scopeId: nodeId,
        createdAt: now,
      };
      roles.set(binding.id, binding);
      bump(now);
      return clone(binding);
    },
    revokeRole(id, now = Date.now()) {
      const removed = roles.delete(id);
      if (removed) bump(now);
      return removed;
    },
    listPrincipalBindings: (memberId) =>
      [...principals.values()]
        .filter((binding) => memberId === undefined || binding.memberId === memberId)
        .sort((a, b) => a.createdAt - b.createdAt || a.actorId.localeCompare(b.actorId))
        .map(clone),
    bindPrincipal(input, now = Date.now()) {
      if (!members.has(input.memberId)) throw new Error("member not found");
      const binding: TeamPrincipalBinding = {
        actorType: input.actorType,
        actorId: safeId(input.actorId, "actor id"),
        memberId: input.memberId,
        createdAt: now,
      };
      principals.set(`${binding.actorType}\0${binding.actorId}`, binding);
      bump(now);
      return clone(binding);
    },
    unbindPrincipal(actorType, actorId, now = Date.now()) {
      const removed = principals.delete(`${actorType}\0${actorId}`);
      if (removed) bump(now);
      return removed;
    },
    memberForPrincipal(actorType, actorId) {
      const binding = principals.get(`${actorType}\0${actorId}`);
      const member = binding ? members.get(binding.memberId) : undefined;
      return member ? clone(member) : undefined;
    },
    authorize(actorType, actorId, permission, resource) {
      return decisionFor(
        team,
        [...members.values()],
        [...roles.values()],
        [...principals.values()],
        actorType,
        actorId,
        permission,
        resource,
      );
    },
    close() {
      team = null;
      members.clear();
      roles.clear();
      principals.clear();
    },
  };
  return store;
}

export function openTeamStore(opts: OpenTeamStoreOptions): TeamStore {
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
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_config (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      authorization_enabled INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('person', 'service')),
      status TEXT NOT NULL CHECK(status IN ('active', 'suspended', 'removed')),
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_role_bindings (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES team_members(id),
      role TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('team', 'host', 'workspace')),
      scope_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(member_id, role, scope_type, scope_id)
    );
    CREATE INDEX IF NOT EXISTS team_role_member_idx ON team_role_bindings(member_id);
    CREATE TABLE IF NOT EXISTS team_principal_bindings (
      actor_type TEXT NOT NULL CHECK(actor_type IN ('device', 'host', 'local')),
      actor_id TEXT NOT NULL,
      member_id TEXT NOT NULL REFERENCES team_members(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(actor_type, actor_id)
    );
    CREATE INDEX IF NOT EXISTS team_principal_member_idx ON team_principal_bindings(member_id);
  `);

  const generateTeamId = opts.generateTeamId ?? (() => randomId("rct"));
  const generateMemberId = opts.generateMemberId ?? (() => randomId("rcm"));
  const generateRoleId = opts.generateRoleId ?? (() => randomId("rcr"));
  const getTeam = (): TeamRecord | null => {
    const row = db.prepare("SELECT * FROM team_config WHERE singleton = 1").get() as TeamRow | undefined;
    return row ? teamFromRow(row) : null;
  };
  const getMember = (id: string): TeamMember | undefined => {
    const row = db.prepare("SELECT * FROM team_members WHERE id = ?").get(id) as MemberRow | undefined;
    return row ? memberFromRow(row) : undefined;
  };
  const listMembers = (includeRemoved = false): TeamMember[] =>
    (
      db
        .prepare(
          `SELECT * FROM team_members ${includeRemoved ? "" : "WHERE status != 'removed'"} ORDER BY created_at, id`,
        )
        .all() as MemberRow[]
    ).map(memberFromRow);
  const listRoles = (memberId?: string): TeamRoleBinding[] =>
    (
      (memberId === undefined
        ? db.prepare("SELECT * FROM team_role_bindings ORDER BY created_at, id").all()
        : db
            .prepare("SELECT * FROM team_role_bindings WHERE member_id = ? ORDER BY created_at, id")
            .all(memberId)) as Array<Omit<RoleRow, "scope_id"> & { scope_id: string }>
    ).map((row) => roleFromRow({ ...row, scope_id: row.scope_id || null }));
  const listPrincipals = (memberId?: string): TeamPrincipalBinding[] =>
    (
      (memberId === undefined
        ? db.prepare("SELECT * FROM team_principal_bindings ORDER BY created_at, actor_id").all()
        : db
            .prepare("SELECT * FROM team_principal_bindings WHERE member_id = ? ORDER BY created_at, actor_id")
            .all(memberId)) as PrincipalRow[]
    ).map(principalFromRow);
  const bumpTeam = (now: number) =>
    db.prepare("UPDATE team_config SET revision = revision + 1, updated_at = ? WHERE singleton = 1").run(now);

  const createTeamTx = db.transaction(
    (input: Parameters<TeamStore["createTeam"]>[0], now: number): { team: TeamRecord; owner: TeamMember } => {
      if (getTeam()) throw new Error("team already exists");
      const owner: TeamMember = {
        id: generateMemberId(),
        displayName: boundedLabel(input.ownerName, 120, "owner name"),
        kind: "person",
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const actorId = safeId(input.ownerPrincipal.actorId, "actor id");
      const team: TeamRecord = {
        id: generateTeamId(),
        name: boundedLabel(input.name, 80, "team name"),
        authorizationEnabled: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        "INSERT INTO team_config(singleton,id,name,authorization_enabled,revision,created_at,updated_at) VALUES(1,?,?,?,?,?,?)",
      ).run(team.id, team.name, 0, 1, now, now);
      db.prepare(
        "INSERT INTO team_members(id,display_name,kind,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(owner.id, owner.displayName, owner.kind, owner.status, owner.revision, now, now);
      db.prepare(
        "INSERT INTO team_role_bindings(id,member_id,role,scope_type,scope_id,created_at) VALUES(?,?,?,?,?,?)",
      ).run(generateRoleId(), owner.id, "organization-admin", "team", "", now);
      db.prepare("INSERT INTO team_principal_bindings(actor_type,actor_id,member_id,created_at) VALUES(?,?,?,?)").run(
        input.ownerPrincipal.actorType,
        actorId,
        owner.id,
        now,
      );
      return { team, owner };
    },
  );
  const setNodeAccessRoleTx = db.transaction(
    (input: Parameters<TeamStore["setNodeAccessRole"]>[0], now: number): TeamRoleBinding => {
      if (!getMember(input.memberId)) throw new Error("member not found");
      const nodeId = safeId(input.nodeId, "node id");
      if (input.role !== "viewer" && input.role !== "operator" && input.role !== "node-admin") {
        throw new Error("invalid node access role");
      }
      const existing = listRoles(input.memberId).filter(
        (candidate) =>
          candidate.scopeType === "host" &&
          candidate.scopeId === nodeId &&
          (candidate.role === "viewer" || candidate.role === "operator" || candidate.role === "node-admin"),
      );
      const retained = existing.find((candidate) => candidate.role === input.role);
      if (retained && existing.length === 1) return retained;
      db.prepare(
        `DELETE FROM team_role_bindings
         WHERE member_id=? AND scope_type='host' AND scope_id=?
           AND role IN ('viewer','operator','node-admin')`,
      ).run(input.memberId, nodeId);
      const binding: TeamRoleBinding = retained ?? {
        id: generateRoleId(),
        memberId: input.memberId,
        role: input.role,
        scopeType: "host",
        scopeId: nodeId,
        createdAt: now,
      };
      db.prepare(
        "INSERT INTO team_role_bindings(id,member_id,role,scope_type,scope_id,created_at) VALUES(?,?,?,?,?,?)",
      ).run(binding.id, binding.memberId, binding.role, binding.scopeType, binding.scopeId ?? "", binding.createdAt);
      bumpTeam(now);
      return binding;
    },
  );

  const store: TeamStore = {
    mode: "sqlite",
    getTeam,
    createTeam(input, now = Date.now()) {
      return createTeamTx(input, now);
    },
    updateTeam(input, expectedRevision, now = Date.now()) {
      const current = getTeam();
      if (!current) throw new Error("team not found");
      if (current.revision !== expectedRevision) throw new TeamRevisionConflictError(current);
      const nextName = input.name === undefined ? current.name : boundedLabel(input.name, 80, "team name");
      const enabled = input.authorizationEnabled ?? current.authorizationEnabled;
      const result = db
        .prepare(
          "UPDATE team_config SET name=?,authorization_enabled=?,revision=revision+1,updated_at=? WHERE singleton=1 AND revision=?",
        )
        .run(nextName, enabled ? 1 : 0, now, expectedRevision);
      if (result.changes !== 1) throw new TeamRevisionConflictError(getTeam() ?? current);
      return getTeam()!;
    },
    listMembers: ({ includeRemoved = false } = {}) => listMembers(includeRemoved),
    getMember,
    createMember(input, now = Date.now()) {
      if (!getTeam()) throw new Error("team not found");
      const member: TeamMember = {
        id: generateMemberId(),
        displayName: boundedLabel(input.displayName, 120, "member name"),
        kind: input.kind === "service" ? "service" : "person",
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.transaction(() => {
        db.prepare(
          "INSERT INTO team_members(id,display_name,kind,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        ).run(member.id, member.displayName, member.kind, member.status, 1, now, now);
        bumpTeam(now);
      })();
      return member;
    },
    updateMember(id, input, expectedRevision, now = Date.now()) {
      const current = getMember(id);
      if (!current) return undefined;
      if (current.revision !== expectedRevision) throw new TeamRevisionConflictError(current);
      const displayName =
        input.displayName === undefined ? current.displayName : boundedLabel(input.displayName, 120, "member name");
      const status = input.status ?? current.status;
      if (!(["active", "suspended", "removed"] as TeamMemberStatus[]).includes(status)) {
        throw new Error("invalid member status");
      }
      const result = db.transaction(() => {
        const updated = db
          .prepare(
            "UPDATE team_members SET display_name=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
          )
          .run(displayName, status, now, id, expectedRevision);
        if (updated.changes === 1) bumpTeam(now);
        return updated.changes;
      })();
      if (result !== 1) throw new TeamRevisionConflictError(getMember(id) ?? current);
      return getMember(id);
    },
    listRoleBindings: listRoles,
    grantRole(input, now = Date.now()) {
      if (!getMember(input.memberId)) throw new Error("member not found");
      const role = normalizeRole(input.role);
      const scope = normalizeScope(input.scopeType, input.scopeId);
      const existing = listRoles(input.memberId).find(
        (candidate) =>
          candidate.role === role && candidate.scopeType === scope.scopeType && candidate.scopeId === scope.scopeId,
      );
      if (existing) return existing;
      const binding: TeamRoleBinding = {
        id: generateRoleId(),
        memberId: input.memberId,
        role,
        ...scope,
        createdAt: now,
      };
      db.transaction(() => {
        db.prepare(
          "INSERT INTO team_role_bindings(id,member_id,role,scope_type,scope_id,created_at) VALUES(?,?,?,?,?,?)",
        ).run(binding.id, binding.memberId, binding.role, binding.scopeType, binding.scopeId ?? "", now);
        bumpTeam(now);
      })();
      return binding;
    },
    setNodeAccessRole(input, now = Date.now()) {
      return setNodeAccessRoleTx(input, now);
    },
    revokeRole(id, now = Date.now()) {
      return db.transaction(() => {
        const result = db.prepare("DELETE FROM team_role_bindings WHERE id = ?").run(id);
        if (result.changes === 1) bumpTeam(now);
        return result.changes === 1;
      })();
    },
    listPrincipalBindings: listPrincipals,
    bindPrincipal(input, now = Date.now()) {
      if (!getMember(input.memberId)) throw new Error("member not found");
      const binding: TeamPrincipalBinding = {
        actorType: input.actorType,
        actorId: safeId(input.actorId, "actor id"),
        memberId: input.memberId,
        createdAt: now,
      };
      db.transaction(() => {
        db.prepare(
          `INSERT INTO team_principal_bindings(actor_type,actor_id,member_id,created_at) VALUES(?,?,?,?)
           ON CONFLICT(actor_type,actor_id) DO UPDATE SET member_id=excluded.member_id,created_at=excluded.created_at`,
        ).run(binding.actorType, binding.actorId, binding.memberId, now);
        bumpTeam(now);
      })();
      return binding;
    },
    unbindPrincipal(actorType, actorId, now = Date.now()) {
      return db.transaction(() => {
        const result = db
          .prepare("DELETE FROM team_principal_bindings WHERE actor_type = ? AND actor_id = ?")
          .run(actorType, actorId);
        if (result.changes === 1) bumpTeam(now);
        return result.changes === 1;
      })();
    },
    memberForPrincipal(actorType, actorId) {
      const row = db
        .prepare(
          `SELECT m.* FROM team_members m JOIN team_principal_bindings p ON p.member_id=m.id
           WHERE p.actor_type=? AND p.actor_id=?`,
        )
        .get(actorType, actorId) as MemberRow | undefined;
      return row ? memberFromRow(row) : undefined;
    },
    authorize(actorType, actorId, permission, resource) {
      return decisionFor(
        getTeam(),
        listMembers(true),
        listRoles(),
        listPrincipals(),
        actorType,
        actorId,
        permission,
        resource,
      );
    },
    close: () => db.close(),
  };
  return store;
}

export function teamRolePermissions(role: TeamRole): readonly TeamPermission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && TEAM_ROLES.has(value as TeamRole);
}

export function isTeamScopeType(value: unknown): value is TeamScopeType {
  return typeof value === "string" && SCOPE_TYPES.has(value as TeamScopeType);
}
