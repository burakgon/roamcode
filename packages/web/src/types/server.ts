// Client-side mirror of the server's REST contract types (SessionMeta, VersionInfo, UsageInfo,
// ClaudeAuthStatus, DirListing, …). Kept as a standalone type module so the browser bundle never
// imports the Node server package.

import type { CodexIdentityState, ProviderDescriptor, ProviderId } from "../providers/types";

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  /** Absent on older hosts; direct is the compatibility default. */
  scopes?: Array<"direct" | "relay">;
  relayIdentityFingerprint?: string;
}

export interface DeviceListResponse {
  devices: DeviceInfo[];
  /** Absent when this browser still uses the legacy host token rather than a revocable device key. */
  currentDeviceId?: string;
}

export interface PairingStartResponse {
  secret: string;
  expiresAt: number;
  scopes?: Array<"direct" | "relay">;
}

export interface DeviceEnrollment {
  token: string;
  device: DeviceInfo;
}

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
  kind: "directory" | "worktree";
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  agentCount?: number;
  attentionCount?: number;
  urgency?: number;
}

export interface WorktreeRecord {
  path: string;
  repositoryPath: string;
  branch?: string;
  head: string;
  dirty: boolean;
  changedFiles: number;
  isMain: boolean;
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

export interface AttentionResponse {
  items: AttentionItem[];
  unreadCount: number;
}

export interface CommandEvent {
  id: number;
  type: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface CommandEventsResponse {
  events: CommandEvent[];
  nextCursor: number;
}

export interface CommandLayoutEnvelope<T = Record<string, unknown>> {
  document: T | null;
  revision: number;
  updatedAt?: number;
}

export interface CommandCenterCapabilities {
  apiVersion: "v1";
  protocolVersion: number;
  serverVersion: string;
  serverTime: number;
  host: HostRecord;
  features: {
    workspaces: boolean;
    agents: boolean;
    attention: boolean;
    resumableEvents: boolean;
    sharedLayout?: boolean;
    idempotentMutations?: boolean;
    integrityAudit?: boolean;
    automations?: boolean;
    devicePairing: boolean;
    directMultiHost: boolean;
    inputLeases?: boolean;
    multiObserver?: boolean;
    teamAuthorization?: boolean;
    enterprisePolicy?: boolean;
    fleetInventory?: boolean;
    peerFederation?: boolean;
    presence?: boolean;
    relay: boolean;
    plugins: boolean;
  };
  providers: ProviderDescriptor[];
}

export interface RelayStatusResponse {
  configured: boolean;
  pairingAvailable: boolean;
  status: "not-configured" | "idle" | "connecting" | "online" | "reconnecting" | "stopped";
  activeDevices: number;
  reconnects: number;
}

export interface CloudStatusResponse {
  v: 1;
  mode: "self-hosted" | "managed";
  configured: boolean;
  sync: {
    state: "not-configured" | "syncing" | "healthy" | "pending" | "degraded" | "expired";
    lastSuccessfulAt: number | null;
  };
  authorization: {
    status: "not-configured" | "unavailable" | "pending" | "active" | "expired";
    revision: number | null;
    expiresAt: number | null;
    expired: boolean;
  };
  action:
    | "none"
    | "wait-for-cloud-sync"
    | "wait-for-authorization-activation"
    | "check-host-connectivity"
    | "reauthorize-host"
    | "contact-organization-admin";
}

/** Server-authoritative choices remembered from the most recently created session. */
export interface SessionDefaults {
  provider?: ProviderId;
  effort: string;
  model?: string;
  dangerouslySkip: boolean;
  permissionMode?: string;
  addDirs?: string[];
  codex?: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-request" | "never";
    profile?: string;
    webSearch?: boolean;
    addDirs?: string[];
    dangerouslyBypassApprovalsAndSandbox?: boolean;
  };
}

/** Revisioned remembered-choices document returned by GET /settings/session-defaults. */
export interface SessionDefaultsEnvelope {
  defaults: SessionDefaults | null;
  revision: number;
  updatedAt?: number;
}

/** One selectable model the account offers (mirror of the server's ModelOption, from the init handshake). */
export interface ModelOption {
  value: string;
  displayName: string;
  description?: string;
  supportedEffortLevels?: string[];
}

export interface SessionMeta {
  id: string;
  /** Absent only for legacy server payloads; display boundaries interpret an absent value as Claude. */
  provider?: ProviderId;
  cwd: string;
  /** SERVER-side session name (PATCH /sessions/:id {name}) — the cross-device source of truth. Absent =
   *  never named; the client falls back to its legacy localStorage label, then the cwd basename
   *  (session/names.ts displaySessionName owns that priority). */
  name?: string;
  model?: string;
  /** The account's available models (from the live session's init handshake) — drives a real model picker
   *  instead of free-text. Absent on cold/old sessions; the client falls back to a curated static list. */
  availableModels?: ModelOption[];
  effort?: string;
  /** True when this session was spawned with `--dangerously-skip-permissions` (the CLI runs tool calls
   *  without prompting). Server truth in every GET /sessions item; the rail surfaces a loud per-row
   *  "skip-perms" warning so an armed session is never mistaken for a normal one. */
  dangerouslySkip: boolean;
  /** `running` = a live PTY. `ended` = the session exited/crashed (server-emitted for a dead terminal).
   *  dormant/errored/stopped are legacy states the server no longer emits (kept for back-compat). */
  status: "running" | "ended" | "dormant" | "errored" | "stopped";
  createdAt: number;
  /** The `claude` CLI version this session is running on (e.g. "2.1.187"), captured at spawn. Absent on
   *  dormant/old sessions. Shown compactly in Settings; compared to /claude/version's `latest` for the
   *  subtle "update available" hint. */
  claudeVersion?: string;
  permissionMode?: string;
  /** Codex-native safety settings, absent for Claude and older server payloads. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  /**
   * Server truth: claude is blocked on YOUR decision (a permission or plan prompt) for this session — TRUE
   * even for sessions the client is NOT actively connected to (the meta carries it). Drives the rail's
   * "needs you" row indicator + the global badge, so attention is visible from anywhere. Optional so older
   * payloads (and test fixtures) default to "not awaiting".
   */
  awaiting?: boolean;
  /**
   * Server truth: the session's LIVE activity from the capture-pane monitor. Drives the rail's per-running-row
   * status word: "working" (generating — main spinner OR background agents still developing), "blocked" (claude
   * is waiting on YOUR decision → the loud "needs you", mirrors `awaiting`), "idle" (a finished turn at an empty
   * prompt — calm). Optional so older payloads / fixtures degrade gracefully (treated as "idle").
   */
  activity?: "working" | "blocked" | "idle";
  /**
   * Server truth (ms): bumped on user-send AND on assistant/result, monotonic. Drives most-recent-first
   * ordering only in Recent activity mode and remains the relative-time source in Stable (created) mode;
   * a missing value falls back to `createdAt`. Optional so older payloads / fixtures degrade gracefully.
   */
  lastActivityAt?: number;
  /** Session kind — always "terminal" (a PTY-backed claude TUI over the binary terminal WebSocket).
   *  Optional so older payloads / fixtures degrade gracefully. */
  mode?: "terminal";
  /** Codex identity proof state. Absent for Claude sessions and legacy server payloads. */
  identityState?: CodexIdentityState;
  /** Adapter contract for safe continuation. Absent on older servers; Codex remains required by compatibility. */
  resumeIdentity?: "optional" | "required" | "unsupported";
  /** Exact provider-owned resume id when the server has safely established one. */
  providerSessionId?: string;
  /** Stable command-center placement. Absent when connected to a pre-command-center server. */
  workspaceId?: string;
  agentId?: string;
  agentActivity?: AgentActivity;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  gitBranch?: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

/**
 * OTA self-update (server-side mirror: packages/server/src/updater.ts). GET /version reports whether a
 * a newer stable GitHub Release exists and its grouped release notes; POST /update installs the exact
 * npm version into the managed runtime; GET /update/status reports the updater's progress.
 */
export interface ChangelogEntry {
  id: string;
  version: string;
  subject: string;
  group: "new" | "fixes" | "improvements" | "other";
  when: string;
  date: string;
}

export interface VersionInfo {
  current: string;
  latest: string;
  behind: number;
  releaseCount: number;
  /** False for an unmanaged foreground process; `roamcode install` enables the managed runtime. */
  updatable: boolean;
  updateAvailable: boolean;
  updateAction: "none" | "migrate" | "update" | "restart";
  installation: "managed" | "legacy-git" | "unmanaged";
  rollbackAvailable?: boolean;
  changelog: ChangelogEntry[];
  runningVersion: string;
  activeVersion?: string;
  installDrift: boolean;
  checkStatus: "fresh" | "stale" | "error";
  checkedAt?: number;
  error?: string;
  /** One-release compatibility aliases for an already-precached v0 client. */
  runningBuild: string;
  buildDrift: boolean;
  /** True when the server can spawn PTY-backed terminal sessions (the `terminal` mode feature). Gates
   * the wizard's Chat/Terminal toggle. Absent (older servers) is treated as unavailable. */
  terminalAvailable?: boolean;
}

export type UpdateState =
  "idle" | "starting" | "downloading" | "installing" | "verifying" | "activating" | "restarting" | "done" | "failed";

export interface UpdateStatus {
  operationId?: string;
  state: UpdateState;
  phase?: string;
  error?: string;
  target?: string;
  fromVersion?: string;
  log?: string;
  updatedAt?: number;
}

/** Accepted POST /update or /update/rollback response. The operation id prevents stale status files
 * from a previous attempt from being rendered as the progress of the new one. */
export interface UpdateStartResponse {
  ok: true;
  state: "starting";
  operationId: string;
  target: string;
}

/**
 * Claude usage limits (server-side mirror: packages/server/src/usage-service.ts). GET /usage reports the
 * 5-hour SESSION limit + the WEEKLY limit (all models) + optional provider-named weekly limits. Reset
 * strings may be absent while a window remains unused. `usage` is null when the feature is unavailable
 * (claude not logged in / not installed / parse failed) — the UI then hides the bars.
 */
export interface UsageBar {
  /** Percent of the limit used (0–100). */
  percent: number;
  /** Human reset string when supplied, e.g. "Jun 25 at 11:30pm (Europe/Istanbul)". */
  resets?: string;
}

export interface ModelWeekUsageBar extends UsageBar {
  model: string;
}

export interface UsageInfo {
  /** The rolling 5-hour session limit. */
  session?: UsageBar;
  /** The weekly limit across all models. */
  week?: UsageBar;
  /** Provider-named weekly buckets such as Fable or the legacy Sonnet-only limit. */
  weekModels?: ModelWeekUsageBar[];
  /** The Sonnet-only weekly limit (optional; not always present). */
  weekSonnet?: UsageBar;
  /** Server clock (ms) when the snapshot was parsed. */
  fetchedAt: number;
}

/** One deep-search hit from GET /fs/search?q=&base= — a directory somewhere UNDER `base` whose name
 *  matches `q` (≤30 results, shallowest-first). Drives the picker's "Deeper matches" section. */
export interface FsSearchResult {
  path: string;
  name: string;
  isGitRepo: boolean;
}

/** One selectable model from GET /models (server-normalized from the CLI init response). */
export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
  supportedEffortLevels?: string[];
  isDefault?: boolean;
}

/** GET /auth/status — the server-side Claude sign-in state. `available:false` means the feature is off
 *  (no claude bin / a test server). `loggedIn` reflects stored creds existing (NOT that they still work —
 *  expired creds report loggedIn:true yet 401 on use, so the UI always offers re-authentication). */
export interface ClaudeAuthStatus {
  available: boolean;
  loggedIn?: boolean;
  email?: string;
  subscriptionType?: string;
  authMethod?: string;
  orgName?: string;
}
