import type {
  ClaudeAuthStatus,
  AgentRecord,
  AttentionItem,
  AttentionResponse,
  CommandCenterCapabilities,
  CommandEventsResponse,
  CommandLayoutEnvelope,
  DeviceEnrollment,
  DeviceListResponse,
  DirListing,
  FsSearchResult,
  ModelInfo,
  SessionDefaults,
  SessionDefaultsEnvelope,
  SessionMeta,
  PairingStartResponse,
  UpdateStartResponse,
  UpdateStatus,
  UsageInfo,
  VersionInfo,
  WorkspaceRecord,
  WorktreeRecord,
} from "../types/server";
import type {
  ClaudeLoginStart,
  ClaudeProviderVersion,
  CodexAuthStatus,
  CodexLoginCancellation,
  CodexLoginStart,
  CodexLoginStatus,
  CodexModel,
  CodexProviderVersion,
  CodexUsage,
  CreateSessionBody,
  ProviderId,
  ProviderDescriptor,
  ProviderSummaries,
  ProviderWarning,
} from "../providers/types";
import { loadToken } from "../auth/token-store";
import { API_BASE_URL } from "../config";
import type { TerminalSocket, TerminalSocketOptions } from "../ws/terminal-socket";

export type { CreateSessionBody } from "../providers/types";

export class ApiError extends Error {
  status: number;
  code?: string;
  body?: unknown;
  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface CreateSessionResponse {
  session: SessionMeta;
  /** Server-persisted choices from this successful launch, used to seed the next wizard immediately. */
  rememberedSessionOptions?: SessionDefaultsEnvelope;
  warnings?: ProviderWarning[];
}

export interface CommandStreamMessage {
  event: "snapshot" | "reset" | "command" | "ready" | string;
  id?: number;
  data: unknown;
}

export interface CommandStreamOptions {
  after?: number;
  onEvent: (message: CommandStreamMessage) => void;
  onError?: (error: unknown) => void;
}

export type ExtensionKind = "adapter" | "plugin";
export interface ExtensionManifestSummary {
  kind: ExtensionKind;
  id?: string;
  version?: string;
  displayName?: string;
  description?: string;
  permissions?: string[];
  adapter?: { id: string; version: string; displayName: string };
}
export interface InstalledExtension {
  kind: ExtensionKind;
  id: string;
  enabled: boolean;
  currentVersion: string;
  previousVersion?: string;
  updatedAt: number;
  approvedPermissions: string[];
  current: {
    manifest: ExtensionManifestSummary;
    integrity: string;
    trust: "signed" | "integrity";
    signerFingerprint?: string;
    source: string;
    installedAt: number;
  };
  versions: Array<{ version: string; integrity: string; trust: "signed" | "integrity"; installedAt: number }>;
}

export interface SessionInputLease {
  owner: { actorType: "device" | "host" | "local"; label: string };
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
  revision: number;
}

export interface SessionInputLeaseGrant {
  leaseId?: string;
  lease: SessionInputLease | null;
}

export type TeamRole =
  | "viewer"
  | "operator"
  | "node-admin"
  | "workspace-manager"
  | "extension-manager"
  | "policy-admin"
  | "organization-admin";
export type TeamScopeType = "team" | "host" | "workspace";
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
  kind: "person" | "service";
  status: "active" | "suspended" | "removed";
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
  actorType: "device" | "host" | "local";
  actorId: string;
  memberId: string;
  createdAt: number;
}
export interface TeamEnvelope {
  team: TeamRecord | null;
  currentMember: TeamMember | null;
  roles: TeamRoleBinding[];
  permissions: string[];
  authorization: { enabled: boolean; localBreakGlass: boolean };
}
export type EnterpriseExtensionMode = "allow-integrity" | "signed-only" | "deny";
export type EnterpriseUpdateMode = "stable-only" | "deny";
export interface EnterprisePolicy {
  enforcementEnabled: boolean;
  allowedHostIds: string[] | null;
  allowedWorkspaceIds: string[] | null;
  allowedProviderIds: string[] | null;
  allowDangerousProviderModes: boolean;
  allowFileTransfer: boolean;
  extensionMode: EnterpriseExtensionMode;
  updateMode: EnterpriseUpdateMode;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export type EnterprisePolicyUpdate = Partial<
  Pick<
    EnterprisePolicy,
    | "enforcementEnabled"
    | "allowedHostIds"
    | "allowedWorkspaceIds"
    | "allowedProviderIds"
    | "allowDangerousProviderModes"
    | "allowFileTransfer"
    | "extensionMode"
    | "updateMode"
  >
> & { expectedRevision: number; confirm?: boolean };
export interface FleetAdapter {
  id: string;
  version?: string;
  enabled: boolean;
  source: string;
  capabilities: ProviderDescriptor["capabilities"];
}
export interface FleetHost {
  id: string;
  label: string;
  version: string;
  health: "healthy" | "degraded" | "offline" | "unknown";
  activeSessions: number;
  dataDurable: boolean;
  policyPosture: {
    enforcementEnabled: boolean;
    revision: number;
    compliant: boolean;
    violations: string[];
  };
  adapters: FleetAdapter[];
  updatedAt: number;
}
export interface FleetInventory {
  revision: number;
  hosts: FleetHost[];
}
export type PeerAction = "read" | "wait" | "send" | "start" | "focus";
export interface PeerRecord {
  id: string;
  label: string;
  remoteHostId: string;
  remoteVersion: string;
  actions: PeerAction[];
  allowedWorkspaceIds: string[] | null;
  status: "active" | "suspended";
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt: number;
}
export interface PeerWorkspace {
  id: string;
  label: string;
  kind: "directory" | "worktree";
  archived: boolean;
}
interface PeerCreateCommon {
  label?: string;
  actions?: PeerAction[];
  allowedWorkspaceIds?: string[] | null;
}
export type PeerCreateInput = PeerCreateCommon &
  (
    | { pairingUrl: string; baseUrl?: never; credential?: never }
    | { pairingUrl?: never; baseUrl: string; credential: string }
  );
export interface PeerUpdateInput {
  label?: string;
  actions?: PeerAction[];
  allowedWorkspaceIds?: string[] | null;
  status?: "active" | "suspended";
  expectedRevision: number;
}
export interface AuditRecord {
  id: number;
  actorType: "host" | "device" | "local" | "automation" | "plugin" | "system";
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  result: "success" | "denied" | "error";
  metadata: Record<string, string | number | boolean | null>;
  createdAt: number;
  previousHash: string;
  hash: string;
}
export interface AuditPage {
  records: AuditRecord[];
  nextCursor: number;
}
export interface AuditVerification {
  valid: boolean;
  count: number;
  head: string;
}
export interface PresenceRecord {
  id: string;
  memberId?: string;
  label: string;
  mode: "viewing" | "operating";
  hostId: string;
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  connectedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revision: number;
}

export type ProviderModels<P extends ProviderId> = P extends "codex" ? CodexModel[] : ModelInfo[];
export type ProviderUsage<P extends ProviderId> = P extends "codex" ? CodexUsage | null : UsageInfo | null;
export type ProviderAuthStatus<P extends ProviderId> = P extends "codex" ? CodexAuthStatus : ClaudeAuthStatus;
export type ProviderLoginStart<P extends ProviderId> = P extends "codex" ? CodexLoginStart : ClaudeLoginStart;
export type ProviderVersion<P extends ProviderId> = P extends "codex" ? CodexProviderVersion : ClaudeProviderVersion;

export interface ApiClient {
  /** Stable command-center resources. Old servers may answer 404; callers degrade to the session rail. */
  getCommandCenterCapabilities(): Promise<CommandCenterCapabilities>;
  listWorkspaces(): Promise<WorkspaceRecord[]>;
  renameCommandHost(label: string): Promise<CommandCenterCapabilities["host"]>;
  createWorkspace(cwd: string, label?: string, kind?: "directory" | "worktree"): Promise<WorkspaceRecord>;
  updateWorkspace(
    id: string,
    update: { label?: string; sortOrder?: number; archived?: boolean },
  ): Promise<WorkspaceRecord>;
  createWorktree(input: {
    repositoryPath: string;
    path: string;
    branch?: string;
    baseRef?: string;
    label?: string;
  }): Promise<{ workspace: WorkspaceRecord; worktree: WorktreeRecord; created: boolean }>;
  openWorktree(cwd: string, label?: string): Promise<{ workspace: WorkspaceRecord; worktree: WorktreeRecord }>;
  getWorktreeStatus(workspaceId: string): Promise<{ workspace: WorkspaceRecord; worktree: WorktreeRecord }>;
  removeWorktree(
    workspaceId: string,
    force?: boolean,
  ): Promise<{ workspace: WorkspaceRecord; worktree: WorktreeRecord }>;
  /** Current adapter catalog, including disabled installed packages and their generated option schemas. */
  listAdapters(): Promise<ProviderDescriptor[]>;
  listExtensions(): Promise<InstalledExtension[]>;
  inspectExtension(sourceDirectory: string): Promise<{ manifest: ExtensionManifestSummary; integrity: string }>;
  installExtension(input: {
    sourceDirectory: string;
    expectedIntegrity: string;
    allowUnsigned?: boolean;
    signature?: string;
    publicKey?: string;
    source?: string;
  }): Promise<InstalledExtension>;
  setExtensionEnabled(
    kind: ExtensionKind,
    id: string,
    enabled: boolean,
    approvedPermissions?: string[],
  ): Promise<InstalledExtension>;
  rollbackExtension(kind: ExtensionKind, id: string): Promise<InstalledExtension>;
  uninstallExtension(kind: ExtensionKind, id: string, purgeState?: boolean): Promise<void>;
  listAttention(): Promise<AttentionResponse>;
  updateAttention(id: string, action: "acknowledge" | "resolve" | "snooze", until?: number): Promise<AttentionItem>;
  listCommandEvents(after?: number, limit?: number): Promise<CommandEventsResponse>;
  getCommandLayout<T = Record<string, unknown>>(): Promise<CommandLayoutEnvelope<T>>;
  putCommandLayout<T extends object>(document: T, expectedRevision: number): Promise<CommandLayoutEnvelope<T>>;
  /** Authenticated fetch-stream SSE: bearer credentials stay in headers, never URLs or proxy logs. */
  subscribeCommandEvents(options: CommandStreamOptions): () => void;
  /** Independently revocable browser credentials and one-use onboarding links. */
  listDevices(): Promise<DeviceListResponse>;
  startPairing(): Promise<PairingStartResponse>;
  cancelPairing(secret: string): Promise<void>;
  renameDevice(id: string, name: string): Promise<DeviceListResponse["devices"][number]>;
  revokeDevice(id: string): Promise<void>;
  resetAccess(): Promise<{ token: string; revokedDevices: number }>;
  getSessionDefaults(): Promise<SessionDefaultsEnvelope>;
  putSessionDefaults(defaults: SessionDefaults, expectedRevision: number): Promise<SessionDefaultsEnvelope>;
  listSessions(): Promise<SessionMeta[]>;
  createSession(body: CreateSessionBody): Promise<CreateSessionResponse>;
  /** One writer / many observers: ownership identifiers are bound to this credential + clientId. */
  getSessionInputLease(id: string): Promise<SessionInputLease | null>;
  changeSessionInputLease(
    id: string,
    input:
      | {
          action: "acquire" | "takeover" | "renew" | "release";
          clientId: string;
          leaseId?: string;
          confirm?: boolean;
        }
      | { action: "revoke"; confirm: true },
  ): Promise<SessionInputLeaseGrant>;
  sendSessionInput(
    id: string,
    data: string,
    options?: { appendNewline?: boolean; clientId?: string; leaseId?: string },
  ): Promise<{ accepted: true; focused: false }>;
  getTeam(): Promise<TeamEnvelope>;
  createTeam(name: string, ownerName?: string): Promise<TeamEnvelope>;
  updateTeam(update: {
    name?: string;
    authorizationEnabled?: boolean;
    expectedRevision: number;
    confirm?: boolean;
  }): Promise<TeamRecord>;
  listTeamMembers(includeRemoved?: boolean): Promise<Array<TeamMember & { roles: TeamRoleBinding[] }>>;
  createTeamMember(input: {
    displayName: string;
    kind?: "person" | "service";
    role?: TeamRole;
    scopeType?: TeamScopeType;
    scopeId?: string;
  }): Promise<TeamMember & { roles: TeamRoleBinding[] }>;
  updateTeamMember(
    id: string,
    update: { displayName?: string; status?: TeamMember["status"]; expectedRevision: number },
  ): Promise<TeamMember>;
  grantTeamRole(input: {
    memberId: string;
    role: TeamRole;
    scopeType?: TeamScopeType;
    scopeId?: string;
  }): Promise<TeamRoleBinding>;
  revokeTeamRole(id: string): Promise<void>;
  bindTeamPrincipal(input: {
    memberId: string;
    actorType: "device" | "host" | "local";
    actorId: string;
  }): Promise<void>;
  listTeamPrincipalBindings(): Promise<TeamPrincipalBinding[]>;
  unbindTeamPrincipal(actorType: "device" | "host" | "local", actorId: string): Promise<void>;
  getEnterprisePolicy(): Promise<EnterprisePolicy>;
  updateEnterprisePolicy(update: EnterprisePolicyUpdate): Promise<EnterprisePolicy>;
  getFleetInventory(): Promise<FleetInventory>;
  listPeers(): Promise<PeerRecord[]>;
  createPeer(input: PeerCreateInput): Promise<PeerRecord>;
  updatePeer(id: string, input: PeerUpdateInput): Promise<PeerRecord>;
  verifyPeer(id: string, expectedRevision: number): Promise<PeerRecord>;
  discoverPeerWorkspaces(
    id: string,
    expectedRevision: number,
  ): Promise<{ peer: PeerRecord; workspaces: PeerWorkspace[] }>;
  rotatePeerCredential(
    id: string,
    access: string | { pairingUrl: string },
    expectedRevision: number,
  ): Promise<PeerRecord>;
  removePeer(id: string): Promise<void>;
  listPeerWorkspaces(id: string): Promise<WorkspaceRecord[]>;
  listPeerAgents(id: string): Promise<AgentRecord[]>;
  listPeerSessions(id: string): Promise<SessionMeta[]>;
  createPeerSession(
    peerId: string,
    body: Omit<CreateSessionBody, "cwd"> & { workspaceId: string },
  ): Promise<CreateSessionResponse>;
  getPeerSessionInputLease(peerId: string, sessionId: string): Promise<SessionInputLease | null>;
  changePeerSessionInputLease(
    peerId: string,
    sessionId: string,
    input:
      | {
          action: "acquire" | "takeover" | "renew" | "release";
          clientId: string;
          leaseId?: string;
          confirm?: boolean;
        }
      | { action: "revoke"; confirm: true },
  ): Promise<SessionInputLeaseGrant>;
  sendPeerSessionInput(
    peerId: string,
    sessionId: string,
    data: string,
    options?: { appendNewline?: boolean; clientId?: string; leaseId?: string },
  ): Promise<{ accepted: true; focused: false }>;
  waitPeerAgent(
    peerId: string,
    agentId: string,
    after?: number,
    timeoutMs?: number,
  ): Promise<{ agent: AgentRecord; timedOut: boolean }>;
  focusPeerAgent(
    peerId: string,
    agentId: string,
    mode?: "request" | "activate",
  ): Promise<{ accepted: true; focused: false; agentId: string; sessionId: string }>;
  listAudit(after?: number, limit?: number): Promise<AuditPage>;
  listLatestAudit(limit?: number): Promise<AuditPage>;
  verifyAudit(): Promise<AuditVerification>;
  exportAudit(after?: number, limit?: number): Promise<string>;
  listPresence(filter?: {
    hostId?: string;
    workspaceId?: string;
    sessionId?: string;
    agentId?: string;
  }): Promise<PresenceRecord[]>;
  heartbeatPresence(input: {
    clientId: string;
    mode: "viewing" | "operating";
    workspaceId?: string;
    sessionId?: string;
    agentId?: string;
  }): Promise<{ presence: PresenceRecord; heartbeatMs: number }>;
  releasePresence(clientId: string): Promise<void>;
  /** Close a session: DELETE /sessions/:id → 204 (no body). Removes it from the list + store while
   * keeping the transcript (still resumable via /resume). Idempotent server-side, so deleting an
   * already-gone session also resolves. Rejects (ApiError) only on a real failure (e.g. 5xx/network). */
  deleteSession(id: string): Promise<void>;
  /** Rename a session SERVER-side: PATCH /sessions/:id {name} → 204. The server is the cross-device
   * source of truth for names; an empty (or whitespace-only) name is sent as null, which CLEARS it
   * (display falls back to the local label / cwd basename). */
  renameSession(id: string, name: string): Promise<void>;
  listDir(path?: string): Promise<DirListing>;
  /** Create a directory: POST /fs/mkdir {path} → {path}. A 409 (already exists) rejects with ApiError
   * so the picker can show its inline "already exists" instead of a generic failure. */
  mkdir(path: string): Promise<{ path: string }>;
  /** Deep directory search under `base`: GET /fs/search?q=&base= → up to 30 matches, shallowest-first.
   * Powers the picker's "Deeper matches" section (find a folder without clicking through the tree). */
  searchDirs(q: string, base?: string): Promise<FsSearchResult[]>;
  uploadFile(dir: string, file: File): Promise<{ path: string }>;
  /** Upload an image (binary) to the content-addressed store (POST /images) → its `{ ref }`. The composer
   *  uploads on attach so the phone never uplinks base64; the WS `user` send then carries the ref. */
  uploadImage(file: File): Promise<{ ref: string }>;
  downloadUrl(path: string): string;
  /** Resolve a relative server media path (e.g. a file-backed image ref `/images/<ref>`) to an absolute,
   *  token-bearing URL usable as an <img src>. The token is appended (`?` or `&` as needed). */
  mediaUrl(relativePath: string): string;
  getVapidPublicKey(): Promise<string>;
  subscribePush(sub: PushSubscriptionJSON): Promise<void>;
  unsubscribePush(endpoint: string): Promise<void>;
  sendPushTest(): Promise<void>;
  /** OTA self-update: GET /version → {current,latest,behind,updatable,updateAvailable,changelog}.
   * `force` (the in-app "Check for updates") bypasses the server's cached git check for a fresh fetch. */
  getVersion(force?: boolean): Promise<VersionInfo>;
  getProviders(): Promise<ProviderSummaries>;
  getProviderModels<P extends ProviderId>(provider: P): Promise<ProviderModels<P>>;
  getProviderProfiles(provider: ProviderId): Promise<string[]>;
  getProviderUsage<P extends ProviderId>(provider: P): Promise<ProviderUsage<P>>;
  getProviderVersion<P extends ProviderId>(provider: P): Promise<ProviderVersion<P>>;
  getProviderAuthStatus<P extends ProviderId>(provider: P): Promise<ProviderAuthStatus<P>>;
  startProviderLogin<P extends ProviderId>(provider: P): Promise<ProviderLoginStart<P>>;
  getProviderLoginStatus(provider: "codex", loginId: string): Promise<CodexLoginStatus>;
  cancelProviderLogin(provider: "claude"): Promise<{ ok: true }>;
  cancelProviderLogin(provider: "codex", loginId: string): Promise<CodexLoginCancellation>;
  /** OTA: POST /update {confirm:true,target} → 202; target is an exact stable release version. */
  applyUpdate(target?: string): Promise<UpdateStartResponse>;
  /** OTA: GET /update/status → the detached updater's progress {state,phase,error?,target?,log?}. */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** OTA rollback: POST /update/rollback {confirm:true} → restart onto the previous verified version. Shares
   * the /update/status lifecycle (same polling finishes/fails the flow); a 409/400 means no previous
   * build is recorded — the caller maps that to a human message. */
  rollbackUpdate(): Promise<UpdateStartResponse>;
  /** Claude usage limits: GET /usage → {usage: UsageInfo | null}. `null` when unavailable (the UI hides
   * the bars). The server TTL-caches the underlying spawn, so polling this is cheap. */
  getUsage(): Promise<UsageInfo | null>;
  /** Selectable models for the model dropdown: GET /models → {models}. Empty when unavailable
   * (the UI falls back to a free-text field). */
  getModels(): Promise<ModelInfo[]>;
  /** Rotate the single access token: POST /token/rotate (authed) → {token}. The OLD token is invalid the
   * instant this resolves, so the new token MUST be re-stored. Persists it to the token-store and returns
   * it so the caller can re-issue any token-bearing links (e.g. a fresh connect URL). */
  rotateToken(): Promise<string>;
  /** In-app Claude sign-in. `getAuthStatus` → which account is signed in (GET /auth/status). `startAuthLogin`
   * → an authorize URL the user opens in a browser (POST /auth/login/start). `submitAuthCode` → finish the
   * exchange with the pasted code (POST /auth/login/code). `cancelAuthLogin` → abandon it. */
  getAuthStatus(): Promise<ClaudeAuthStatus>;
  startAuthLogin(): Promise<{ loginId: string; url: string }>;
  submitAuthCode(loginId: string, code: string): Promise<{ ok: boolean; message?: string }>;
  cancelAuthLogin(): Promise<void>;
  /** The server's installed claude version + the latest published one (GET /claude/version), for the
   *  "update available" hint. Either may be null when unknown. */
  getClaudeVersion(): Promise<ClaudeProviderVersion>;
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | undefined;
  /** Optional custom request transport. Direct connections use the browser's native fetch. */
  request?: typeof globalThis.fetch;
  /** Optional progress-aware upload transport; direct hosts retain native XHR progress. */
  uploadRequest?: (
    input: RequestInfo | URL,
    init: RequestInit,
    onProgress: (fraction: number) => void,
    contentBytes: number,
  ) => { abort(): void; promise: Promise<Response> };
  /** Disable unbounded streaming for custom transports and resume the cursor through bounded polling. */
  supportsStreaming?: boolean;
  /** Host-specific terminal transport. Direct browser WebSocket connections leave this undefined. */
  terminalSocketFactory?: (options: TerminalSocketOptions) => TerminalSocket;
}

function defaultConnection(): ApiClientOptions {
  return { baseUrl: API_BASE_URL, getToken: loadToken };
}

/** Public one-time exchange used before the browser owns any bearer credential. */
export async function claimPairing(secret: string, name: string, baseUrl = API_BASE_URL): Promise<DeviceEnrollment> {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(15_000)
      : undefined;
  const res = await fetch(`${baseUrl}/pairing/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, name }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    let message = `pairing failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      /* non-JSON failure — keep the status message */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as DeviceEnrollment;
}

/** http(s) → ws(s) for a WebSocket base, shared by every WS url builder. */
function wsBaseFor(baseUrl: string): string {
  return baseUrl.replace(/^http/, "ws");
}

/** Build the `?token=…` query the WS gate accepts (a browser WebSocket can't set an Authorization
 * header, so the token MUST ride as a query param). Returns the query body WITHOUT the leading `?`
 * (empty when there's no token), so each builder appends it uniformly. Shared so token handling lives
 * in exactly one place. */
function authQuery(token?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  return params.toString();
}

export async function consumeCommandEventStream(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: CommandStreamMessage) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (block: string) => {
    let event = "message";
    let id: number | undefined;
    const data: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "id") {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed) && parsed >= 0) id = parsed;
      } else if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    onMessage({ event, ...(id === undefined ? {} : { id }), data: JSON.parse(data.join("\n")) });
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        dispatch(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** How an ENDED session should come back when the terminal WS reattaches: `continue` respawns claude
 * with --continue (resume the last conversation in that cwd); `fresh` (or absent) spawns a fresh claude.
 * The server ignores the param for a still-running session, so carrying it on a retry is harmless. */
export type RespawnMode = "continue" | "fresh";

/**
 * The PREFERRED terminal WS URL builder: fetches a SINGLE-USE ~30s ticket (POST /ws-ticket) and connects
 * with `?ticket=` so the LONG-LIVED token stays out of WS URLs / proxy access logs. ANY failure (an old
 * server mid-OTA without the route, a network blip) falls back to the legacy `?token=` URL — connecting
 * always beats purity. Re-invoked per (re)connect attempt via the socket's async URL thunk, so every
 * attempt gets a fresh ticket (they're single-use by design).
 */
export async function terminalWsTicketUrl(
  id: string,
  cols?: number,
  rows?: number,
  respawn?: RespawnMode,
  connection: ApiClientOptions = defaultConnection(),
): Promise<string> {
  const { baseUrl, getToken } = connection;
  const token = getToken();
  try {
    const res = await (connection.request ?? globalThis.fetch)(`${baseUrl}/ws-ticket`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const body = (await res.json()) as { ticket?: unknown };
      if (typeof body.ticket === "string" && body.ticket) {
        const params = new URLSearchParams({ ticket: body.ticket });
        if (Number.isInteger(cols) && (cols as number) > 0) params.set("cols", String(cols));
        if (Number.isInteger(rows) && (rows as number) > 0) params.set("rows", String(rows));
        if (respawn) params.set("respawn", respawn);
        return `${wsBaseFor(baseUrl)}/sessions/${id}/terminal?${params.toString()}`;
      }
    }
  } catch {
    /* fall through to the legacy URL */
  }
  return terminalWsUrl(id, cols, rows, respawn, connection);
}

/** The LEGACY binary terminal WebSocket url (`?token=`) for a terminal-mode session — the fallback for
 * terminalWsTicketUrl above (and old servers). The client passes its fitted `cols`/`rows` so the server
 * spawns the pty/tmux at the real viewport size (no first-paint reflow). `respawn` is appended ONLY when
 * set (the ended overlay's "Resume conversation" picks `continue`). */
export function terminalWsUrl(
  id: string,
  cols?: number,
  rows?: number,
  respawn?: RespawnMode,
  connection: ApiClientOptions = defaultConnection(),
): string {
  const extra: Record<string, string> = {};
  if (Number.isInteger(cols) && (cols as number) > 0) extra.cols = String(cols);
  if (Number.isInteger(rows) && (rows as number) > 0) extra.rows = String(rows);
  if (respawn) extra.respawn = respawn;
  const qs = authQuery(connection.getToken(), extra);
  return `${wsBaseFor(connection.baseUrl)}/sessions/${id}/terminal${qs ? `?${qs}` : ""}`;
}

/** Standalone (no api instance) view/download URL for a server-local file — for the terminal Files panel. */
export function terminalDownloadUrl(path: string, connection: ApiClientOptions = defaultConnection()): string {
  const token = connection.getToken();
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
  return `${connection.baseUrl}/fs/download?path=${encodeURIComponent(path)}${tokenParam}`;
}

/** Durable terminal-file content URL. Unlike the legacy path URL this survives PWA reloads through a
 *  stable file id and lets the server apply the correct MIME/range/disposition policy. */
export function terminalFileContentUrl(
  sessionId: string,
  fileId: string,
  disposition: "inline" | "attachment" = "inline",
  connection: ApiClientOptions = defaultConnection(),
): string {
  const token = connection.getToken();
  const query = new URLSearchParams({ disposition });
  if (token) query.set("token", token);
  return `${connection.baseUrl}/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/content?${query}`;
}

/** Header-authenticated terminal file fetch used by custom transports. */
export function terminalFileContentRequest(
  sessionId: string,
  fileId: string,
  disposition: "inline" | "attachment" = "inline",
  init: RequestInit = {},
  connection: ApiClientOptions = defaultConnection(),
): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = connection.getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const query = new URLSearchParams({ disposition });
  return (connection.request ?? globalThis.fetch)(
    `${connection.baseUrl}/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/content?${query}`,
    { ...init, headers },
  );
}

/** Upload a file for a terminal session: the server saves it in the app data dir, outside any project repo
 *  (created + pruned to a 7-day TTL server-side), and returns its absolute path — which the client hands to
 *  claude. */
export async function terminalUpload(
  sessionId: string,
  file: File,
  connection: ApiClientOptions = defaultConnection(),
): Promise<{ path: string }> {
  const token = connection.getToken();
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await (connection.request ?? globalThis.fetch)(
    `${connection.baseUrl}/sessions/${encodeURIComponent(sessionId)}/upload`,
    {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: form,
    },
  );
  if (!res.ok) {
    let message = `upload failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as { path: string };
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const { baseUrl, getToken } = opts;
  const fetchRequest = opts.request ?? globalThis.fetch;
  let mutationSequence = 0;

  function headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    const token = getToken();
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  function mutationHeaders(extra?: Record<string, string>): Record<string, string> {
    mutationSequence += 1;
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${mutationSequence.toString(36)}`;
    return headers({ ...extra, "idempotency-key": `web-${random}` });
  }

  async function errorFor(res: Response): Promise<ApiError> {
    let message = `request failed (${res.status})`;
    let code: string | undefined;
    let body: unknown;
    try {
      body = await res.json();
      if (typeof body === "object" && body !== null) {
        const record = body as { code?: unknown; error?: unknown };
        if (typeof record.error === "string" && record.error) message = record.error;
        if (typeof record.code === "string") code = record.code;
      }
    } catch {
      // non-JSON error body — keep the default message
    }
    return new ApiError(res.status, message, code, body);
  }

  // Attach a request timeout so a server that accepts the connection but never responds can't strand the
  // loading UI ("Connecting…" / "Loading…" / "Starting…") forever. Respects a caller-supplied signal, and
  // degrades to no timeout where AbortSignal.timeout is unavailable (old engines / jsdom in tests).
  const DEFAULT_TIMEOUT_MS = 15_000;
  function withTimeout(init: RequestInit | undefined, ms = DEFAULT_TIMEOUT_MS): RequestInit {
    if (init?.signal) return init;
    const hasTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
    return hasTimeout ? { ...init, signal: AbortSignal.timeout(ms) } : (init ?? {});
  }

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchRequest(`${baseUrl}${path}`, withTimeout(init));
    if (!res.ok) throw await errorFor(res);
    return (await res.json()) as T;
  }

  async function reqText(path: string, init?: RequestInit): Promise<string> {
    const res = await fetchRequest(`${baseUrl}${path}`, withTimeout(init));
    if (!res.ok) throw await errorFor(res);
    return res.text();
  }

  /** For endpoints that resolve with no JSON body (e.g. DELETE → 204 No Content). A non-2xx still
   * throws ApiError (so a real failure surfaces); a 204 with an empty body resolves WITHOUT trying to
   * parse JSON (parsing an empty 204 body throws and would otherwise look like a failure). */
  async function reqNoBody(path: string, init?: RequestInit): Promise<void> {
    const res = await fetchRequest(`${baseUrl}${path}`, withTimeout(init));
    if (!res.ok) throw await errorFor(res);
  }

  async function getProviders(): Promise<ProviderSummaries> {
    const body = await req<{ providers: ProviderSummaries }>("/providers", { headers: headers() });
    return body.providers;
  }

  async function getProviderModels<P extends ProviderId>(provider: P): Promise<ProviderModels<P>> {
    const body = await req<{ models: ProviderModels<P> }>(`/providers/${provider}/models`, { headers: headers() });
    return body.models;
  }

  async function getProviderProfiles(provider: ProviderId): Promise<string[]> {
    const body = await req<{ profiles: string[] }>(`/providers/${provider}/profiles`, { headers: headers() });
    return body.profiles;
  }

  async function getProviderUsage<P extends ProviderId>(provider: P): Promise<ProviderUsage<P>> {
    const body = await req<{ usage: ProviderUsage<P> }>(`/providers/${provider}/usage`, { headers: headers() });
    return body.usage;
  }

  function getProviderVersion<P extends ProviderId>(provider: P): Promise<ProviderVersion<P>> {
    return req<ProviderVersion<P>>(`/providers/${provider}/version`, { headers: headers() });
  }

  function getProviderAuthStatus<P extends ProviderId>(provider: P): Promise<ProviderAuthStatus<P>> {
    return req<ProviderAuthStatus<P>>(`/providers/${provider}/auth/status`, { headers: headers() });
  }

  function startProviderLogin<P extends ProviderId>(provider: P): Promise<ProviderLoginStart<P>> {
    return req<ProviderLoginStart<P>>(`/providers/${provider}/auth/login/start`, {
      method: "POST",
      headers: headers(),
    });
  }

  function getProviderLoginStatus(provider: "codex", loginId: string): Promise<CodexLoginStatus> {
    return req<CodexLoginStatus>(`/providers/${provider}/auth/login/status?loginId=${encodeURIComponent(loginId)}`, {
      headers: headers(),
    });
  }

  function cancelProviderLogin(provider: "claude"): Promise<{ ok: true }>;
  function cancelProviderLogin(provider: "codex", loginId: string): Promise<CodexLoginCancellation>;
  function cancelProviderLogin(provider: ProviderId, loginId?: string): Promise<{ ok: true } | CodexLoginCancellation> {
    return req<{ ok: true } | CodexLoginCancellation>(`/providers/${provider}/auth/login/cancel`, {
      method: "POST",
      headers: headers(loginId === undefined ? undefined : { "content-type": "application/json" }),
      ...(loginId === undefined ? {} : { body: JSON.stringify({ loginId }) }),
    });
  }

  return {
    async getCommandCenterCapabilities() {
      return req<CommandCenterCapabilities>("/api/v1/capabilities", { headers: headers() });
    },
    async listWorkspaces() {
      const body = await req<{ workspaces: WorkspaceRecord[] }>("/api/v1/workspaces", { headers: headers() });
      return body.workspaces;
    },
    async renameCommandHost(label) {
      const body = await req<{ host: CommandCenterCapabilities["host"] }>("/api/v1/host", {
        method: "PATCH",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ label }),
      });
      return body.host;
    },
    async createWorkspace(cwd, label, kind = "directory") {
      const body = await req<{ workspace: WorkspaceRecord }>("/api/v1/workspaces", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ cwd, ...(label ? { label } : {}), kind }),
      });
      return body.workspace;
    },
    async updateWorkspace(id, update) {
      const body = await req<{ workspace: WorkspaceRecord }>(`/api/v1/workspaces/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(update),
      });
      return body.workspace;
    },
    async createWorktree(input) {
      return req<{ workspace: WorkspaceRecord; worktree: WorktreeRecord; created: boolean }>("/api/v1/worktrees", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      });
    },
    async openWorktree(cwd, label) {
      return req<{ workspace: WorkspaceRecord; worktree: WorktreeRecord }>("/api/v1/worktrees/open", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ cwd, ...(label ? { label } : {}) }),
      });
    },
    async getWorktreeStatus(workspaceId) {
      return req<{ workspace: WorkspaceRecord; worktree: WorktreeRecord }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/worktree`,
        { headers: headers() },
      );
    },
    async removeWorktree(workspaceId, force = false) {
      return req<{ workspace: WorkspaceRecord; worktree: WorktreeRecord }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/worktree`,
        {
          method: "DELETE",
          headers: mutationHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ confirm: true, force }),
        },
      );
    },
    async listAdapters() {
      const body = await req<{ adapters: ProviderDescriptor[] }>("/api/v1/adapters", { headers: headers() });
      return body.adapters;
    },
    async listExtensions() {
      const body = await req<{ extensions: InstalledExtension[] }>("/api/v1/extensions", { headers: headers() });
      return body.extensions;
    },
    async inspectExtension(sourceDirectory) {
      return req<{ manifest: ExtensionManifestSummary; integrity: string }>("/api/v1/extensions/inspect", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ sourceDirectory }),
      });
    },
    async installExtension(input) {
      const body = await req<{ extension: InstalledExtension }>("/api/v1/extensions/install", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      });
      return body.extension;
    },
    async setExtensionEnabled(kind, id, enabled, approvedPermissions) {
      const body = await req<{ extension: InstalledExtension }>(
        `/api/v1/extensions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: mutationHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ enabled, ...(approvedPermissions ? { approvedPermissions } : {}) }),
        },
      );
      return body.extension;
    },
    async rollbackExtension(kind, id) {
      const body = await req<{ extension: InstalledExtension }>(
        `/api/v1/extensions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/rollback`,
        { method: "POST", headers: mutationHeaders() },
      );
      return body.extension;
    },
    async uninstallExtension(kind, id, purgeState = false) {
      await reqNoBody(`/api/v1/extensions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ confirm: true, purgeState }),
      });
    },
    async listAttention() {
      return req<AttentionResponse>("/api/v1/attention", { headers: headers() });
    },
    async updateAttention(id, action, until) {
      const body = await req<{ item: AttentionItem }>(`/api/v1/attention/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ action, ...(action === "snooze" && until !== undefined ? { until } : {}) }),
      });
      return body.item;
    },
    async listCommandEvents(after = 0, limit = 500) {
      const params = new URLSearchParams({ after: String(after), limit: String(limit) });
      return req<CommandEventsResponse>(`/api/v1/events?${params.toString()}`, { headers: headers() });
    },
    async getCommandLayout<T = Record<string, unknown>>() {
      return req<CommandLayoutEnvelope<T>>("/api/v1/layout", { headers: headers() });
    },
    async putCommandLayout<T extends object>(document: T, expectedRevision: number) {
      return req<CommandLayoutEnvelope<T>>("/api/v1/layout", {
        method: "PUT",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ document, expectedRevision }),
      });
    },
    subscribeCommandEvents(options) {
      if (opts.supportsStreaming === false) {
        let stopped = false;
        let cursor = options.after ?? 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let busy = false;
        const poll = async () => {
          if (stopped || busy) return;
          busy = true;
          try {
            const params = new URLSearchParams({ after: String(cursor), limit: "500" });
            const page = await req<CommandEventsResponse>(`/api/v1/events?${params.toString()}`, {
              headers: headers(),
            });
            for (const event of page.events) {
              if (event.id <= cursor) continue;
              cursor = event.id;
              options.onEvent({ event: "command", id: event.id, data: event });
            }
            cursor = Math.max(cursor, page.nextCursor);
          } catch (error) {
            options.onError?.(error);
            if (error instanceof ApiError && (error.status === 401 || error.status === 404)) {
              stopped = true;
            }
          } finally {
            busy = false;
            if (!stopped) timer = setTimeout(() => void poll(), 2_000);
          }
        };
        void poll();
        return () => {
          stopped = true;
          if (timer) clearTimeout(timer);
        };
      }
      let stopped = false;
      let controller: AbortController | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let wakeRetry: (() => void) | undefined;
      let cursor = options.after ?? 0;
      let retryMs = 1_000;

      const run = async () => {
        while (!stopped) {
          controller = new AbortController();
          try {
            const res = await fetchRequest(`${baseUrl}/api/v1/events/stream?after=${cursor}`, {
              headers: headers({ accept: "text/event-stream" }),
              signal: controller.signal,
            });
            if (!res.ok) throw await errorFor(res);
            if (!res.body) throw new Error("event stream unavailable");
            retryMs = 1_000;
            await consumeCommandEventStream(res.body, (message) => {
              if (message.id !== undefined) cursor = Math.max(cursor, message.id);
              options.onEvent(message);
            });
          } catch (error: unknown) {
            if (stopped || controller.signal.aborted) return;
            options.onError?.(error);
            if (error instanceof ApiError && (error.status === 401 || error.status === 404)) return;
          }
          if (stopped) return;
          await new Promise<void>((resolve) => {
            wakeRetry = resolve;
            retryTimer = setTimeout(resolve, retryMs);
          });
          wakeRetry = undefined;
          retryMs = Math.min(30_000, retryMs * 2);
        }
      };
      void run();
      return () => {
        stopped = true;
        controller?.abort();
        if (retryTimer) clearTimeout(retryTimer);
        wakeRetry?.();
      };
    },
    async listDevices() {
      return req<DeviceListResponse>("/api/v1/devices", { headers: headers() });
    },
    async startPairing() {
      return req<PairingStartResponse>("/pairing/start", {
        method: "POST",
        headers: headers(),
      });
    },
    async cancelPairing(secret) {
      return reqNoBody("/pairing/cancel", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ secret }),
      });
    },
    async renameDevice(id, name) {
      const body = await req<{ device: DeviceListResponse["devices"][number] }>(
        `/api/v1/devices/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: mutationHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ name }),
        },
      );
      return body.device;
    },
    async revokeDevice(id) {
      return reqNoBody(`/api/v1/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: mutationHeaders(),
      });
    },
    async resetAccess() {
      return req<{ token: string; revokedDevices: number }>("/access/reset", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ confirm: true }),
      });
    },
    async getSessionDefaults() {
      return req<SessionDefaultsEnvelope>("/settings/session-defaults", { headers: headers() });
    },
    async putSessionDefaults(defaults, expectedRevision) {
      return req<SessionDefaultsEnvelope>("/settings/session-defaults", {
        method: "PUT",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ defaults, expectedRevision }),
      });
    },
    async listSessions() {
      const body = await req<{ sessions: SessionMeta[] }>("/api/v1/sessions", { headers: headers() });
      return body.sessions;
    },
    async createSession(body) {
      return req<CreateSessionResponse>("/api/v1/sessions", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
    },
    async getSessionInputLease(id) {
      const body = await req<{ lease: SessionInputLease | null }>(
        `/api/v1/sessions/${encodeURIComponent(id)}/input-lease`,
        { headers: headers() },
      );
      return body.lease;
    },
    async changeSessionInputLease(id, input) {
      return req<SessionInputLeaseGrant>(`/api/v1/sessions/${encodeURIComponent(id)}/input-lease`, {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      });
    },
    async sendSessionInput(id, data, options = {}) {
      return req<{ accepted: true; focused: false }>(`/api/v1/sessions/${encodeURIComponent(id)}/input`, {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ data, ...options }),
      });
    },
    async getTeam() {
      return req<TeamEnvelope>("/api/v1/team", { headers: headers() });
    },
    async createTeam(name, ownerName) {
      return req<TeamEnvelope>("/api/v1/team", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ name, ...(ownerName ? { ownerName } : {}) }),
      });
    },
    async updateTeam(update) {
      const body = await req<{ team: TeamRecord }>("/api/v1/team", {
        method: "PATCH",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(update),
      });
      return body.team;
    },
    async listTeamMembers(includeRemoved = false) {
      const body = await req<{ members: Array<TeamMember & { roles: TeamRoleBinding[] }> }>(
        `/api/v1/team/members${includeRemoved ? "?includeRemoved=1" : ""}`,
        { headers: headers() },
      );
      return body.members;
    },
    async createTeamMember(input) {
      const body = await req<{ member: TeamMember; roles: TeamRoleBinding[] }>("/api/v1/team/members", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      });
      return { ...body.member, roles: body.roles };
    },
    async updateTeamMember(id, update) {
      const body = await req<{ member: TeamMember }>(`/api/v1/team/members/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(update),
      });
      return body.member;
    },
    async grantTeamRole(input) {
      const body = await req<{ binding: TeamRoleBinding }>("/api/v1/team/roles", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      });
      return body.binding;
    },
    async revokeTeamRole(id) {
      await reqNoBody(`/api/v1/team/roles/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: mutationHeaders(),
      });
    },
    async bindTeamPrincipal(input) {
      await req<{ binding: unknown }>("/api/v1/team/principals", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      });
    },
    async listTeamPrincipalBindings() {
      const body = await req<{ bindings: TeamPrincipalBinding[] }>("/api/v1/team/principals", {
        headers: headers(),
      });
      return body.bindings;
    },
    async unbindTeamPrincipal(actorType, actorId) {
      await reqNoBody("/api/v1/team/principals", {
        method: "DELETE",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ actorType, actorId }),
      });
    },
    async getEnterprisePolicy() {
      const body = await req<{ policy: EnterprisePolicy }>("/api/v1/policy", { headers: headers() });
      return body.policy;
    },
    async updateEnterprisePolicy(update) {
      const body = await req<{ policy: EnterprisePolicy }>("/api/v1/policy", {
        method: "PATCH",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(update),
      });
      return body.policy;
    },
    async getFleetInventory() {
      return req<FleetInventory>("/api/v1/fleet", { headers: headers() });
    },
    async listPeers() {
      const body = await req<{ peers: PeerRecord[] }>("/api/v1/peers", { headers: headers() });
      return body.peers;
    },
    async createPeer(input) {
      const body = await req<{ peer: PeerRecord }>("/api/v1/peers", {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ ...input, confirm: true }),
      });
      return body.peer;
    },
    async updatePeer(id, input) {
      const body = await req<{ peer: PeerRecord }>(`/api/v1/peers/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      });
      return body.peer;
    },
    async verifyPeer(id, expectedRevision) {
      const body = await req<{ peer: PeerRecord }>(`/api/v1/peers/${encodeURIComponent(id)}/verify`, {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ expectedRevision }),
      });
      return body.peer;
    },
    async discoverPeerWorkspaces(id, expectedRevision) {
      return req<{ peer: PeerRecord; workspaces: PeerWorkspace[] }>(
        `/api/v1/peers/${encodeURIComponent(id)}/discover`,
        {
          method: "POST",
          headers: mutationHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ expectedRevision }),
        },
      );
    },
    async rotatePeerCredential(id, access, expectedRevision) {
      const body = await req<{ peer: PeerRecord }>(`/api/v1/peers/${encodeURIComponent(id)}/credential`, {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          ...(typeof access === "string" ? { credential: access } : { pairingUrl: access.pairingUrl }),
          expectedRevision,
          confirm: true,
        }),
      });
      return body.peer;
    },
    async removePeer(id) {
      await reqNoBody(`/api/v1/peers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ confirm: true }),
      });
    },
    async listPeerWorkspaces(id) {
      const body = await req<{ workspaces: WorkspaceRecord[] }>(`/api/v1/peers/${encodeURIComponent(id)}/workspaces`, {
        headers: headers(),
      });
      return body.workspaces;
    },
    async listPeerAgents(id) {
      const body = await req<{ agents: AgentRecord[] }>(`/api/v1/peers/${encodeURIComponent(id)}/agents`, {
        headers: headers(),
      });
      return body.agents;
    },
    async listPeerSessions(id) {
      const body = await req<{ sessions: SessionMeta[] }>(`/api/v1/peers/${encodeURIComponent(id)}/sessions`, {
        headers: headers(),
      });
      return body.sessions;
    },
    async createPeerSession(peerId, body) {
      return req<CreateSessionResponse>(`/api/v1/peers/${encodeURIComponent(peerId)}/sessions`, {
        method: "POST",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
    },
    async getPeerSessionInputLease(peerId, sessionId) {
      const body = await req<{ lease: SessionInputLease | null }>(
        `/api/v1/peers/${encodeURIComponent(peerId)}/sessions/${encodeURIComponent(sessionId)}/input-lease`,
        { headers: headers() },
      );
      return body.lease;
    },
    async changePeerSessionInputLease(peerId, sessionId, input) {
      return req<SessionInputLeaseGrant>(
        `/api/v1/peers/${encodeURIComponent(peerId)}/sessions/${encodeURIComponent(sessionId)}/input-lease`,
        {
          method: "POST",
          headers: mutationHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(input),
        },
      );
    },
    async sendPeerSessionInput(peerId, sessionId, data, options = {}) {
      return req<{ accepted: true; focused: false }>(
        `/api/v1/peers/${encodeURIComponent(peerId)}/sessions/${encodeURIComponent(sessionId)}/input`,
        {
          method: "POST",
          headers: mutationHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ data, ...options }),
        },
      );
    },
    async waitPeerAgent(peerId, agentId, after = 0, timeoutMs = 30_000) {
      const params = new URLSearchParams({ after: String(after), timeoutMs: String(timeoutMs) });
      return req<{ agent: AgentRecord; timedOut: boolean }>(
        `/api/v1/peers/${encodeURIComponent(peerId)}/agents/${encodeURIComponent(agentId)}/wait?${params.toString()}`,
        { headers: headers() },
      );
    },
    async focusPeerAgent(peerId, agentId, mode = "request") {
      return req<{ accepted: true; focused: false; agentId: string; sessionId: string }>(
        `/api/v1/peers/${encodeURIComponent(peerId)}/agents/${encodeURIComponent(agentId)}/focus`,
        {
          method: "POST",
          headers: mutationHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ mode }),
        },
      );
    },
    async listAudit(after = 0, limit = 100) {
      return req<AuditPage>(`/api/v1/audit?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`, {
        headers: headers(),
      });
    },
    async listLatestAudit(limit = 20) {
      return req<AuditPage>(`/api/v1/audit?order=latest&limit=${encodeURIComponent(limit)}`, {
        headers: headers(),
      });
    },
    async verifyAudit() {
      return req<AuditVerification>("/api/v1/audit/verify", { headers: headers() });
    },
    async exportAudit(after = 0, limit = 1000) {
      return reqText(`/api/v1/audit/export?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`, {
        headers: headers({ accept: "application/x-ndjson" }),
      });
    },
    async listPresence(filter = {}) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
      const body = await req<{ presence: PresenceRecord[] }>(
        `/api/v1/presence${params.size > 0 ? `?${params.toString()}` : ""}`,
        { headers: headers() },
      );
      return body.presence;
    },
    async heartbeatPresence(input) {
      return req<{ presence: PresenceRecord; heartbeatMs: number }>("/api/v1/presence", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      });
    },
    async releasePresence(clientId) {
      await reqNoBody("/api/v1/presence", {
        method: "DELETE",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ clientId }),
      });
    },
    async deleteSession(id) {
      // 204 No Content — do NOT parse a body. A real failure (5xx/network) rejects via ApiError so the
      // caller can surface it / undo the optimistic removal.
      await reqNoBody(`/api/v1/sessions/${id}`, { method: "DELETE", headers: mutationHeaders() });
    },
    async renameSession(id, name) {
      // 204 No Content. Empty/whitespace → null, which CLEARS the server name (the contract treats
      // null/empty as "unset"); otherwise send the trimmed label (mirrors the local saveSessionName trim).
      const trimmed = name.trim();
      await reqNoBody(`/api/v1/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ name: trimmed === "" ? null : trimmed }),
      });
    },
    async listDir(path) {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      return req<DirListing>(`/fs/list${qs}`, { headers: headers() });
    },
    async mkdir(path) {
      // A 409 (exists) rejects via ApiError — the picker shows its inline "already exists" for it.
      return req<{ path: string }>("/fs/mkdir", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ path }),
      });
    },
    async searchDirs(q, base) {
      const params = new URLSearchParams({ q });
      if (base) params.set("base", base);
      const body = await req<{ results: FsSearchResult[] }>(`/fs/search?${params.toString()}`, {
        headers: headers(),
      });
      return body.results;
    },
    async uploadFile(dir, file) {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetchRequest(`${baseUrl}/fs/upload?dir=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: headers(), // do NOT set content-type; the browser sets the multipart boundary
        body: form,
      });
      if (!res.ok) {
        let message = `upload failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // ignore
        }
        throw new ApiError(res.status, message);
      }
      return (await res.json()) as { path: string };
    },
    async uploadImage(file) {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetchRequest(`${baseUrl}/images`, {
        method: "POST",
        headers: headers(), // do NOT set content-type; the browser sets the multipart boundary
        body: form,
      });
      if (!res.ok) throw await errorFor(res);
      return (await res.json()) as { ref: string };
    },
    downloadUrl(path) {
      const token = getToken();
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
      return `${baseUrl}/fs/download?path=${encodeURIComponent(path)}${tokenParam}`;
    },
    mediaUrl(relativePath) {
      const token = getToken();
      // The relative ref already includes a `?` query, so append the token with `&` (or `?` defensively
      // if a future ref has none). The browser's <img> GET can't set an Authorization header, so the
      // token MUST travel as a query param (the server's auth gate accepts `?token=`).
      const sep = relativePath.includes("?") ? "&" : "?";
      const tokenParam = token ? `${sep}token=${encodeURIComponent(token)}` : "";
      return `${baseUrl}${relativePath}${tokenParam}`;
    },
    async getVapidPublicKey() {
      const body = await req<{ publicKey: string }>("/push/vapid", { headers: headers() });
      return body.publicKey;
    },
    async subscribePush(sub) {
      await req<{ ok: true }>("/push/subscribe", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }),
      });
    },
    async unsubscribePush(endpoint) {
      await req<{ ok: true }>("/push/unsubscribe", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ endpoint }),
      });
    },
    async sendPushTest() {
      await reqNoBody("/push/test", { method: "POST", headers: headers() });
    },
    async getVersion(force?: boolean) {
      return req<VersionInfo>(`/version${force ? "?force=1" : ""}`, { headers: headers() });
    },
    getProviders,
    getProviderModels,
    getProviderProfiles,
    getProviderUsage,
    getProviderVersion,
    getProviderAuthStatus,
    startProviderLogin,
    getProviderLoginStatus,
    cancelProviderLogin,
    async applyUpdate(target?: string) {
      // The server verifies the matching release manifest + npm integrity before activation.
      return req<UpdateStartResponse>("/update", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ confirm: true, ...(target ? { target } : {}) }),
      });
    },
    async getUpdateStatus() {
      return req<UpdateStatus>("/update/status", { headers: headers() });
    },
    async rollbackUpdate() {
      // Same confirm double-gate as applyUpdate (a server-restarting action); rejects with ApiError on
      // 409/400 when there's no previous build recorded — the caller shows the human message.
      return req<UpdateStartResponse>("/update/rollback", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ confirm: true }),
      });
    },
    async getUsage() {
      return getProviderUsage("claude");
    },
    async getModels() {
      return getProviderModels("claude");
    },
    async rotateToken() {
      // Persistence belongs to the caller because a command-center browser may hold several isolated host
      // credentials. Writing the legacy current-origin key here would let rotating host B overwrite host A.
      const body = await req<{ token: string }>("/token/rotate", { method: "POST", headers: headers() });
      return body.token;
    },
    async getAuthStatus() {
      return getProviderAuthStatus("claude");
    },
    async startAuthLogin() {
      return startProviderLogin("claude");
    },
    async submitAuthCode(loginId, code) {
      return req<{ ok: boolean; message?: string }>("/auth/login/code", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ loginId, code }),
      });
    },
    async cancelAuthLogin() {
      await cancelProviderLogin("claude");
    },
    async getClaudeVersion() {
      return getProviderVersion("claude");
    },
  };
}
