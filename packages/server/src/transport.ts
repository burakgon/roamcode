import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { basename as pathBasename, join, resolve as resolvePath } from "node:path";
import { createReadStream } from "node:fs";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { FsService, FsError } from "./fs-service.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { WebSocket } from "ws";
import { AuthGate, extractBearerToken } from "./auth.js";
import { isOriginAllowed, normalizeOrigin } from "./origin-check.js";
import { RateLimiter } from "./rate-limit.js";
import { generateAccessToken, persistAccessToken } from "./data-dir.js";
import { registerStatic, isPublicPath, isShellPath, pathForGate, hasEncodedSep } from "./static-routes.js";
import { WsTicketStore } from "./ws-ticket.js";
import { stat } from "node:fs/promises";
import type { ServerRuntimeConfig } from "./server-config.js";
import type { SessionStore, StoreMode, StoredSessionFile, SessionFileKind } from "./session-store.js";
import {
  TERMINAL_FILE_TTL_MS,
  TERMINAL_SWEEP_INTERVAL_MS,
  terminalSharedBase,
  terminalSharedDir,
} from "./terminal-shared.js";
import type { PushStore } from "./push-store.js";
import { DevicePairingError, normalizeDeviceName, normalizeDeviceScopes, openDeviceStore } from "./device-store.js";
import type { DeviceScope, DeviceStore, PairingTicket } from "./device-store.js";
import { generateRelayCredential, relayCredentialHash } from "./relay-store.js";
import { buildRelayPairingUrl, type RelayPairingBootstrap, type RelayPairingPackage } from "./relay-pairing.js";
import {
  CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE,
  CloudDeviceEnrollmentError,
  CloudDeviceEnrollmentRequestSchema,
  type CloudDeviceEnrollmentConfirmer,
} from "./cloud-device-enrollment.js";
import { CommandCenterRevisionConflictError, openCommandCenterStore } from "./command-center-store.js";
import type { AgentActivity, AttentionKind, CommandCenterStore, CommandEvent } from "./command-center-store.js";
import { CONTROL_IDEMPOTENCY_TTL_MS, openControlStore } from "./control-store.js";
import { normalizeAutomationInput } from "./control-store.js";
import type {
  AuditActorType,
  AutomationDefinition,
  AutomationRun,
  ControlStore,
  UpdateAutomationInput,
} from "./control-store.js";
import {
  openSessionAutomationStore,
  SessionAutomationRevisionConflictError,
  type SessionAutomationDefinition,
  type SessionAutomationConfiguredTrigger,
  type SessionAutomationActivity,
  type SessionAutomationRun,
  type SessionAutomationStore,
  type UpdateSessionAutomationInput,
} from "./session-automation-store.js";
import { createAutomationTriggerEngine, validateCronExpression } from "./automation-trigger-engine.js";
import {
  agentRuntimeId,
  productContextFromOwner,
  projectAgentRuntimeRecords,
  projectNodeRecord,
  type AgentRuntimeAuthState,
  type NodeAlias,
  type OwnerRef,
} from "./node-domain.js";
import type { PushDispatcher, PushEvent } from "./push-dispatch.js";
import { createUpdater, RUNNING_VERSION } from "./updater.js";
import type { Updater } from "./updater.js";
import { createClaudeVersionProbe, defaultRunClaudeVersion, normalizeProviderAvailability } from "./diag.js";
import type { ClaudeVersionProbe } from "./diag.js";
import type { UsageService } from "./usage-service.js";
import type { ClaudeAuthService } from "./claude-auth-service.js";
import type { ClaudeLatestService } from "./claude-latest-service.js";
import { TerminalManager } from "./terminal-manager.js";
import { detectTerminalSupport } from "./terminal-capability.js";
import { listTmuxSessions } from "./tmux-list.js";
import { openSessionStore } from "./session-store.js";
import { parseLegacyClaudeArgs, parseProviderOptions, ProviderOptionsError } from "./providers/options.js";
import {
  ProviderError,
  type ProviderAvailability,
  type ProviderId,
  type ProviderSessionOptions,
} from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createClaudeProvider } from "./providers/claude-provider.js";
import { createCodexProvider } from "./providers/codex-provider.js";
import type { CodexMetadataService } from "./providers/codex-metadata-service.js";
import type { ClaudeMetadataService } from "./providers/claude-metadata-service.js";
import type { CodexLatestService } from "./providers/codex-latest-service.js";
import type { CodexThreadResolver } from "./providers/codex-thread-resolver.js";
import {
  normalizeSessionDefaults,
  sessionDefaultsForLaunch,
  SessionDefaultsConflictError,
} from "./session-defaults.js";
import { buildOpenApiDocument } from "./openapi.js";
import { createWorktreeService, WorktreeError } from "./worktree-service.js";
import type { WorktreeService } from "./worktree-service.js";
import { createInstalledAdapterProvider } from "./providers/installed-adapter-provider.js";
import {
  ExtensionError,
  inspectExtensionPackage,
  openExtensionManager,
  searchMarketplace,
} from "./extension-manager.js";
import type { ExtensionKind, ExtensionManager, MarketplaceEntry } from "./extension-manager.js";
import { createPluginRuntime, PluginRuntimeError } from "./plugin-runtime.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import { InputLeaseCoordinator } from "./input-lease.js";
import type { InputLeaseEvent, InputLeasePrincipal } from "./input-lease.js";
import {
  isTeamRole,
  isTeamScopeType,
  openTeamStore,
  teamRolePermissions,
  TeamRevisionConflictError,
} from "./team-store.js";
import type { TeamPermission, TeamPrincipalType, TeamStore } from "./team-store.js";
import { createCompositeAuthorizer, type CompositeAuthorizer } from "./composite-authorization.js";
import type { CloudHostRuntimeStatus } from "./cloud-host-runtime.js";
import type { CloudAutomationInvocation, CloudAutomationWebhookRegistration } from "./cloud-contract.js";
import type { CloudAuthorizationStore } from "./cloud-authorization-store.js";
import { EnterprisePolicyRevisionConflictError, evaluateEnterprisePolicy, openPolicyStore } from "./policy-store.js";
import type {
  EnterprisePolicyAction,
  EnterprisePolicyContext,
  EnterprisePolicyUpdate,
  PolicyStore,
} from "./policy-store.js";
import { normalizePeerBaseUrl, openPeerStore, PeerRevisionConflictError } from "./peer-store.js";
import type { PeerAction, PeerConnection, PeerStore, UpdatePeerInput } from "./peer-store.js";
import {
  claimPeerPairing,
  type ClaimedPeerCredential,
  PeerRequestError,
  requestPeerJson,
  revokeClaimedPeerDevice,
  verifyPeerConnection,
} from "./peer-client.js";
import { PresenceCoordinator, PRESENCE_HEARTBEAT_MS } from "./presence.js";
import { relayRpcResponse, type RelayRpcRequest, type RelayRpcResponse } from "./relay-rpc.js";

/** Terminal WS guards. Input: cap a single frame so a client can't force a huge alloc / flood the pty (1MB
 *  still allows large pastes). Output: if the client buffers more than this undrained, close (it reconnects
 *  and tmux redraws) rather than grow Node's heap unbounded on a slow link. */
const MAX_TERMINAL_INPUT_BYTES = 1_000_000;
const MAX_PEER_INPUT_BYTES = 64 * 1024;
const MAX_PENDING_TERMINAL_INPUT_FRAMES = 64;
const MAX_PENDING_TERMINAL_INPUT_BYTES = 1_000_000;
const MAX_TERMINAL_WS_BUFFER = 16_000_000;
/** Server→client WS ping cadence. An idle terminal (no output, no keystrokes) carries zero WS traffic, so
 *  a fronting proxy with a short idle cap could drop the connection and force the client to flap through a
 *  reconnect. A periodic ping keeps the link warm (the browser auto-pongs), below common proxy timeouts. */
const TERMINAL_WS_PING_MS = 25_000;
const INPUT_LEASE_RENEW_MS = 10_000;
const TERMINAL_AUTHORIZATION_RECHECK_MS = 5_000;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function mutationFingerprint(method: string, concretePath: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method}\0${concretePath}\0${canonicalJson(body)}`)
    .digest("hex");
}

function usesDangerousProviderMode(options: ProviderSessionOptions): boolean {
  const values = options as unknown as Record<string, unknown>;
  if (
    values.dangerouslySkip === true ||
    values.dangerouslyBypassApprovalsAndSandbox === true ||
    values.permissionMode === "bypassPermissions" ||
    values.sandbox === "danger-full-access"
  ) {
    return true;
  }
  // Installed adapters use their own validated flat option schema. Policy remains fail-closed for conventionally
  // named bypass controls until the adapter contract grows an explicit risk annotation.
  return Object.entries(values).some(
    ([key, value]) => /(?:danger|bypass|unrestricted)/i.test(key) && (value === true || value === "enabled"),
  );
}

const TEXT_FILE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "xml",
  "csv",
  "tsv",
  "log",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "scss",
  "html",
  "htm",
  "sql",
  "sh",
  "bash",
  "zsh",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "env",
  "ini",
  "conf",
]);
const IMAGE_FILE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
  "apng",
  "heic",
  "heif",
]);
// File history is auxiliary to the live terminal. A slow/unavailable workspace mount must never hold the
// inventory response (and therefore the chat UI) hostage. Legacy discovery continues in the background after
// this small first-request budget; availability checks are optimistic on timeout and fail definitively only
// when the filesystem answers with an error inside the budget.
const FILE_HISTORY_BACKFILL_BUDGET_MS = 150;
const FILE_HISTORY_AVAILABILITY_BUDGET_MS = 150;

function completionWithin(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void task.then(
      () => finish(true),
      () => finish(false),
    );
  });
}

function attachmentMedia(
  filename: string,
  declared = "application/octet-stream",
): { mimeType: string; kind: SessionFileKind } {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "";
  if (declared.startsWith("image/") || IMAGE_FILE_EXTENSIONS.has(ext)) {
    const inferred =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "svg"
          ? "image/svg+xml"
          : ext
            ? `image/${ext}`
            : declared;
    return { mimeType: declared.startsWith("image/") ? declared : inferred, kind: "image" };
  }
  if (declared === "application/pdf" || ext === "pdf") return { mimeType: "application/pdf", kind: "pdf" };
  if (declared.startsWith("text/") || TEXT_FILE_EXTENSIONS.has(ext)) {
    // Text is previewed as escaped text in the client. Never reflect an uploaded text/html MIME as an
    // executable same-origin document from the authenticated file endpoint.
    return { mimeType: "text/plain; charset=utf-8", kind: "text" };
  }
  return { mimeType: declared || "application/octet-stream", kind: "binary" };
}

function publicSessionFile(
  file: StoredSessionFile,
  available = true,
): StoredSessionFile & { isImage: boolean; available: boolean } {
  return { ...file, isImage: file.kind === "image", available };
}

export interface CreateServerDeps {
  store?: SessionStore;
  /** Durable per-device credentials + one-time pairing sessions. start.ts supplies a SQLite store. */
  deviceStore?: DeviceStore;
  /** Durable host/workspace/agent/attention/event state. start.ts supplies a SQLite store. */
  commandStore?: CommandCenterStore;
  /** Durable idempotency, privacy-safe audit, and automation definitions/runs. */
  controlStore?: ControlStore;
  /** Durable coding automations that launch real terminal Sessions on one exact Node/runtime/cwd. */
  sessionAutomationStore?: SessionAutomationStore;
  /** Guarded git worktree lifecycle, confined to FS_ROOT and injectable for isolated tests. */
  worktreeService?: WorktreeService;
  /** Durable verified adapter/plugin package inventory. start.ts supplies a SQLite-backed manager. */
  extensionManager?: ExtensionManager;
  /** Bounded, permissioned plugin subprocess boundary. */
  pluginRuntime?: PluginRuntime;
  /** Optional immutable marketplace index; local extension installation never depends on it. */
  marketplaceEntries?: MarketplaceEntry[];
  /** Absolute path to the built PWA (packages/web/dist). When set, the server also serves the UI. */
  webDir?: string;
  /** Per-process boot identity returned as a response header for the out-of-process managed watchdog. */
  healthInstanceId?: string;
  pushStore?: PushStore;
  /** VAPID public key exposed at GET /push/vapid for the browser subscription. */
  vapidPublicKey?: string;
  /**
   * Away-from-desk Web Push dispatcher (fan-out for awaiting/finished/file events). Wired by start.ts
   * from the push store + VAPID keys. When omitted (tests / push not configured) the "get pinged" side of
   * the loop is simply a no-op — every route/heuristic still functions, it just sends no notifications.
   */
  pushDispatcher?: PushDispatcher;
  /**
   * In-app OTA self-update (GET /version, POST /update, GET /update/status). Injected so tests can use a
   * fixture release feed without network access. When omitted, a real stable-release updater is built.
   */
  updater?: Updater;
  /**
   * Claude usage limits (GET /usage → the session + weekly bars). Injected here so tests can pass a
   * fake (no real `claude` spawn). When omitted the route reports `usage:null` (the feature is off in
   * the UI). A real UsageService is wired by start.ts from the configured claude bin + the server env.
   */
  usage?: UsageService;
  /**
   * In-app Claude re-authentication (GET /auth/status, POST /auth/login/start|code|cancel). Injected so
   * tests can pass a fake (no real `claude auth` spawn). When omitted the auth routes report "unavailable"
   * (the UI hides the sign-in). A real ClaudeAuthService is wired by start.ts from the claude bin + env.
   */
  claudeAuth?: ClaudeAuthService;
  /**
   * The latest published claude CLI version (GET /claude/version → {installed, latest}), for update
   * awareness. Injected so tests don't hit the npm registry; absent → latest:null (the UI hides the hint).
   */
  claudeLatest?: ClaudeLatestService;
  /**
   * How the session store is actually backed — "sqlite" (durable) or "memory-fallback" (better-sqlite3
   * failed to load; NOT durable across restarts). Surfaced by the authed GET /diag for fleet observability.
   * Threaded from start.ts (it opens the store). Defaults to "sqlite" when omitted.
   */
  storeMode?: StoreMode;
  /**
   * Cached best-effort `claude --version` probe for the authed GET /diag. Injected so tests pass a fake
   * (no real spawn). When omitted a real probe is built from the configured claude bin + server env.
   */
  claudeVersionProbe?: ClaudeVersionProbe;
  /**
   * Global per-client request rate limiter (token bucket). Injected so tests can drive an injectable clock
   * / a tiny limit. When omitted one is built from `config.rateLimitRpm`/`config.rateLimitBurst` (a
   * rpm of 0 disables it). Applied in the global preHandler AFTER the auth gate + origin check.
   */
  rateLimiter?: RateLimiter;
  /**
   * CSPRNG token generator for POST /token/rotate (reuses data-dir.ts's default). Injected so tests get a
   * deterministic rotated token. When omitted, resolveAccessToken's default 32-byte base64url generator.
   */
  generateToken?: () => string;
  /**
   * The token gate. Injected so tests can control the rotation grace window / clock (e.g. graceMs:0 to
   * assert the OLD token is rejected the instant after rotation). When omitted one is built from
   * `config.accessToken` with the default 60s rotation grace.
   */
  authGate?: AuthGate;
  /**
   * Whether terminal mode (tmux + node-pty) is available on this host. Injected so tests can force it
   * on/off without real tmux/pty. When omitted, detectTerminalSupport() is called at boot.
   */
  terminalAvailable?: boolean;
  /**
   * Terminal session manager (injectable for tests; a real one is constructed from deps.store +
   * config.claude.claudeBin when omitted).
   */
  terminalManager?: TerminalManager;
  /** Exact provider registry shared with the terminal manager and provider capability routes. */
  providers?: ProviderRegistry;
  /** Auxiliary Codex app-server metadata. Its failure never disables terminal sessions. */
  codexMetadata?: CodexMetadataService;
  /** Auxiliary Claude model metadata. Its failure never disables terminal sessions. */
  claudeMetadata?: ClaudeMetadataService;
  /** Cached aggregate of every stable Codex metadata method/schema used by this server. */
  codexCapabilityProbe?: { get(): Promise<boolean> };
  /** Installation-aware Codex version/update service. */
  codexLatest?: CodexLatestService;
  codexThreadResolver?: (cwd: string) => CodexThreadResolver;
  disposeProviders?: () => void | Promise<void>;
  /**
   * Single-use terminal-WS ticket store (POST /ws-ticket → `?ticket=` on the WS URL, so the long-lived
   * token stays OUT of WS URLs / proxy logs). Injectable so tests drive the clock/TTL; a real 30s-TTL
   * store is built when omitted.
   */
  wsTickets?: WsTicketStore;
  /** One-writer/many-observer terminal input coordinator. Injectable for deterministic multi-client tests. */
  inputLeases?: InputLeaseCoordinator;
  /** Managed-cloud terminal authorization poll cadence. Injectable only so socket revocation tests stay fast. */
  terminalAuthorizationRecheckMs?: number;
  /** Team policy seam: direct local mode permits confirmed takeover; enterprise policy can deny it here. */
  authorizeInputTakeover?: (principal: InputLeasePrincipal, sessionId: string) => boolean;
  /** Optional policy seam for acquiring/writing input. Team RBAC is applied in addition when enabled. */
  authorizeInputWrite?: (principal: InputLeasePrincipal, sessionId: string) => boolean;
  /** Durable team membership and role assignments. start.ts supplies SQLite; tests may inject memory. */
  teamStore?: TeamStore;
  /** Additive local-team + signed-cloud authorization. Omit to preserve exact self-hosted TeamStore behavior. */
  authorizer?: CompositeAuthorizer;
  /** Durable organization policy. Disabled by default; enforced uniformly when explicitly enabled. */
  policyStore?: PolicyStore;
  /** Durable, explicitly scoped host-to-host API connections. Raw peer credentials never leave this store. */
  peerStore?: PeerStore;
  /** Isolated outbound peer transport; injectable so tests never contact developer or production hosts. */
  peerFetch?: typeof globalThis.fetch;
  /** Ephemeral, bounded presence heartbeats. */
  presence?: PresenceCoordinator;
  /** Advertises and enforces that this host has an outbound blind-relay transport configured. */
  relayEnabled?: boolean;
  /** Privacy-bounded connector health for the authenticated settings UI. */
  relayStatus?: () => {
    status: "idle" | "connecting" | "online" | "reconnecting" | "stopped";
    activeChannels: number;
    reconnects: number;
  };
  /** Privacy-safe managed-host sync status. Presence means cloud management is configured. */
  cloudStatus?: () => CloudHostRuntimeStatus;
  /** Signed managed-cloud authorization authority, used only for read-only Node grant projection. */
  cloudAuthorizationStore?: CloudAuthorizationStore;
  /** Managed ownership remains read-only/fail-closed even if its signed cloud store is temporarily unavailable. */
  managedAuthorization?: boolean;
  /** Canonical product ownership for this Node. Local installs default to the Personal context. */
  nodeOwner?: OwnerRef;
  /** Non-authoritative connection identifiers that resolve to this persistent command-host Node. */
  nodeAliases?: readonly NodeAlias[];
  /** Product context label; never used as an authorization decision. */
  nodeOwnerName?: string;
  /** Optional hosted/self-hosted bootstrap; absent means relay works for already-provisioned devices only. */
  relayPairing?: RelayPairingBootstrap;
  /**
   * Optional hosted control-plane bridge. The request actor always comes from DeviceStore authentication;
   * clients can supply only their one-use enrollment challenge.
   */
  cloudDeviceEnrollmentConfirmer?: CloudDeviceEnrollmentConfirmer;
  /** Late-bound host connector hook so device revocation closes relay channels immediately. */
  onDeviceRevoked?: (deviceId: string) => void;
}

export type CloudStatusSyncState = "not-configured" | "syncing" | "healthy" | "pending" | "degraded" | "expired";
export type CloudStatusRecoveryAction =
  | "none"
  | "wait-for-cloud-sync"
  | "wait-for-authorization-activation"
  | "check-host-connectivity"
  | "reauthorize-host"
  | "contact-organization-admin";

export interface CloudStatusResponse {
  v: 1;
  mode: "self-hosted" | "managed";
  configured: boolean;
  sync: { state: CloudStatusSyncState; lastSuccessfulAt: number | null };
  authorization: {
    status: "not-configured" | CloudHostRuntimeStatus["authorization"]["status"];
    revision: number | null;
    expiresAt: number | null;
    expired: boolean;
  };
  action: CloudStatusRecoveryAction;
}

export function cloudStatusResponse(status?: CloudHostRuntimeStatus): CloudStatusResponse {
  if (!status) {
    return {
      v: 1,
      mode: "self-hosted",
      configured: false,
      sync: { state: "not-configured", lastSuccessfulAt: null },
      authorization: { status: "not-configured", revision: null, expiresAt: null, expired: false },
      action: "none",
    };
  }

  const authorization = status.authorization;
  const syncFailures =
    status.authorizationFailures > 0 || status.heartbeatFailures > 0 || status.automationFailures > 0;
  const syncState: CloudStatusSyncState =
    authorization.status === "expired"
      ? "expired"
      : authorization.status === "pending"
        ? "pending"
        : authorization.status === "unavailable"
          ? syncFailures
            ? "degraded"
            : "syncing"
          : syncFailures
            ? "degraded"
            : "healthy";
  const action: CloudStatusRecoveryAction =
    status.authorizationIssue === "credential-rejected" || status.authorizationIssue === "trust-expired"
      ? "reauthorize-host"
      : status.authorizationIssue === "invalid-control-plane-response" ||
          status.authorizationIssue === "authorization-verification-failed"
        ? "contact-organization-admin"
        : status.authorizationIssue === "connectivity"
          ? "check-host-connectivity"
          : status.heartbeatFailures > 0 || status.automationFailures > 0
            ? "check-host-connectivity"
            : authorization.status === "unavailable"
              ? "wait-for-cloud-sync"
              : authorization.status === "pending"
                ? "wait-for-authorization-activation"
                : authorization.status === "expired"
                  ? "check-host-connectivity"
                  : "none";
  return {
    v: 1,
    mode: "managed",
    configured: true,
    sync: { state: syncState, lastSuccessfulAt: status.lastAuthorizationAt ?? null },
    authorization: {
      status: authorization.status,
      revision: authorization.revision ?? null,
      expiresAt: authorization.expiresAt ?? null,
      expired: authorization.status === "expired",
    },
    action,
  };
}

export interface CreateServerResult {
  app: FastifyInstance;
  authGate: AuthGate;
  /** Issue a five-minute, one-use pairing capability without exposing the host's master token. */
  issuePairing(): PairingTicket;
  /** Internal E2E-relay bridge. It authenticates relay-scoped devices through the exact normal route hooks. */
  dispatchRelayRequest(token: string, request: RelayRpcRequest): Promise<RelayRpcResponse>;
  /** Issues a relay-principal terminal ticket without exposing the bridge's process-local capability. */
  issueRelayTerminalTicket(token: string): Promise<string>;
  /** Process-local loopback headers for streamed relay HTTP. Never expose these outside this server process. */
  relayLoopbackHeaders(token: string, headers?: Record<string, string>): Record<string, string>;
  /** Exposed so startServer can late-bind the MCP attach config (after listen() resolves the port) —
   *  this is what gives the terminal's claude send_image/send_file. */
  terminalManager: TerminalManager;
  /** Exposed for relay/team composition and isolated ownership tests. */
  inputLeases: InputLeaseCoordinator;
  teamStore: TeamStore;
  policyStore: PolicyStore;
  peerStore: PeerStore;
  presence: PresenceCoordinator;
  /** False when tmux/node-pty is unavailable → terminal sessions are disabled (startServer warns loudly). */
  terminalAvailable: boolean;
  /** Privacy-bounded webhook routing records synchronized to an optional managed control plane. */
  automationWebhookRegistrations(): CloudAutomationWebhookRegistration[];
  /** Durably accepts one control-plane signal; the invocation id makes redelivery idempotent. */
  acceptCloudAutomationInvocation(invocation: CloudAutomationInvocation): Promise<void>;
}

interface CreateSessionBody {
  provider?: unknown;
  cwd: string;
  options?: unknown;
  model?: string;
  effort?: string;
  addDirs?: string[];
  dangerouslySkip?: boolean;
  /** Starting permission mode (default | acceptEdits | plan). bypassPermissions is expressed via
   *  dangerouslySkip; the terminal spawn emits `--permission-mode` for the non-default modes. */
  permissionMode?: string;
  /** Session mode: terminal is the only mode (a pty-backed tmux terminal session). */
  mode?: "terminal";
}

interface CreateNodeSessionBody {
  agentRuntimeId?: unknown;
  cwd?: unknown;
  runtimeOptions?: unknown;
}

interface V2SessionProjection {
  nodeId: string;
  agentRuntimeId: string;
}

interface LaunchedSessionResult {
  meta: ReturnType<TerminalManager["create"]>;
  response: Record<string, unknown>;
  reused: boolean;
}

/**
 * SSRF guard for a Web-Push endpoint the server will later POST to: reject loopback / private / link-local
 * hosts (incl. the cloud metadata address 169.254.169.254) so an authed client can't point delivery at an
 * internal service. Real push services (FCM / Apple / Mozilla) are public HTTPS hosts, so this never blocks a
 * legitimate subscription.
 */
function isDisallowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return (
    a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) // prettier-ignore
  );
}

export function createServer(config: ServerRuntimeConfig, deps: CreateServerDeps = {}): CreateServerResult {
  // Runtime compatibility for older embedders/tests that constructed ServerRuntimeConfig before dataDir
  // became required. Keep every derived path inside the already-authorized fsRoot; production config always
  // supplies the canonical data directory through loadServerConfig.
  const dataDir = config.dataDir ?? config.fsRoot;
  // Cached best-effort `claude --version`. Used by the authed GET /diag and by GET /claude/version (the
  // update-awareness signal). Injected in tests; a real probe over the configured claude bin + process env.
  const claudeVersionProbe =
    deps.claudeVersionProbe ??
    createClaudeVersionProbe({ run: defaultRunClaudeVersion(config.claude.claudeBin, process.env) });
  const terminalAvailable = deps.terminalAvailable ?? detectTerminalSupport();
  const providers =
    deps.providers ??
    new ProviderRegistry([
      createClaudeProvider({ claudeBin: config.claude.claudeBin }),
      createCodexProvider({ codexBin: config.codexBin ?? "codex" }),
    ]);
  const resumeIdentityFor = (provider: ProviderId): "optional" | "required" | "unsupported" => {
    try {
      return providers.manifest(provider).resumeIdentity;
    } catch {
      // A preserved session whose adapter failed integrity checks must remain listable and removable. It is not
      // resumable until that exact adapter is restored, so the conservative public capability is unsupported.
      return "unsupported";
    }
  };
  const store = deps.store ?? openSessionStore({ dbPath: ":memory:" });
  const deviceStore = deps.deviceStore ?? openDeviceStore({ dbPath: ":memory:" });
  const commandStore = deps.commandStore ?? openCommandCenterStore({ dbPath: ":memory:" });
  const controlStore = deps.controlStore ?? openControlStore({ dbPath: ":memory:" });
  const sessionAutomationStore = deps.sessionAutomationStore ?? openSessionAutomationStore({ dbPath: ":memory:" });
  const teamStore = deps.teamStore ?? openTeamStore({ dbPath: ":memory:" });
  const authorizer = deps.authorizer ?? createCompositeAuthorizer({ teamStore });
  const policyStore = deps.policyStore ?? openPolicyStore({ dbPath: ":memory:" });
  const peerStore = deps.peerStore ?? openPeerStore({ dbPath: ":memory:" });
  const presence = deps.presence ?? new PresenceCoordinator();
  const inputLeases =
    deps.inputLeases ??
    new InputLeaseCoordinator({
      onEvent: (event: InputLeaseEvent) => {
        if (event.type === "renewed") return;
        const previousOperator = event.type === "taken-over" ? event.previous : event.lease;
        if (["released", "expired", "revoked", "taken-over"].includes(event.type)) {
          presence.downgradeOperating(previousOperator, previousOperator.sessionId);
        }
        const actorType: AuditActorType = event.lease.actorType === "relay" ? "device" : event.lease.actorType;
        try {
          controlStore.appendAudit({
            actorType,
            actorId: event.lease.actorId,
            action: `session.input_lease.${event.type.replaceAll("-", "_")}`,
            targetType: "session",
            targetId: event.lease.sessionId,
            result: "success",
            metadata: {
              revision: event.lease.revision,
              ...(event.type === "taken-over"
                ? { previousActorType: event.previous.actorType, previousActorId: event.previous.actorId }
                : {}),
            },
            createdAt: Date.now(),
          });
        } catch {
          /* lease state stays authoritative if durable audit is temporarily unavailable */
        }
        try {
          commandStore.appendEvent(
            `session.input_lease.${event.type.replaceAll("-", "_")}`,
            "session",
            event.lease.sessionId,
            { actorType: event.lease.actorType, actorId: event.lease.actorId, revision: event.lease.revision },
          );
        } catch {
          /* event fan-out cannot break ownership */
        }
      },
    });
  const worktreeService = deps.worktreeService ?? createWorktreeService({ fsRoot: config.fsRoot });
  const extensionManager =
    deps.extensionManager ??
    openExtensionManager({
      dbPath: ":memory:",
      packagesDir: join(dataDir, "extensions"),
      fsRoot: config.fsRoot,
    });
  const pluginRuntime =
    deps.pluginRuntime ??
    createPluginRuntime({
      extensions: extensionManager,
      fsRoot: config.fsRoot,
      audit: (event) => {
        try {
          controlStore.appendAudit({
            actorType: "plugin",
            actorId: event.pluginId,
            action: event.phase === "started" ? "plugin.run.started" : "plugin.run.finished",
            targetType: "plugin-action",
            targetId: event.actionId,
            result: event.result === "failed" ? "error" : "success",
            metadata: {
              pluginVersion: event.pluginVersion,
              phase: event.phase,
              ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
              ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
            },
            createdAt: Date.now(),
          });
        } catch {
          /* plugin execution remains bounded even when durable audit is temporarily unavailable */
        }
      },
    });
  const executeAutomation = (
    automation: AutomationDefinition,
    event?: CommandEvent,
    now = Date.now(),
  ): AutomationRun => {
    let status: AutomationRun["status"] = "succeeded";
    let detail: string | undefined;
    let targetType = "event";
    let targetId = event?.resourceId;
    try {
      if (!automation.enabled) {
        status = "skipped";
        detail = "automation is disabled";
      } else if (automation.action.type === "emit_event") {
        targetType = automation.action.resourceType;
        targetId = automation.action.resourceId;
        if (!automation.permissions.includes("events:write")) {
          status = "skipped";
          detail = "events:write permission is required";
        } else {
          commandStore.appendEvent(
            automation.action.eventType,
            automation.action.resourceType,
            automation.action.resourceId,
            { originAutomationId: automation.id },
            now,
          );
        }
      } else {
        targetType = "attention";
        targetId = automation.action.target === "event-resource" ? event?.resourceId : automation.action.target;
        if (!automation.permissions.includes("attention:write")) {
          status = "skipped";
          detail = "attention:write permission is required";
        } else if (
          !targetId ||
          (automation.action.target === "event-resource" && event?.resourceType !== "attention")
        ) {
          status = "skipped";
          detail = "attention target is unavailable";
        } else {
          const item =
            automation.action.type === "acknowledge_attention"
              ? commandStore.acknowledgeAttention(targetId, now)
              : automation.action.type === "resolve_attention"
                ? commandStore.resolveAttention(targetId, now)
                : commandStore.snoozeAttention(targetId, now + automation.action.durationMs, now);
          if (!item) {
            status = "failed";
            detail = "attention target was not found";
          }
        }
      }
    } catch {
      status = "failed";
      detail = "automation action failed";
    }
    const run = controlStore.recordAutomationRun({
      automationId: automation.id,
      ...(event ? { eventId: event.id } : {}),
      status,
      ...(detail ? { detail } : {}),
      createdAt: now,
    });
    try {
      controlStore.appendAudit({
        actorType: "automation",
        actorId: automation.id,
        action: automation.action.type,
        targetType,
        ...(targetId ? { targetId } : {}),
        result: status === "succeeded" ? "success" : "error",
        metadata: { status, ...(event ? { eventId: event.id } : {}) },
        createdAt: now,
      });
    } catch {
      /* an audit backend failure is isolated from the already-recorded bounded run */
    }
    return run;
  };
  let unsubscribeAutomations = () => {};
  let unsubscribePlugins = () => {};
  const unsetSessionDefaults = { defaults: null, revision: 0 } as const;
  const sessionDefaultsEnvelope = (stored: ReturnType<SessionStore["getSessionDefaults"]>) =>
    stored
      ? {
          defaults: normalizeSessionDefaults(stored.defaults),
          revision: stored.revision,
          updatedAt: stored.updatedAt,
        }
      : unsetSessionDefaults;
  const syncCommandAgent = (id: string, activity: AgentActivity) => {
    const live = terminalManager?.get(id);
    const stored = store.get(id);
    if (!live && !stored) return undefined;
    const cwd = live?.cwd ?? stored!.cwd;
    const provider = live?.provider ?? stored!.provider;
    const createdAt = live?.createdAt ?? stored!.createdAt;
    const placement = commandStore.ensureSession(id, cwd);
    const agent = commandStore.upsertAgent({
      sessionId: id,
      workspaceId: placement.workspaceId,
      provider,
      activity,
      createdAt,
    });
    return { placement, agent, live, stored };
  };
  const recordAttentionForSession = (
    id: string,
    kind: AttentionKind,
    title: string,
    dedupeKey: string,
    detail?: string,
  ) => {
    const liveActivity = terminalManager?.get(id)?.activity;
    const synced = syncCommandAgent(
      id,
      kind === "blocked" ? "blocked" : kind === "done" ? "done" : (liveActivity ?? "unknown"),
    );
    if (!synced) return;
    commandStore.recordAttention({
      workspaceId: synced.placement.workspaceId,
      sessionId: id,
      agentId: synced.placement.agentId,
      kind,
      title,
      ...(detail ? { detail } : {}),
      dedupeKey,
    });
  };
  const terminalManager =
    deps.terminalManager ??
    new TerminalManager({
      store,
      providers,
      ...(deps.codexThreadResolver ? { codexThreadResolver: deps.codexThreadResolver } : {}),
      now: () => Date.now(),
      // Away-from-desk pushes: a session going quiet with nobody watching → "claude is waiting" (the manager
      // only fires this when the last client walks away while awaiting); claude exiting with NOBODY watching →
      // "session ended" (an attached client already sees the WS close, so skip the redundant push). Both go
      // through dispatchPush so they carry the awaiting-session count as the badge. Fire-and-forget.
      onAwaiting: (id) => dispatchPush({ kind: "awaiting", sessionId: id }),
      onActivityChanged: (id, previous, current, attached) => {
        const meta = terminalManager.get(id);
        const label = meta?.name?.trim() || (meta ? pathBasename(meta.cwd) : "Agent");
        if (current === "blocked") {
          recordAttentionForSession(
            id,
            "blocked",
            `${label} needs a decision`,
            `blocked:${id}`,
            "Open the native terminal to review the provider prompt.",
          );
          return;
        }
        commandStore.resolveAttentionByDedupeKey(`blocked:${id}`);
        if (current === "idle" && previous === "working" && !attached) {
          recordAttentionForSession(id, "done", `${label} finished a turn`, `done:${id}`);
          return;
        }
        syncCommandAgent(id, current);
        if (current === "working") commandStore.resolveAttentionByDedupeKey(`done:${id}`);
        if (attached) commandStore.markSessionViewed(id);
      },
      onViewed: (id) => {
        commandStore.markSessionViewed(id);
        const meta = terminalManager.get(id);
        if (meta) syncCommandAgent(id, meta.status === "ended" ? "ended" : meta.activity);
      },
      onFinished: (id, wasAttached) => {
        const meta = terminalManager.get(id);
        const label = meta?.name?.trim() || (meta ? pathBasename(meta.cwd) : "Agent");
        syncCommandAgent(id, "ended");
        commandStore.resolveAttentionByDedupeKey(`blocked:${id}`);
        const alreadyOpen = commandStore
          .listAttention({ includeSnoozed: true })
          .some((item) => item.sessionId === id && item.kind === "done");
        if (!wasAttached && !alreadyOpen) recordAttentionForSession(id, "done", `${label} ended`, `done:${id}`);
        if (!wasAttached) dispatchPush({ kind: "finished", sessionId: id });
      },
    });
  /**
   * Fire an away-from-desk push, always stamping the CURRENT awaiting-session count as `badgeCount` so the
   * service worker can set the home-screen app badge to "how many sessions need you". Fire-and-forget — the
   * dispatcher never throws / never blocks, and it's a no-op when push isn't configured.
   */
  const dispatchPush = (event: PushEvent): void => {
    const meta = event.sessionId ? terminalManager.get(event.sessionId) : undefined;
    const label = meta ? meta.name?.trim() || pathBasename(meta.cwd) : undefined;
    void deps.pushDispatcher?.dispatch({
      ...event,
      ...(meta ? { provider: meta.provider, label } : {}),
      badgeCount: terminalManager.awaitingCount(),
    });
  };
  if (terminalAvailable) {
    // Only rehydrate (which prunes store rows for dead sessions) when we have a DEFINITIVE live-session
    // list. `undefined` = the tmux probe failed transiently → skip, so a flaky probe never wipes the
    // user's resumable terminal sessions.
    // Retry a transiently-failed probe a couple of times before giving up: skipping rehydrate leaves the
    // user's previously-running sessions unadopted (invisible + leaked) until a later restart.
    let liveTmuxNames = listTmuxSessions();
    for (let i = 0; liveTmuxNames === undefined && i < 2; i += 1) liveTmuxNames = listTmuxSessions();
    if (liveTmuxNames) terminalManager.rehydrate({ liveTmuxNames });
  }
  // Backfill the command-center hierarchy for pre-existing sessions on first boot. Exact cwd grouping keeps
  // the migration deterministic and requires no user reorganization.
  for (const meta of terminalManager.list())
    syncCommandAgent(meta.id, meta.status === "ended" ? "ended" : meta.activity);

  // Automation events are drained in a bounded queue. Actions can emit more command events, so one causal
  // chain is capped instead of allowing a misconfigured pair of rules to recurse forever on the host.
  const automationEventQueue: CommandEvent[] = [];
  let drainingAutomations = false;
  const drainAutomations = () => {
    let processed = 0;
    while (automationEventQueue.length > 0 && processed < 100) {
      const event = automationEventQueue.shift()!;
      processed += 1;
      for (const automation of controlStore.listAutomations()) {
        if (
          !automation.enabled ||
          automation.trigger.eventType !== event.type ||
          (automation.trigger.resourceType !== undefined && automation.trigger.resourceType !== event.resourceType) ||
          event.payload.originAutomationId === automation.id
        ) {
          continue;
        }
        executeAutomation(automation, event);
      }
    }
    if (automationEventQueue.length > 0) {
      const dropped = automationEventQueue.splice(0).length;
      try {
        controlStore.appendAudit({
          actorType: "system",
          actorId: commandStore.getHost().id,
          action: "automation.chain_limited",
          targetType: "automation",
          result: "denied",
          metadata: { droppedEvents: dropped },
          createdAt: Date.now(),
        });
      } catch {
        /* keep the event loop healthy even when durable audit is unavailable */
      }
    }
    drainingAutomations = false;
  };
  unsubscribeAutomations = commandStore.subscribeEvents((event) => {
    automationEventQueue.push(event);
    if (drainingAutomations) return;
    drainingAutomations = true;
    queueMicrotask(drainAutomations);
  });

  // Plugin hooks observe the same ordered command events, but run outside the append call in a bounded,
  // sequential queue. Plugin-generated lifecycle events are never fed back into plugins, which prevents
  // causal loops even when multiple extensions subscribe to broad product events.
  const pluginEventQueue: CommandEvent[] = [];
  let droppedPluginEvents = 0;
  let drainingPlugins = false;
  const workspacePathForEvent = (event: CommandEvent): string | undefined => {
    if (event.resourceType === "workspace") return commandStore.getWorkspace(event.resourceId)?.cwd;
    if (event.resourceType === "session") {
      const placement = commandStore.placementForSession(event.resourceId);
      return placement ? commandStore.getWorkspace(placement.workspaceId)?.cwd : undefined;
    }
    if (event.resourceType === "agent") {
      const agent = commandStore.getAgent(event.resourceId);
      return agent ? commandStore.getWorkspace(agent.workspaceId)?.cwd : undefined;
    }
    if (event.resourceType === "attention") {
      const attention = commandStore
        .listAttention({ includeResolved: true, includeSnoozed: true })
        .find((item) => item.id === event.resourceId);
      return attention ? commandStore.getWorkspace(attention.workspaceId)?.cwd : undefined;
    }
    return undefined;
  };
  const drainPlugins = async () => {
    let processed = 0;
    while (pluginEventQueue.length > 0 && processed < 100) {
      const event = pluginEventQueue.shift()!;
      processed += 1;
      let hooks: ReturnType<PluginRuntime["hooksFor"]> = [];
      try {
        hooks = pluginRuntime.hooksFor(event.type);
      } catch {
        hooks = [];
      }
      for (const hook of hooks) {
        try {
          const result = await pluginRuntime.run({
            pluginId: hook.pluginId,
            actionId: hook.actionId,
            ...(workspacePathForEvent(event) ? { workspacePath: workspacePathForEvent(event) } : {}),
            context: {
              eventId: event.id,
              eventType: event.type,
              resourceType: event.resourceType,
              resourceId: event.resourceId,
              createdAt: event.createdAt,
            },
          });
          commandStore.appendEvent("plugin.run_finished", "plugin", hook.pluginId, {
            actionId: hook.actionId,
            status: result.status,
            exitCode: result.exitCode,
            originEventId: event.id,
          });
        } catch (error) {
          commandStore.appendEvent("plugin.run_failed", "plugin", hook.pluginId, {
            actionId: hook.actionId,
            code: error instanceof PluginRuntimeError ? error.code : "PLUGIN_FAILED",
            originEventId: event.id,
          });
        }
      }
    }
    if (pluginEventQueue.length > 0 || droppedPluginEvents > 0) {
      const dropped = pluginEventQueue.splice(0).length + droppedPluginEvents;
      droppedPluginEvents = 0;
      try {
        controlStore.appendAudit({
          actorType: "system",
          actorId: commandStore.getHost().id,
          action: "plugin.event_queue_limited",
          targetType: "plugin",
          result: "denied",
          metadata: { droppedEvents: dropped },
          createdAt: Date.now(),
        });
      } catch {
        /* keep product event delivery healthy when audit storage is unavailable */
      }
    }
    drainingPlugins = false;
  };
  unsubscribePlugins = commandStore.subscribeEvents((event) => {
    if (event.type.startsWith("plugin.")) return;
    if (pluginEventQueue.length >= 256) {
      droppedPluginEvents += 1;
      return;
    }
    pluginEventQueue.push(event);
    if (drainingPlugins) return;
    drainingPlugins = true;
    queueMicrotask(() => void drainPlugins());
  });
  // One-time migration from the former user-edited "defaults" document: if it has no remembered provider,
  // prefer the newest durable session's real launch options. This makes the first wizard after upgrading match
  // the user's last launch instead of carrying an unrelated Settings choice forward.
  const canRememberSessionOptions =
    typeof store.getSessionDefaults === "function" && typeof store.rememberSessionDefaults === "function";
  const legacyDefaults = canRememberSessionOptions ? store.getSessionDefaults() : undefined;
  if (canRememberSessionOptions && legacyDefaults?.defaults.provider === undefined) {
    const latestSession = store.list().at(-1);
    if (latestSession) {
      try {
        const latestOptions =
          latestSession.externalAdapter !== true && latestSession.provider === "claude"
            ? parseLegacyClaudeArgs(latestSession.spawnArgs ?? [])
            : latestSession.launchOptions;
        store.rememberSessionDefaults(sessionDefaultsForLaunch(legacyDefaults?.defaults, latestOptions), Date.now());
      } catch {
        // Migration is best-effort. An ancient or hand-edited launch record must never prevent the server
        // from starting; the first successful launch below will replace it with a validated document.
      }
    }
  }
  const authGate =
    deps.authGate ??
    new AuthGate({
      token: config.accessToken,
      verifyCredential: (presented) => deviceStore.authenticate(presented) !== undefined,
    });
  // Global per-client rate limiter (token bucket). A real one is built from the configured rpm/burst; a
  // rpm of 0 DISABLES it (enabled:false). Injected in tests for a deterministic clock + a tiny limit.
  const rateLimiter =
    deps.rateLimiter ??
    new RateLimiter({
      capacity: config.rateLimitRpm,
      windowMs: 60_000,
      burst: config.rateLimitBurst,
      enabled: config.rateLimitRpm > 0,
    });
  // Pair claims are public by design (the one-time 256-bit capability is the credential), but still get
  // a small independent per-IP bucket so malformed traffic cannot create unbounded parsing/DB work.
  const pairingRateLimiter = new RateLimiter({ capacity: 30, windowMs: 60_000, burst: 10 });
  const automationWebhookRateLimiter = new RateLimiter({ capacity: 120, windowMs: 60_000, burst: 30 });
  const fsService = new FsService({ root: config.fsRoot });
  // Terminal uploads live under the app data dir (outside any project repo — see terminal-shared.ts), one
  // folder per session. Bound their lifetime: prune files past the TTL across EVERY session folder under the
  // shared base — once at boot (catches files that aged out while the server was down, and orphaned folders
  // whose session is gone) and on a periodic timer. (Also pruned on each upload.) unref() so the timer never
  // keeps the process alive.
  const terminalSharedRoot = terminalSharedBase({ dataDir, fsRoot: config.fsRoot });
  const backfilledFileSessions = new Set<string>();
  const fileBackfillsInFlight = new Map<string, Promise<void>>();
  const backfillManagedFiles = (sessionId: string): Promise<void> => {
    if (backfilledFileSessions.has(sessionId)) return Promise.resolve();
    const existing = fileBackfillsInFlight.get(sessionId);
    if (existing) return existing;
    const task = (async () => {
      const sessionDir = terminalSharedDir({ dataDir, fsRoot: config.fsRoot, sessionId });
      const discovered = await fsService.discoverManagedFiles(sessionDir);
      const knownPaths = new Set(store.listFiles(sessionId, true).map((file) => file.path));
      for (const file of discovered) {
        if (knownPaths.has(file.path)) continue;
        const expiresAt = file.mtimeMs + TERMINAL_FILE_TTL_MS;
        if (expiresAt <= Date.now()) continue;
        const now = Date.now();
        const media = attachmentMedia(file.filename);
        store.putFile({
          id: randomUUID(),
          sessionId,
          direction: "sent",
          storage: "managed",
          name: file.filename,
          path: file.path,
          mimeType: media.mimeType,
          size: file.size,
          kind: media.kind,
          createdAt: file.mtimeMs,
          updatedAt: now,
          expiresAt,
        });
        knownPaths.add(file.path);
      }
      backfilledFileSessions.add(sessionId);
    })();
    fileBackfillsInFlight.set(sessionId, task);
    // Keep a rejection handled even when the HTTP request has already returned after its time budget. A
    // failed scan remains retryable on the next inventory request instead of poisoning the session forever.
    void task.catch(() => undefined).finally(() => fileBackfillsInFlight.delete(sessionId));
    return task;
  };

  const fileAvailableWithinBudget = async (file: StoredSessionFile): Promise<boolean> => {
    if (file.expiresAt <= Date.now()) return false;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (available: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(available);
      };
      // A timeout means "not proven missing". Content routes still perform the authoritative confined
      // filesystem check when the user actually opens/downloads the file.
      const timer = setTimeout(() => finish(true), FILE_HISTORY_AVAILABILITY_BUDGET_MS);
      void fsService.describeFile(file.path).then(
        () => finish(true),
        () => finish(false),
      );
    });
  };
  const sweepSharedFiles = (): void => {
    void (async () => {
      // A few embedding/test callers supply a legacy SessionStore-shaped adapter. File history is additive,
      // so an adapter without the new lifecycle method must still be able to start the server.
      const expired = typeof store.pruneFiles === "function" ? store.pruneFiles(Date.now()) : [];
      await Promise.all(
        expired
          .filter((file) => file.storage === "managed")
          .map((file) => fsService.removeManagedPath(file.path).catch(() => undefined)),
      );
      await fsService.pruneChildDirsOlderThan(terminalSharedRoot, TERMINAL_FILE_TTL_MS).catch(() => 0);
    })();
  };
  sweepSharedFiles();
  const sharedSweepTimer = setInterval(sweepSharedFiles, TERMINAL_SWEEP_INTERVAL_MS);
  if (typeof sharedSweepTimer.unref === "function") sharedSweepTimer.unref();
  // OPT-IN idle-session reaper (SESSION_IDLE_TTL_MS; 0 = off, the default so detached sessions survive for
  // later reattach). When enabled, periodically kill running terminals with no attached client idle past the
  // TTL, bounding detached claude+tmux accumulation. unref() so it never keeps the process alive.
  const idleTtlMs = config.sessionIdleTtlMs ?? 0;
  if (idleTtlMs > 0) {
    const reapEvery = Math.max(30_000, Math.min(idleTtlMs, 5 * 60_000));
    const idleTimer = setInterval(() => {
      const n = terminalManager.reapIdle(idleTtlMs);
      if (n > 0) console.log(`reaped ${n} idle terminal session(s) (SESSION_IDLE_TTL_MS=${idleTtlMs})`);
    }, reapEvery);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  }
  // CONCURRENCY CAP: refuse a new spawn once `config.maxSessions` live terminal sessions exist (0 disables
  // it). Only running sessions count, so dormant/errored records don't and reopening within the cap is
  // unaffected. The message names the env var so an operator can lift it.
  const sessionCapMessage = `live session cap reached (${config.maxSessions}); close a session or raise ROAMCODE_MAX_SESSIONS`;
  // OTA self-update. The real updater keeps its release cache/status in the data dir and activates an
  // exact npm version; tests inject a fixture release feed with no network or service mutation.
  const updater = deps.updater ?? createUpdater({ dataDir });
  const storeMode: StoreMode = deps.storeMode ?? "sqlite";
  // Single-use WS tickets (POST /ws-ticket) — the preferred terminal-WS credential; see ws-ticket.ts.
  const wsTickets = deps.wsTickets ?? new WsTicketStore();

  // trustProxy makes request.ip honour X-Forwarded-For behind a reverse proxy, so the
  // per-client auth lockout keys on the real client IP (see Task 4's proxy caveat).
  const app = Fastify({ logger: false, trustProxy: config.trustProxy ?? false });
  if (deps.healthInstanceId) {
    app.addHook("onSend", (_request, reply, payload, done) => {
      reply.header("x-roamcode-instance", deps.healthInstanceId);
      done(null, payload);
    });
  }
  const relayInternalCapability = randomBytes(32).toString("base64url");
  const authenticatedPrincipals = new WeakMap<FastifyRequest, InputLeasePrincipal>();
  const automationWebhookRequests = new WeakMap<
    FastifyRequest,
    { automation: SessionAutomationDefinition; trigger: SessionAutomationConfiguredTrigger }
  >();
  const hostPrincipal = (): InputLeasePrincipal => ({
    actorType: config.accessToken ? "host" : "local",
    actorId: commandStore.getHost().id,
    label: config.accessToken ? "Host administrator" : "Local client",
  });
  const principalForToken = (token: string | undefined): InputLeasePrincipal => {
    const device = token ? deviceStore.authenticate(token) : undefined;
    if (device) return { actorType: "device", actorId: device.id, label: device.name };
    return hostPrincipal();
  };
  const currentDeviceIdForRequest = (request: FastifyRequest): string | undefined => {
    const principal = authenticatedPrincipals.get(request);
    return principal?.actorType === "device" || principal?.actorType === "relay" ? principal.actorId : undefined;
  };
  const teamResourceForSession = (sessionId: string) => ({
    hostId: commandStore.getHost().id,
    ...(commandStore.placementForSession(sessionId)?.workspaceId
      ? { workspaceId: commandStore.placementForSession(sessionId)!.workspaceId }
      : {}),
  });
  const teamAllows = (principal: InputLeasePrincipal, permission: TeamPermission, sessionId?: string): boolean =>
    authorizer.authorize(
      principal.actorType,
      principal.actorId,
      permission,
      sessionId ? teamResourceForSession(sessionId) : { hostId: commandStore.getHost().id },
    ).allowed;
  const canReadSession = (principal: InputLeasePrincipal, sessionId: string): boolean => {
    if (!teamAllows(principal, "sessions:read", sessionId)) return false;
    if (principal.actorType !== "host" && principal.actorType !== "local") {
      const resource = teamResourceForSession(sessionId);
      const access = evaluateEnterprisePolicy(policyStore.get(), "access", resource);
      if (!access.allowed) return false;
      if (
        principal.actorType === "relay" &&
        !evaluateEnterprisePolicy(policyStore.get(), "relay.access", resource).allowed
      ) {
        return false;
      }
    }
    return true;
  };
  const canWriteSession = (principal: InputLeasePrincipal, sessionId: string): boolean => {
    if (!teamAllows(principal, "sessions:operate", sessionId)) return false;
    if (principal.actorType !== "host" && principal.actorType !== "local") {
      const resource = teamResourceForSession(sessionId);
      const access = evaluateEnterprisePolicy(policyStore.get(), "access", resource);
      if (!access.allowed) return false;
      if (
        principal.actorType === "relay" &&
        !evaluateEnterprisePolicy(policyStore.get(), "relay.access", resource).allowed
      ) {
        return false;
      }
    }
    try {
      return deps.authorizeInputWrite?.(principal, sessionId) ?? true;
    } catch {
      return false;
    }
  };
  const canTakeOverSession = (principal: InputLeasePrincipal, sessionId: string): boolean => {
    if (!canWriteSession(principal, sessionId)) return false;
    try {
      return deps.authorizeInputTakeover?.(principal, sessionId) ?? true;
    } catch {
      return false;
    }
  };
  // Direct-device and relay tickets can represent the same durable browser actor. Keep both transports in one
  // revocation registry so removing a principal/grant cuts off terminal output immediately, not only future input.
  const remotePrincipalSockets = new Map<string, Set<WebSocket>>();
  const closeRemotePrincipalSockets = (actorId: string, reason = "remote access revoked"): void => {
    const sockets = remotePrincipalSockets.get(actorId);
    if (!sockets) return;
    remotePrincipalSockets.delete(actorId);
    for (const socket of sockets) {
      try {
        socket.close(4403, reason);
      } catch {
        /* already closed */
      }
    }
  };
  const terminalAuthorizationRecheckMs = deps.terminalAuthorizationRecheckMs ?? TERMINAL_AUTHORIZATION_RECHECK_MS;
  if (!Number.isSafeInteger(terminalAuthorizationRecheckMs) || terminalAuthorizationRecheckMs < 10) {
    throw new Error("invalid terminal authorization recheck interval");
  }
  const notifyDeviceRevoked = (deviceId: string): void => {
    try {
      deps.onDeviceRevoked?.(deviceId);
    } catch {
      /* durable credential revocation remains authoritative if a transport is already unavailable */
    }
  };

  // Multipart uploads, capped at the configured size.
  app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });

  const explicitCorsOrigin = (raw: string | undefined): string | undefined => {
    const origin = normalizeOrigin(raw);
    if (!origin) return undefined;
    return config.allowedOrigins.some((allowed) => normalizeOrigin(allowed) === origin) ? origin : undefined;
  };
  const appendVaryOrigin = (current: string | string[] | number | undefined): string => {
    const parts = String(current ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (!parts.some((part) => part.toLowerCase() === "origin")) parts.push("Origin");
    return parts.join(", ");
  };

  // Direct multi-host browsers require a real CORS preflight. Only explicitly configured origins are
  // reflected; credentials are never paired with `*`, and unknown methods/headers fail closed.
  app.options("*", async (request, reply) => {
    const origin = explicitCorsOrigin(request.headers.origin);
    const requestedMethod = request.headers["access-control-request-method"]?.toUpperCase();
    const requestedHeaders = String(request.headers["access-control-request-headers"] ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    const allowedMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
    const allowedHeaders = new Set(["authorization", "content-type", "idempotency-key", "last-event-id"]);
    if (
      !origin ||
      !requestedMethod ||
      !allowedMethods.has(requestedMethod) ||
      requestedHeaders.some((header) => !allowedHeaders.has(header))
    ) {
      return reply.code(403).send({
        code: "CORS_PREFLIGHT_DENIED",
        error: "cross-origin request is not allowed",
      });
    }
    return reply
      .header("access-control-allow-origin", origin)
      .header("access-control-allow-credentials", "true")
      .header("access-control-allow-methods", [...allowedMethods].join(", "))
      .header("access-control-allow-headers", [...allowedHeaders].join(", "))
      .header("access-control-max-age", "600")
      .header("vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
      .code(204)
      .send();
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.method === "OPTIONS") {
      done(null, payload);
      return;
    }
    const origin = explicitCorsOrigin(request.headers.origin);
    if (origin) {
      reply
        .header("access-control-allow-origin", origin)
        .header("access-control-allow-credentials", "true")
        .header("access-control-expose-headers", "retry-after, idempotency-replayed")
        .header("vary", appendVaryOrigin(reply.getHeader("vary")));
    }
    done(null, payload);
  });

  // Global token gate — applies to BOTH REST routes AND the WebSocket upgrade request
  // (a Fastify global preHandler runs for the WS route's GET upgrade and a 401 there
  // aborts the upgrade — verified). The token for a WS upgrade may arrive in the
  // Authorization header, a single-use `?ticket=`, or the (deprecated) `?token=` query param.
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // The wildcard OPTIONS route above performs the complete, fail-closed preflight validation. It must
    // remain credential-free because browsers cannot attach the bearer token until preflight succeeds.
    if (request.method === "OPTIONS") return;
    // DEFAULT-DENY: every route is token-gated unless EXPLICITLY allowlisted here. Only three things are
    // public: (1) the static PWA shell/assets (the login screen must render before a token exists), and
    // (2) /health and (3) the one-use /pairing/claim exchange (below). CRITICAL: gate on the DECODED path
    // (and reject encoded separators) so this
    // matches the path Fastify's router actually routes — otherwise `GET /%73essions` (=/sessions) would
    // look public here yet reach the protected handler, bypassing the token check.
    const path = pathForGate(request.url);
    const relayHeader = request.headers["x-roamcode-internal-relay"];
    if (relayHeader !== undefined) {
      const presentedCapability = Array.isArray(relayHeader) ? undefined : relayHeader;
      const expected = Buffer.from(relayInternalCapability);
      const presented = Buffer.from(presentedCapability ?? "");
      const capabilityMatches = expected.length === presented.length && timingSafeEqual(expected, presented);
      const token = extractBearerToken(request.headers.authorization);
      const device = capabilityMatches && token ? deviceStore.authenticate(token, Date.now(), "relay") : undefined;
      if (!device) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
      authenticatedPrincipals.set(request, {
        actorType: "relay",
        actorId: device.id,
        label: device.name,
      });
      return;
    }
    const isGetLike = request.method === "GET" || request.method === "HEAD";
    if (isGetLike && !hasEncodedSep(request.url)) {
      // (1a) The explicit shell allowlist: `/`, `/assets/*`, and top-level bundle files. Only static
      //      handlers exist at these shapes (every API route is extensionless + prefixed), so a token
      //      can never be required to boot the login screen.
      if (isShellPath(path)) return;
      // (1b) SPA navigation fallback (`/login`, any client route on a hard refresh): allowed WITHOUT a
      //      token ONLY when the request matched NO registered route (fastify's is404) — then the sole
      //      reachable handler is the notFound handler (the SPA shell or a JSON 404), never an API
      //      handler. A REGISTERED route can never take this branch, so a NEW route someone forgets to
      //      think about is token-gated by default instead of silently public (the old denylist's trap).
      if (request.is404 && isPublicPath(path)) return;
    }
    // /health is an unauthenticated liveness probe (a service watchdog or uptime check can't present a
    // token). It returns only { ok: true } — no sensitive data — so it's safe to leave open.
    if (path === "/health") return;
    // Webhook triggers are signal-only public capabilities. The bearer secret is independent from every
    // RoamCode device/host credential and is compared only against its stored digest.
    const automationHookMatch = /^\/api\/v2\/automation-hooks\/(rcwh_[A-Za-z0-9_-]{24,80})$/.exec(path);
    if (request.method === "POST" && automationHookMatch && !hasEncodedSep(request.url)) {
      const limit = automationWebhookRateLimiter.take(request.ip);
      if (!limit.allowed) {
        reply.header("retry-after", String(limit.retryAfterSeconds)).code(429).send({ error: "rate limited" });
        return;
      }
      const hookId = automationHookMatch[1]!;
      const match = sessionAutomationStore
        .list()
        .flatMap((automation) => automation.triggers.map((trigger) => ({ automation, trigger })))
        .find(
          (entry) =>
            entry.automation.enabled &&
            entry.trigger.type === "webhook" &&
            entry.trigger.enabled &&
            entry.trigger.hookId === hookId,
        );
      const secret = extractBearerToken(request.headers.authorization);
      const presented = secret ? createHash("sha256").update(secret).digest() : Buffer.alloc(0);
      const expected =
        match?.trigger.type === "webhook" ? Buffer.from(match.trigger.secretHash, "hex") : Buffer.alloc(32);
      if (!match || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
      automationWebhookRequests.set(request, match);
      authenticatedPrincipals.set(request, hostPrincipal());
      return;
    }
    // A pairing claim exchanges a short-lived, single-use, 256-bit capability for one independently
    // revocable device credential. It is the ONLY public API mutation. Keep the exception exact, enforce
    // the normal browser Origin policy, and rate-limit malformed guesses before they reach SQLite.
    if (request.method === "POST" && path === "/pairing/claim" && !hasEncodedSep(request.url)) {
      const originAllowed = isOriginAllowed(request.headers.origin, request.headers.host, {
        publicUrl: config.publicUrl,
        allowedOrigins: config.allowedOrigins,
      });
      if (!originAllowed) {
        reply.code(403).send({ error: "forbidden origin" });
        return;
      }
      const pairingLimit = pairingRateLimiter.take(request.ip);
      if (!pairingLimit.allowed) {
        reply.header("retry-after", String(pairingLimit.retryAfterSeconds)).code(429).send({ error: "rate limited" });
        return;
      }
      return;
    }
    // No token configured (loopback dev): allow. Non-loopback w/o token is blocked at startup.
    if (!config.accessToken) {
      authenticatedPrincipals.set(request, hostPrincipal());
      return;
    }
    // `?token=a&token=b` parses to an array — only a single string is a usable token.
    // Anything else (array, missing) becomes undefined so the auth path can't be fed a non-string.
    const q = request.query as { token?: unknown; ticket?: unknown };
    const queryToken = typeof q?.token === "string" ? q.token : undefined;
    const queryTicket = typeof q?.ticket === "string" ? q.ticket : undefined;
    const isWsUpgradePath = path.endsWith("/ws") || path.endsWith("/terminal");
    // Browser-native media elements (<img>, <iframe>) cannot attach an Authorization header. Keep this
    // exception deliberately narrower than `/sessions/*`: only the immutable-by-id content endpoint and
    // only read-like methods may use a query token. Inventory and mutation routes remain header-only.
    const isTerminalFileContent = isGetLike && /^\/sessions\/[^/]+\/files\/[^/]+\/content$/.test(path);
    // PREFERRED WS auth: a single-use short-TTL ticket from POST /ws-ticket. Consuming it here means a
    // WS URL that lands in a proxy/access log carries an already-spent, ~30s credential instead of the
    // long-lived token. Origin + rate-limit checks below still apply to a ticket-authed upgrade.
    const ticketRecord =
      isWsUpgradePath && queryTicket !== undefined ? wsTickets.consumeWithContext(queryTicket) : undefined;
    const ticketOk = ticketRecord !== undefined;
    let authenticatedPrincipal: InputLeasePrincipal | undefined = ticketRecord?.context;
    if (!ticketOk) {
      // Accept the token from `?token=` ONLY on routes a browser genuinely can't send an Authorization
      // header on: the WS upgrade (`/sessions/:id/ws|/terminal` — DEPRECATED, kept so bundles from before
      // the ticket flow keep reconnecting; new clients use ?ticket=), <img> media GETs (`/images/*`), and
      // durable terminal-file media (`/sessions/:id/files/:fileId/content`), and file downloads
      // (`/fs/download`). Every other route uses the header — so the access token isn't
      // written into proxy / access logs (query strings are routinely logged), which would otherwise leak
      // a full-access credential.
      const queryTokenAllowed =
        isWsUpgradePath || path.startsWith("/images/") || path === "/fs/download" || isTerminalFileContent;
      const token = extractBearerToken(request.headers.authorization) ?? (queryTokenAllowed ? queryToken : undefined);
      const result = authGate.check(token, request.ip);
      if (!result.ok) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
      authenticatedPrincipal = principalForToken(token);
    }

    // ORIGIN / CSWSH GUARD (runs AFTER the token gate, for authenticated requests — incl. the WS upgrade).
    // The token can leak into a URL; this stops a malicious cross-origin BROWSER page that holds it from
    // puppeting the host. SAFE DEFAULT: allow absent / same-origin / loopback / public-URL / allow-listed
    // origins (the real PWA is always one of these); reject only a PRESENT, cross-origin, non-allow-listed
    // Origin. The page cannot forge its Origin header, so this can never reject the genuine app.
    const originAllowed = isOriginAllowed(request.headers.origin, request.headers.host, {
      publicUrl: config.publicUrl,
      allowedOrigins: config.allowedOrigins,
    });
    if (!originAllowed) {
      reply.code(403).send({ error: "forbidden origin" });
      return;
    }

    // GLOBAL RATE LIMIT (runs LAST, for authenticated requests). Keyed by the same clientKey as the auth
    // lockout (request.ip, honoring trustProxy). Generous by default (way above the app's poll cadence) and
    // disable-able; a flood gets 429 + Retry-After. /health was already exempted above (it never reaches
    // here), so liveness probes are never throttled. The WS is ONE upgrade then long-lived, so the limit is
    // for HTTP/API volume, not the WS data path.
    // EXEMPTION: cacheable image thumbnails (GET /images/<ref>) skip the VOLUME limiter — they are
    // content-addressed/immutable and still passed the auth + origin checks above (the token is required),
    // so excluding them is safe and avoids 429-ing legit thumbnails when a fast scroll of an image-dense
    // transcript fires many parallel <img> GETs. Auth/origin are NOT bypassed — only the rate-limit step.
    const imageGetExempt = request.method === "GET" && path.startsWith("/images/");
    if (!imageGetExempt) {
      const limit = rateLimiter.take(request.ip);
      if (!limit.allowed) {
        reply.header("retry-after", String(limit.retryAfterSeconds)).code(429).send({ error: "rate limited" });
        return;
      }
    }
    authenticatedPrincipals.set(request, authenticatedPrincipal ?? hostPrincipal());
  });

  type MutationContext = {
    actorType: AuditActorType;
    actorId: string;
    route: string;
    targetType: string;
    targetId?: string;
    idempotency?: { key: string; fingerprint: string; replayed: boolean; reservationKey?: string };
  };
  type IdempotencyOutcome = { statusCode: number; body: string };
  type InFlightIdempotency = {
    fingerprint: string;
    outcome: Promise<IdempotencyOutcome>;
    resolve: (outcome: IdempotencyOutcome) => void;
  };
  const mutationContexts = new WeakMap<FastifyRequest, MutationContext>();
  // Durable replay is written after a handler completes. This process-local reservation closes the smaller
  // same-process race where two identical requests arrive before that write: the follower waits for and replays
  // the leader instead of executing the mutation a second time. One RoamCode process owns a data directory.
  const inFlightIdempotency = new Map<string, InFlightIdempotency>();
  const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const actorForRequest = (request: FastifyRequest): Pick<MutationContext, "actorType" | "actorId"> => {
    const principal = authenticatedPrincipals.get(request);
    if (principal) {
      return {
        actorType: principal.actorType === "relay" ? "device" : principal.actorType,
        actorId: principal.actorId,
      };
    }
    const token = extractBearerToken(request.headers.authorization);
    const device = token ? deviceStore.authenticate(token) : undefined;
    if (device) return { actorType: "device", actorId: device.id };
    if (!config.accessToken) return { actorType: "local", actorId: commandStore.getHost().id };
    // Current and brief rotation-grace host credentials intentionally share one audit identity. No token,
    // digest, IP address, or user-agent enters the audit log.
    return { actorType: "host", actorId: commandStore.getHost().id };
  };

  const permissionForRequest = (path: string, method: string): TeamPermission => {
    const read = method === "GET" || method === "HEAD";
    if (/^\/api\/v2\/nodes\/[^/]+\/access-grants(?:\/|$)/.test(path)) return "node-access:manage";
    if (path.startsWith("/api/v2/automations")) return read ? "sessions:read" : "sessions:operate";
    if (path === "/api/v2/context") return "team:read";
    if (path.startsWith("/api/v2/nodes")) return read ? "sessions:read" : "sessions:operate";
    if (path.startsWith("/api/v1/team/principals")) return "members:manage";
    if (path.startsWith("/api/v1/team/members") || path.startsWith("/api/v1/team/roles")) {
      return "members:manage";
    }
    if (path === "/api/v1/team") return read ? "team:read" : method === "PATCH" ? "policy:manage" : "members:manage";
    if (path.startsWith("/api/v1/presence")) return read ? "presence:read" : "presence:write";
    if (path.startsWith("/api/v1/fleet")) return "fleet:read";
    if (path.startsWith("/api/v1/peers")) {
      if (path === "/api/v1/peers") return read ? "fleet:read" : "policy:manage";
      if (/^\/api\/v1\/peers\/[^/]+(?:\/(?:verify|discover|credential))?$/.test(path)) {
        return read ? "fleet:read" : "policy:manage";
      }
      return read ? "sessions:read" : "sessions:operate";
    }
    if (path.startsWith("/api/v1/policy")) return read ? "team:read" : "policy:manage";
    if (path.startsWith("/api/v1/audit")) return "audit:read";
    if (
      path.startsWith("/devices") ||
      path.startsWith("/api/v1/devices") ||
      path.startsWith("/api/v1/relay/pairing") ||
      path.startsWith("/pairing/") ||
      path === "/access/reset" ||
      path === "/token/rotate"
    ) {
      return "members:manage";
    }
    if (path.startsWith("/api/v1/workspaces") || path.startsWith("/api/v1/worktrees")) {
      return read ? "sessions:read" : "workspaces:manage";
    }
    if (path.startsWith("/fs/"))
      return read ? "sessions:read" : path === "/fs/mkdir" ? "workspaces:manage" : "sessions:operate";
    if (path.startsWith("/api/v1/attention")) return read ? "attention:read" : "attention:manage";
    if (path.startsWith("/api/v1/extensions") || path.startsWith("/api/v1/adapters")) {
      return read ? "team:read" : "extensions:manage";
    }
    if (path.startsWith("/api/v1/plugins")) return read ? "team:read" : "sessions:operate";
    if (
      path.startsWith("/api/v1/automations") ||
      path.startsWith("/update") ||
      path.startsWith("/settings/") ||
      path.startsWith("/providers/") ||
      path.startsWith("/auth/")
    ) {
      return read ? "team:read" : "policy:manage";
    }
    if (path.startsWith("/push/")) return "team:read";
    if (path.startsWith("/images") || path.startsWith("/sessions/") || path.startsWith("/api/v1/sessions")) {
      return read ? "sessions:read" : "sessions:operate";
    }
    if (path.startsWith("/api/v1/agents")) return read ? "sessions:read" : "sessions:operate";
    if (path === "/api/v1/layout") return read ? "team:read" : "sessions:operate";
    if (
      path.startsWith("/api/v1/events") ||
      path.startsWith("/api/v1/search") ||
      path.startsWith("/api/v1/host") ||
      path.startsWith("/api/v1/hosts") ||
      path.startsWith("/api/v1/capabilities") ||
      path.startsWith("/api/v1/openapi") ||
      path === "/sessions"
    ) {
      return read ? "sessions:read" : "sessions:operate";
    }
    // A terminal ticket carries the already-authorized principal; the socket re-checks `sessions:operate` before
    // granting an input lease. Viewers still need a ticket to attach to the read-only terminal output.
    if (path === "/ws-ticket") return "sessions:read";
    // An authenticated route added later is never implicitly admin-capable in enforced team mode.
    return read ? "team:read" : "policy:manage";
  };
  const isPeerOperationPath = (path: string): boolean =>
    /^\/api\/v1\/peers\/[^/]+\/(?:agents|sessions|workspaces)(?:\/|$)/.test(path);

  const authorizationResourceForRequest = (
    request: FastifyRequest,
    path: string,
  ): { hostId: string; workspaceId?: string } => {
    const hostId = commandStore.getHost().id;
    // Product v2 is Node-scoped. Legacy workspace bindings must never widen into a Node/runtime/automation grant.
    if (path.startsWith("/api/v2/")) return { hostId };
    const params = request.params as { id?: unknown; automationId?: unknown } | undefined;
    const id = typeof params?.id === "string" ? params.id : undefined;
    if (id && (path.startsWith("/sessions/") || path.startsWith("/api/v1/sessions/"))) {
      return {
        hostId,
        ...(commandStore.placementForSession(id)?.workspaceId
          ? { workspaceId: commandStore.placementForSession(id)!.workspaceId }
          : {}),
      };
    }
    if (id && path.startsWith("/api/v1/agents/")) {
      return {
        hostId,
        ...(commandStore.getAgent(id)?.workspaceId ? { workspaceId: commandStore.getAgent(id)!.workspaceId } : {}),
      };
    }
    if (id && path.startsWith("/api/v1/workspaces/")) return { hostId, workspaceId: id };
    if (id && path.startsWith("/api/v1/attention/")) {
      const item = commandStore
        .listAttention({ includeResolved: true, includeSnoozed: true })
        .find((candidate) => candidate.id === id);
      return { hostId, ...(item ? { workspaceId: item.workspaceId } : {}) };
    }
    const body = request.body as
      { cwd?: unknown; workspaceId?: unknown; sessionId?: unknown; agentId?: unknown } | undefined;
    const query = request.query as { workspaceId?: unknown; sessionId?: unknown; agentId?: unknown } | undefined;
    const workspaceId =
      typeof body?.workspaceId === "string"
        ? body.workspaceId
        : typeof query?.workspaceId === "string"
          ? query.workspaceId
          : undefined;
    if (workspaceId) return { hostId, workspaceId };
    const sessionId =
      typeof body?.sessionId === "string"
        ? body.sessionId
        : typeof query?.sessionId === "string"
          ? query.sessionId
          : undefined;
    if (sessionId) {
      const placement = commandStore.placementForSession(sessionId);
      return { hostId, ...(placement ? { workspaceId: placement.workspaceId } : {}) };
    }
    const agentId =
      typeof body?.agentId === "string" ? body.agentId : typeof query?.agentId === "string" ? query.agentId : undefined;
    if (agentId) {
      const agent = commandStore.getAgent(agentId);
      return { hostId, ...(agent ? { workspaceId: agent.workspaceId } : {}) };
    }
    if (typeof body?.cwd === "string") {
      const workspace = commandStore
        .listWorkspaces({ includeArchived: true })
        .find((candidate) => candidate.cwd === body.cwd);
      if (workspace) return { hostId, workspaceId: workspace.id };
    }
    return { hostId };
  };

  // Team authorization is opt-in and default-deny once enabled. It runs after credential/origin validation and
  // before route handlers/idempotency so UI, CLI, direct API, and relay principals receive the exact same decision.
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticatedPrincipals.get(request);
    if (!principal) return;
    const path = pathForGate(request.url);
    // A freshly paired peer device needs the privacy-bounded capability document to pin host identity before an
    // organization binds that device to a service member. This bootstrap read contains no paths, sessions, source,
    // provider credentials, or policy state; every operational route remains default-deny under normal RBAC.
    if (principal.actorType === "device" && request.method === "GET" && path === "/api/v1/capabilities") return;
    // Managed clients must be able to explain and recover from an expired snapshot. This exact read exposes only
    // coarse sync state and stable recovery codes; it never returns ids, credentials, keys, claims, or origins.
    if (
      (principal.actorType === "device" || principal.actorType === "relay") &&
      request.method === "GET" &&
      path === "/api/v1/cloud/status"
    )
      return;
    // A paired device must bind its host-canonical DeviceStore actor before a cloud snapshot can grant it
    // ordinary permissions. Keep this bootstrap exception exact; the handler still requires a device/relay
    // principal and never accepts an actor id or callback URL from the request body.
    if (
      (principal.actorType === "device" || principal.actorType === "relay") &&
      request.method === "POST" &&
      path === CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE
    )
      return;
    // Peer resources live in the remote host/workspace namespace. Their handlers resolve that namespace and
    // apply the same authorization decision before returning data or forwarding an operation.
    if (isPeerOperationPath(path)) return;
    const routeParams = request.params as { id?: unknown } | undefined;
    if (
      principal.actorType === "device" &&
      typeof routeParams?.id === "string" &&
      routeParams.id === principal.actorId &&
      (path.startsWith("/devices/") || path.startsWith("/api/v1/devices/")) &&
      ["PATCH", "DELETE"].includes(request.method)
    ) {
      return;
    }
    const leaseAction = (request.body as { action?: unknown } | undefined)?.action;
    const permission =
      request.method === "POST" && path.endsWith("/input-lease") && leaseAction === "revoke"
        ? "policy:manage"
        : permissionForRequest(path, request.method);
    const decision = authorizer.authorize(
      principal.actorType,
      principal.actorId,
      permission,
      authorizationResourceForRequest(request, path),
    );
    if (decision.allowed) return;
    try {
      controlStore.appendAudit({
        actorType: principal.actorType === "relay" ? "device" : principal.actorType,
        actorId: principal.actorId,
        action: "team.authorization.denied",
        targetType: path.split("/").filter(Boolean).at(2) ?? "route",
        result: "denied",
        metadata: { permission, reason: decision.reason },
        createdAt: Date.now(),
      });
    } catch {
      /* authorization remains fail-closed when audit storage is unavailable */
    }
    reply.code(403).send({
      code: "TEAM_PERMISSION_DENIED",
      error: "your team role does not permit this operation",
      permission,
    });
  });

  // Organization policy is separate from RBAC: a policy administrator may edit policy, but ordinary operations
  // remain inside the same host/workspace/provider/data-movement boundary for UI, CLI, direct API, and relay calls.
  // The explicit host/local recovery principal bypasses enforcement so a bad allowlist cannot permanently brick a
  // local-first installation. Every remote denial is integrity-audited without request bodies or credentials.
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticatedPrincipals.get(request);
    if (!principal || principal.actorType === "host" || principal.actorType === "local") return;
    const path = pathForGate(request.url);
    if (path === "/api/v1/policy") return;
    if (request.method === "GET" && path === "/api/v1/cloud/status") return;
    if (request.method === "POST" && path === CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE) return;
    if (isPeerOperationPath(path)) return;
    const resource = authorizationResourceForRequest(request, path);
    const baseContext: EnterprisePolicyContext = {
      hostId: resource.hostId,
      ...(resource.workspaceId ? { workspaceId: resource.workspaceId } : {}),
    };
    const policy = policyStore.get();
    let action: EnterprisePolicyAction = "access";
    let context = baseContext;
    const fileTransfer =
      path === "/fs/upload" ||
      path === "/fs/download" ||
      path.startsWith("/images/") ||
      /^\/sessions\/[^/]+\/files(?:\/|$)/.test(path);
    const extensionMutation =
      mutationMethods.has(request.method) &&
      path !== "/api/v1/extensions/inspect" &&
      (path.startsWith("/api/v1/extensions") || path.startsWith("/api/v1/plugins"));
    if (principal.actorType === "relay" || path.startsWith("/api/v1/relay/")) action = "relay.access";
    else if (fileTransfer) action = "file.transfer";
    else if (extensionMutation) {
      action = "extension.mutate";
      const params = request.params as { kind?: unknown; id?: unknown } | undefined;
      const body = request.body as { signature?: unknown; publicKey?: unknown } | undefined;
      let extensionTrust: "signed" | "integrity" | undefined;
      if (path === "/api/v1/extensions/install") {
        extensionTrust =
          typeof body?.signature === "string" && typeof body.publicKey === "string" ? "signed" : "integrity";
      } else if (typeof params?.id === "string") {
        const kind = params.kind === "adapter" || params.kind === "plugin" ? params.kind : "plugin";
        extensionTrust = extensionManager.get(kind, params.id)?.current.trust;
      }
      context = { ...baseContext, ...(extensionTrust ? { extensionTrust } : {}) };
    } else if (mutationMethods.has(request.method) && path.startsWith("/update")) {
      action = "update.mutate";
      context = { ...baseContext, updateChannel: "stable" };
    }
    const decision = evaluateEnterprisePolicy(policy, action, context);
    if (decision.allowed) return;
    try {
      controlStore.appendAudit({
        actorType: principal.actorType === "relay" ? "device" : principal.actorType,
        actorId: principal.actorId,
        action: "enterprise.policy.denied",
        targetType: action,
        result: "denied",
        metadata: { reason: decision.reason, route: request.routeOptions.url || path },
        createdAt: Date.now(),
      });
    } catch {
      /* The authorization decision remains fail-closed if audit storage is unavailable. */
    }
    reply.code(403).send({
      code: "ENTERPRISE_POLICY_DENIED",
      error: "organization policy does not permit this operation",
      reason: decision.reason,
    });
  });

  // Ordinary v1/v2 mutations accept a standard Idempotency-Key. One-use bootstrap responses are deliberately
  // excluded because replay storage must never become a second plaintext credential store.
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = pathForGate(request.url);
    if (!(path.startsWith("/api/v1/") || path.startsWith("/api/v2/")) || !mutationMethods.has(request.method)) return;
    const route = request.routeOptions.url || path;
    const rawParams = request.params as
      | {
          id?: unknown;
          nodeId?: unknown;
          automationId?: unknown;
          bindingId?: unknown;
          grantId?: unknown;
        }
      | undefined;
    const targetType = path.split("/")[3] || "resource";
    const targetId = [
      rawParams?.id,
      rawParams?.automationId,
      rawParams?.bindingId,
      rawParams?.grantId,
      rawParams?.nodeId,
    ].find((candidate): candidate is string => typeof candidate === "string");
    const actor = actorForRequest(request);
    const context: MutationContext = { ...actor, route, targetType, ...(targetId ? { targetId } : {}) };
    mutationContexts.set(request, context);

    const rawKey = request.headers["idempotency-key"];
    if (rawKey === undefined) return;
    if (path === "/api/v1/relay/pairing") {
      reply.code(400).send({
        code: "IDEMPOTENCY_NOT_SUPPORTED",
        error: "idempotency-key is not supported for one-use relay pairing credentials",
      });
      return;
    }
    const key = Array.isArray(rawKey) ? undefined : rawKey.trim();
    if (!key || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
      reply.code(400).send({ code: "INVALID_IDEMPOTENCY_KEY", error: "idempotency-key must be 1-128 safe characters" });
      return;
    }
    // The concrete path is part of the operation identity. A route template alone would make the same key/body
    // on `/automations/A` and `/automations/B` replay A's response for B.
    const fingerprint = mutationFingerprint(request.method, path, request.body);
    const stored = controlStore.getIdempotency(actor.actorId, key);
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        reply
          .code(409)
          .send({ code: "IDEMPOTENCY_CONFLICT", error: "idempotency key was already used for another request" });
        return;
      }
      context.idempotency = { key, fingerprint, replayed: true };
      reply.header("idempotency-replayed", "true").code(stored.statusCode);
      if (stored.statusCode === 204 || stored.body.length === 0) reply.send();
      else reply.type("application/json; charset=utf-8").send(stored.body);
      return;
    }
    const reservationKey = `${actor.actorType}\0${actor.actorId}\0${key}`;
    const inFlight = inFlightIdempotency.get(reservationKey);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        reply
          .code(409)
          .send({ code: "IDEMPOTENCY_CONFLICT", error: "idempotency key is already running another request" });
        return;
      }
      const outcome = await inFlight.outcome;
      context.idempotency = { key, fingerprint, replayed: true };
      reply.header("idempotency-replayed", "true").code(outcome.statusCode);
      if (outcome.statusCode === 204 || outcome.body.length === 0) reply.send();
      else reply.type("application/json; charset=utf-8").send(outcome.body);
      return;
    }
    let resolveOutcome!: (outcome: IdempotencyOutcome) => void;
    const outcome = new Promise<IdempotencyOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    inFlightIdempotency.set(reservationKey, { fingerprint, outcome, resolve: resolveOutcome });
    context.idempotency = { key, fingerprint, replayed: false, reservationKey };
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    const context = mutationContexts.get(request);
    if (!context?.idempotency || context.idempotency.replayed) {
      done(null, payload);
      return;
    }
    const body = Buffer.isBuffer(payload) ? payload.toString("utf8") : typeof payload === "string" ? payload : "";
    // Control responses are intentionally small. Refuse to persist an unexpectedly large payload while
    // still returning it normally; the mutation's audit trail remains available.
    if (Buffer.byteLength(body, "utf8") <= 256 * 1024) {
      try {
        const now = Date.now();
        controlStore.putIdempotency({
          actorId: context.actorId,
          key: context.idempotency.key,
          fingerprint: context.idempotency.fingerprint,
          statusCode: reply.statusCode,
          body,
          createdAt: now,
          expiresAt: now + CONTROL_IDEMPOTENCY_TTL_MS,
        });
      } catch {
        /* idempotency persistence failure must not replace the actual mutation response */
      }
    }
    if (context.idempotency.reservationKey) {
      const inFlight = inFlightIdempotency.get(context.idempotency.reservationKey);
      if (inFlight) {
        inFlightIdempotency.delete(context.idempotency.reservationKey);
        inFlight.resolve({ statusCode: reply.statusCode, body });
      }
    }
    done(null, payload);
  });

  app.addHook("onResponse", async (request, reply) => {
    const context = mutationContexts.get(request);
    if (!context) return;
    try {
      controlStore.appendAudit({
        actorType: context.actorType,
        actorId: context.actorId,
        action: `${request.method} ${context.route}`,
        targetType: context.targetType,
        ...(context.targetId ? { targetId: context.targetId } : {}),
        result:
          reply.statusCode < 400
            ? "success"
            : reply.statusCode === 401 || reply.statusCode === 403
              ? "denied"
              : "error",
        metadata: {
          statusCode: reply.statusCode,
          ...(context.idempotency ? { idempotencyReplay: context.idempotency.replayed } : {}),
        },
        createdAt: Date.now(),
      });
    } catch {
      // Control-plane bookkeeping must never turn a completed product mutation into a failed response.
    }
  });

  // WebSocket support. Registered synchronously; routes are added below.
  app.register(websocket);

  // Handshake auth is handled by the GLOBAL preHandler (it runs for the upgrade GET and
  // reads ?token= too). By the time this handler runs, the token is already validated;
  // we only reject an unknown session here.
  app.register(async (wsScope) => {
    wsScope.get<{ Params: { id: string }; Querystring: { cols?: string; rows?: string; respawn?: string } }>(
      "/sessions/:id/terminal",
      { websocket: true },
      (
        socket: WebSocket,
        request: FastifyRequest<{
          Params: { id: string };
          Querystring: { cols?: string; rows?: string; respawn?: string };
        }>,
      ) => {
        const id = request.params.id;
        if (!terminalManager.get(id)) {
          socket.close(4404, "terminal session not found");
          return;
        }
        const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
        const holderId = `ws:${randomUUID()}`;
        let leaseId: string | undefined;
        let lastLeaseRevision = 0;
        const sendLeaseState = (reason?: string, revision?: number) => {
          const current = inputLeases.get(id);
          const writable = current?.holderId === holderId;
          if (writable) leaseId = current.id;
          lastLeaseRevision = Math.max(lastLeaseRevision, revision ?? current?.revision ?? 0);
          if (socket.readyState !== socket.OPEN || socket.bufferedAmount > MAX_TERMINAL_WS_BUFFER) return;
          try {
            socket.send(
              JSON.stringify({
                t: "input-lease",
                writable,
                owner: current ? { actorType: current.actorType, label: current.label } : null,
                ...(current ? { expiresAt: current.expiresAt } : {}),
                revision: lastLeaseRevision,
                canTakeover: !writable && canWriteSession(principal, id),
                ...(reason ? { reason } : {}),
              }),
            );
          } catch {
            /* the close/error handler owns teardown */
          }
        };
        const initialLease = canWriteSession(principal, id) ? inputLeases.acquire(id, holderId, principal) : undefined;
        if (initialLease && initialLease.status !== "denied") leaseId = initialLease.lease.id;
        const unsubscribeLease = inputLeases.subscribe(id, (event) => sendLeaseState(undefined, event.lease.revision));
        if (principal.actorType === "device" || principal.actorType === "relay") {
          const sockets = remotePrincipalSockets.get(principal.actorId) ?? new Set<WebSocket>();
          sockets.add(socket);
          remotePrincipalSockets.set(principal.actorId, sockets);
        }
        sendLeaseState(
          !initialLease
            ? "your role can view but cannot operate this agent"
            : initialLease.status === "denied"
              ? "input is controlled by another client"
              : undefined,
        );
        // The client fits its xterm BEFORE connecting and passes the size as `?cols=&rows=`, so the pty/tmux
        // is born at the real viewport (no spawn-at-80×24-then-reflow). Parsed defensively; absent → defaults.
        const c = Number(request.query.cols);
        const r = Number(request.query.rows);
        const size = Number.isInteger(c) && c > 0 && Number.isInteger(r) && r > 0 ? { cols: c, rows: r } : undefined;
        // `?respawn=continue`: when THIS connect respawns an ENDED session, the fresh claude gets
        // `--continue` (resume the previous conversation) for that spawn only. Absent / `fresh` /
        // any other value = today's blank-slate respawn. Ignored entirely on a live reattach.
        const respawn = request.query.respawn === "continue" ? ("continue" as const) : ("fresh" as const);
        let sub: Awaited<ReturnType<typeof terminalManager.attach>>;
        let closed = false;
        let pingTimer: NodeJS.Timeout | undefined;
        let leaseRenewTimer: NodeJS.Timeout | undefined;
        let authorizationRecheckTimer: NodeJS.Timeout | undefined;
        let pendingFrames: Buffer[] = [];
        let pendingBytes = 0;
        const attachAbort = new AbortController();
        const detach = () => {
          if (closed) return;
          closed = true;
          attachAbort.abort();
          pendingFrames = [];
          pendingBytes = 0;
          if (pingTimer) clearInterval(pingTimer);
          if (leaseRenewTimer) clearInterval(leaseRenewTimer);
          if (authorizationRecheckTimer) clearInterval(authorizationRecheckTimer);
          unsubscribeLease();
          inputLeases.releaseHolder(holderId);
          if (principal.actorType === "device" || principal.actorType === "relay") {
            const sockets = remotePrincipalSockets.get(principal.actorId);
            sockets?.delete(socket);
            if (sockets?.size === 0) remotePrincipalSockets.delete(principal.actorId);
          }
          sub?.unsubscribe();
          sub = undefined;
        };
        const closeSafely = (code: number, reason: string) => {
          detach();
          try {
            socket.close(code, reason);
          } catch {
            /* already gone */
          }
        };
        const enforceWriteAuthorization = (notify = false): boolean => {
          if (canWriteSession(principal, id)) return true;
          const heldLease = inputLeases.get(id)?.holderId === holderId || leaseId !== undefined;
          inputLeases.releaseHolder(holderId);
          leaseId = undefined;
          if (notify || heldLease) sendLeaseState("your role can view but cannot operate this agent");
          return false;
        };
        const reauthorizeRemoteTerminal = (): boolean => {
          if (!canReadSession(principal, id)) {
            closeSafely(4403, "terminal access revoked");
            return false;
          }
          enforceWriteAuthorization();
          return true;
        };
        type TerminalClientMessage = {
          t?: string;
          d?: string;
          c?: number;
          r?: number;
          action?: string;
          confirm?: boolean;
        };
        const parseMessage = (raw: Buffer): TerminalClientMessage | undefined => {
          if (raw.length > MAX_TERMINAL_INPUT_BYTES) return;
          try {
            const value = JSON.parse(raw.toString()) as unknown;
            return value !== null && typeof value === "object" ? (value as TerminalClientMessage) : undefined;
          } catch {
            return;
          }
        };
        const auditDeniedTakeover = (reason: "confirmation_required" | "not_authorized") => {
          const actorType: AuditActorType = principal.actorType === "relay" ? "device" : principal.actorType;
          try {
            controlStore.appendAudit({
              actorType,
              actorId: principal.actorId,
              action: "session.input_lease.takeover",
              targetType: "session",
              targetId: id,
              result: "denied",
              metadata: { reason },
              createdAt: Date.now(),
            });
          } catch {
            /* ownership enforcement does not depend on audit availability */
          }
        };
        const dispatchLeaseAction = (msg: TerminalClientMessage): boolean => {
          if (msg.t !== "lease") return false;
          if (msg.action === "acquire") {
            if (!canWriteSession(principal, id)) {
              auditDeniedTakeover("not_authorized");
              sendLeaseState("your role can view but cannot operate this agent");
              return true;
            }
            const result = inputLeases.acquire(id, holderId, principal);
            if (result.status !== "denied") leaseId = result.lease.id;
            sendLeaseState(result.status === "denied" ? "input is controlled by another client" : undefined);
            return true;
          }
          if (msg.action === "takeover") {
            const authorized = canTakeOverSession(principal, id);
            const result = inputLeases.takeover(id, holderId, principal, msg.confirm === true, authorized);
            if (result.status === "denied") {
              const reason = msg.confirm === true && !authorized ? "not_authorized" : "confirmation_required";
              auditDeniedTakeover(reason);
              sendLeaseState(reason === "not_authorized" ? "you are not allowed to take control" : "confirm takeover");
            } else {
              leaseId = result.lease.id;
              sendLeaseState();
            }
            return true;
          }
          if (msg.action === "release") {
            inputLeases.release(id, holderId, leaseId);
            leaseId = undefined;
            sendLeaseState();
            return true;
          }
          if (msg.action === "renew" && leaseId) {
            if (!enforceWriteAuthorization(true)) return true;
            inputLeases.renew(id, holderId, leaseId);
            sendLeaseState();
            return true;
          }
          sendLeaseState("unknown input lease action");
          return true;
        };
        const dispatchInput = (raw: Buffer) => {
          const msg = parseMessage(raw);
          if (!msg) return;
          if (dispatchLeaseAction(msg)) return;
          if (!enforceWriteAuthorization(true)) return;
          if (!inputLeases.canWrite(id, holderId, leaseId)) {
            sendLeaseState("view-only connection cannot send terminal input");
            return;
          }
          try {
            if (msg.t === "i" && typeof msg.d === "string") terminalManager.write(id, msg.d);
            else if (msg.t === "r" && typeof msg.c === "number" && typeof msg.r === "number")
              terminalManager.resize(id, msg.c, msg.r);
          } catch {
            closeSafely(4400, "terminal input failed");
          }
        };
        socket.on("message", (raw: Buffer) => {
          if (closed) return;
          const frame = Buffer.from(raw);
          const parsed = parseMessage(frame);
          if (parsed?.t === "lease") {
            dispatchLeaseAction(parsed);
            return;
          }
          if (sub) {
            dispatchInput(frame);
            return;
          }
          if (
            frame.length > MAX_TERMINAL_INPUT_BYTES ||
            pendingFrames.length >= MAX_PENDING_TERMINAL_INPUT_FRAMES ||
            pendingBytes + frame.length > MAX_PENDING_TERMINAL_INPUT_BYTES
          ) {
            closeSafely(4400, "terminal input overflow");
            return;
          }
          pendingFrames.push(frame);
          pendingBytes += frame.length;
        });
        socket.on("close", detach);
        socket.on("error", detach);
        // Signed cloud authorization can change or expire while a terminal is already attached. HTTP hooks only
        // protect the upgrade, so managed remote sockets must periodically re-check read access. A lost read grant
        // closes output immediately; a narrower operate loss keeps the observer connected but drops its input lease.
        // Self-hosted sockets intentionally keep their existing event-driven behavior.
        if (deps.cloudStatus && (principal.actorType === "device" || principal.actorType === "relay")) {
          authorizationRecheckTimer = setInterval(reauthorizeRemoteTerminal, terminalAuthorizationRecheckMs);
          authorizationRecheckTimer.unref?.();
        }
        void terminalManager
          .attach(
            id,
            {
              onData: (chunk) => {
                if (socket.readyState !== socket.OPEN) return;
                // Backpressure: if the client can't drain (slow link, backgrounded tab) and we've buffered a
                // runaway amount of pty output, close rather than grow Node's heap unbounded. The client
                // reconnects and tmux redraws a clean screen, so no state is lost.
                if (socket.bufferedAmount > MAX_TERMINAL_WS_BUFFER) {
                  try {
                    socket.close(4400, "terminal backpressure");
                  } catch {
                    /* already gone */
                  }
                  return;
                }
                try {
                  socket.send(Buffer.from(chunk, "utf8")); // binary frame
                } catch {
                  sub?.unsubscribe();
                  try {
                    socket.close();
                  } catch {
                    /* already gone */
                  }
                }
              },
              // claude exited (the manager ended the session) → tell the client so it shows Restart/Close
              // instead of a frozen screen. 4410 = "ended" (do NOT auto-reconnect on this code).
              onExit: () => {
                try {
                  socket.close(4410, "session ended");
                } catch {
                  /* already gone */
                }
              },
              // Out-of-band control (file/image attachments claude sent) → a TEXT frame, so the client can
              // split it from the BINARY pty stream. Skipped under backpressure like the data path.
              onControl: (json) => {
                if (socket.readyState !== socket.OPEN || socket.bufferedAmount > MAX_TERMINAL_WS_BUFFER) return;
                try {
                  socket.send(json);
                } catch {
                  /* already gone */
                }
              },
            },
            canWriteSession(principal, id) && inputLeases.canWrite(id, holderId, leaseId) ? size : undefined,
            { respawn, signal: attachAbort.signal },
          )
          .then((attached) => {
            if (!attached) {
              if (!closed) closeSafely(4404, "terminal session not found");
              return;
            }
            sub = attached;
            const liveSub = attached;
            if (closed || socket.readyState !== socket.OPEN) {
              liveSub.unsubscribe();
              sub = undefined;
              return;
            }
            // KEEPALIVE: ping the (possibly idle) client so a fronting proxy doesn't drop the connection out
            // from under a live terminal. .unref() so the timer never keeps the process alive; cleared below.
            pingTimer = setInterval(() => {
              if (socket.readyState === socket.OPEN) {
                try {
                  socket.ping();
                } catch {
                  /* socket dying — the close handler cleans up */
                }
              }
            }, TERMINAL_WS_PING_MS);
            pingTimer.unref?.();
            leaseRenewTimer = setInterval(() => {
              if (!leaseId) return;
              if (!enforceWriteAuthorization()) return;
              if (!inputLeases.canWrite(id, holderId, leaseId)) return;
              inputLeases.renew(id, holderId, leaseId);
            }, INPUT_LEASE_RENEW_MS);
            leaseRenewTimer.unref?.();
            const replay = pendingFrames;
            pendingFrames = [];
            pendingBytes = 0;
            for (const frame of replay) {
              if (closed || socket.readyState !== socket.OPEN || sub !== liveSub) break;
              dispatchInput(frame);
            }
          })
          .catch(() => {
            if (!closed && socket.readyState === socket.OPEN) closeSafely(4404, "terminal attach failed");
          });
      },
    );
  });

  const launchSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    body: CreateSessionBody | undefined,
    v2Projection?: V2SessionProjection,
    onCreated?: (result: LaunchedSessionResult) => void | Promise<void>,
    requestedSessionId?: string,
  ) => {
    if (!body || typeof body.cwd !== "string") {
      reply.code(400).send({ code: "INVALID_SESSION_REQUEST", error: "cwd is required" });
      return;
    }
    const requestedProvider = body.provider === undefined ? "claude" : body.provider;
    if (typeof requestedProvider !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(requestedProvider)) {
      reply.code(400).send({ code: "INVALID_PROVIDER", error: "Invalid provider" });
      return;
    }
    const provider: ProviderId = requestedProvider;
    if (providers.source(provider) === undefined) {
      reply.code(400).send({ code: "INVALID_PROVIDER", error: "Invalid provider" });
      return;
    }
    const id = requestedSessionId ?? randomUUID();
    const existingMeta = requestedSessionId ? terminalManager.get(id) : undefined;
    // Terminal is the only mode: spawn a pty-backed tmux session.
    if (!terminalAvailable) {
      reply.code(400).send({
        code: "TERMINAL_UNAVAILABLE",
        error: "terminal mode unavailable",
        hint: "install tmux on the host (and ensure node-pty loads)",
      });
      return;
    }
    try {
      if (!providers.isEnabled(provider)) throw new Error("disabled");
      const selectedProvider = providers.get(provider);
      const availability = await selectedProvider.probe();
      if (!availability.terminalAvailable) throw new Error("unavailable");
    } catch {
      reply.code(503).send({ code: "PROVIDER_UNAVAILABLE", error: "Provider terminal unavailable" });
      return;
    }
    // CONCURRENCY CAP (host DoS): bound the number of LIVE terminal sessions. Only running sessions count,
    // so dormant/errored records don't and reopening within the cap is unaffected.
    const liveTerminals = terminalManager.list().filter((t) => t.status === "running").length;
    if (!existingMeta && config.maxSessions > 0 && liveTerminals >= config.maxSessions) {
      reply.code(429).send({ code: "SESSION_CAP_REACHED", error: sessionCapMessage });
      return;
    }
    // Validate the cwd up-front (it's a real directory) so a bad path fails the CREATE with a clear error
    // instead of silently failing later when the pty lazily spawns on first attach.
    try {
      const s = await stat(body.cwd);
      if (!s.isDirectory()) {
        reply.code(400).send({ code: "INVALID_CWD", error: `cwd is not a directory: ${body.cwd}` });
        return;
      }
    } catch {
      reply.code(400).send({ code: "INVALID_CWD", error: `cwd does not exist: ${body.cwd}` });
      return;
    }
    const rawOptions =
      body.options ??
      (provider === "claude"
        ? {
            ...(typeof body.model === "string" ? { model: body.model } : {}),
            ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
            ...(Array.isArray(body.addDirs) ? { addDirs: body.addDirs } : {}),
            ...(typeof body.dangerouslySkip === "boolean" ? { dangerouslySkip: body.dangerouslySkip } : {}),
            ...(typeof body.permissionMode === "string" ? { permissionMode: body.permissionMode } : {}),
          }
        : {});
    let options;
    const warnings: Array<{ code: "PROVIDER_METADATA_UNAVAILABLE"; message: string }> = [];
    try {
      options = parseProviderOptions(provider, rawOptions, providers.manifest(provider).optionSchema);
      for (const dir of options.addDirs ?? []) {
        const dirStat = await stat(dir);
        if (!dirStat.isDirectory())
          throw new ProviderOptionsError("Invalid provider options: addDirs must be directories");
      }
    } catch (error) {
      const code = error instanceof ProviderError && error.code === "PROVIDER_UNAVAILABLE" ? 503 : 400;
      reply.code(code).send({
        code: error instanceof ProviderError ? error.code : "INVALID_PROVIDER_OPTIONS",
        error: error instanceof ProviderError ? error.message : "Invalid provider options",
      });
      return;
    }
    const launchPrincipal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    if (launchPrincipal.actorType !== "host" && launchPrincipal.actorType !== "local") {
      const workspace = commandStore
        .listWorkspaces({ includeArchived: true })
        .find((candidate) => candidate.cwd === resolvePath(body.cwd));
      const launchDecision = evaluateEnterprisePolicy(policyStore.get(), "session.launch", {
        hostId: commandStore.getHost().id,
        ...(workspace ? { workspaceId: workspace.id } : {}),
        providerId: provider,
        dangerousProviderMode: usesDangerousProviderMode(options),
      });
      if (!launchDecision.allowed) {
        try {
          controlStore.appendAudit({
            actorType: launchPrincipal.actorType === "relay" ? "device" : launchPrincipal.actorType,
            actorId: launchPrincipal.actorId,
            action: "enterprise.policy.denied",
            targetType: "session.launch",
            result: "denied",
            metadata: { reason: launchDecision.reason, provider },
            createdAt: Date.now(),
          });
        } catch {
          /* Policy remains fail-closed if audit storage is unavailable. */
        }
        reply.code(403).send({
          code: "ENTERPRISE_POLICY_DENIED",
          error: "organization policy does not permit this session",
          reason: launchDecision.reason,
        });
        return;
      }
    }
    if (options.provider === "codex" && options.model) {
      if (deps.codexMetadata) {
        try {
          await deps.codexMetadata.validateModelSelection(options.model, options.reasoningEffort);
        } catch (error) {
          if (error instanceof ProviderError && error.code === "INVALID_PROVIDER_OPTIONS") {
            reply.code(400).send({
              code: "INVALID_PROVIDER_OPTIONS",
              error: "Invalid Codex model or reasoning selection",
            });
            return;
          }
          warnings.push({
            code: "PROVIDER_METADATA_UNAVAILABLE",
            message: "Codex model compatibility could not be verified",
          });
        }
      } else {
        warnings.push({
          code: "PROVIDER_METADATA_UNAVAILABLE",
          message: "Codex model compatibility could not be verified",
        });
      }
    }
    if (options.provider === "claude" && options.model && deps.claudeMetadata) {
      try {
        await deps.claudeMetadata.validateModelSelection(options.model, options.effort);
      } catch (error) {
        if (error instanceof ProviderError && error.code === "INVALID_PROVIDER_OPTIONS") {
          reply.code(400).send({
            code: "INVALID_PROVIDER_OPTIONS",
            error: "Invalid Claude model or effort selection",
          });
          return;
        }
        warnings.push({
          code: "PROVIDER_METADATA_UNAVAILABLE",
          message: "Claude model compatibility could not be verified",
        });
      }
    }
    // TOCTOU: the cap was checked before the `await stat` above, which yields — re-check right before the
    // (synchronous) create so two concurrent POSTs can't both pass the cap and exceed maxSessions.
    if (
      !existingMeta &&
      config.maxSessions > 0 &&
      terminalManager.list().filter((t) => t.status === "running").length >= config.maxSessions
    ) {
      reply.code(429).send({ code: "SESSION_CAP_REACHED", error: sessionCapMessage });
      return;
    }
    let meta: ReturnType<TerminalManager["create"]>;
    let reused = false;
    try {
      if (existingMeta) {
        if (existingMeta.provider !== provider || resolvePath(existingMeta.cwd) !== resolvePath(body.cwd)) {
          reply.code(409).send({
            code: "SESSION_IDENTITY_CONFLICT",
            error: "idempotent session identity belongs to another runtime or directory",
          });
          return;
        }
        meta = existingMeta;
        reused = true;
      } else {
        meta = terminalManager.create({ id, cwd: body.cwd, provider, options });
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        reply
          .code(error.code === "PROVIDER_UNAVAILABLE" ? 503 : 400)
          .send({ code: error.code, error: "Provider session could not be created" });
      } else {
        reply.code(500).send({ code: "SESSION_CREATE_FAILED", error: "Session could not be created" });
      }
      return;
    }
    let rememberedSessionOptions: ReturnType<SessionStore["getSessionDefaults"]>;
    try {
      if (reused) {
        rememberedSessionOptions = store.getSessionDefaults();
      } else {
        if (!canRememberSessionOptions) throw new Error("session preference storage unavailable");
        if (provider === "claude" || provider === "codex") {
          rememberedSessionOptions = store.rememberSessionDefaults(
            sessionDefaultsForLaunch(store.getSessionDefaults()?.defaults, options),
            Date.now(),
          );
        }
      }
    } catch {
      // The session already exists at this point; a preference write failure must not turn a successful launch
      // into a misleading create error. Avoid logging cwd/options or storage paths from the underlying error.
      request.log.warn("Could not remember the latest session options");
    }
    const commandPlacement = syncCommandAgent(meta.id, meta.activity);
    // Return `{ session }` (not a flat body). The web client does `return (await res.json()).session`.
    // Shape the session like a SessionMeta (mode:"terminal" so the client routes to TerminalView). Echo the
    // derived dangerouslySkip so the rail badges an RCE-skip session from the moment it's created.
    const response = {
      session: {
        id: meta.id,
        provider: meta.provider,
        cwd: meta.cwd,
        mode: "terminal" as const,
        status: meta.status,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        ...(v2Projection
          ? v2Projection
          : commandPlacement
            ? {
                workspaceId: commandPlacement.placement.workspaceId,
                agentId: commandPlacement.placement.agentId,
                agentActivity: commandPlacement.agent.activity,
              }
            : {}),
        dangerouslySkip: meta.dangerouslySkip,
        // Echo the runtime flags so the chat header shows what's actually running from the first render.
        model: meta.model,
        effort: meta.effort,
        permissionMode: meta.permissionMode,
        sandbox: meta.sandbox,
        approvalPolicy: meta.approvalPolicy,
        identityState: meta.identityState,
        resumeIdentity: resumeIdentityFor(meta.provider),
      },
      ...(rememberedSessionOptions
        ? { rememberedSessionOptions: sessionDefaultsEnvelope(rememberedSessionOptions) }
        : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    if (onCreated) {
      await onCreated({ meta, response, reused });
      return;
    }
    reply.code(201).send(response);
  };
  const createSessionHandler = async (request: FastifyRequest<{ Body: CreateSessionBody }>, reply: FastifyReply) =>
    launchSession(request, reply, request.body);
  app.post<{ Body: CreateSessionBody }>("/sessions", createSessionHandler);

  // Unauthenticated liveness probe (the preHandler lets /health through). Returns only { ok: true }.
  app.get("/health", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { ok: true };
  });

  // DEVICE PAIRING: an authenticated device (or the host master token / explicit CLI command writing the
  // same durable store) issues a short-lived capability. The claim route is the sole public API mutation;
  // it returns a fresh per-device credential ONCE and persists only digests of both secrets.
  app.post<{ Body: { scopes?: unknown } }>("/pairing/start", async (request, reply) => {
    if (!config.accessToken) {
      reply.code(409).send({ error: "device pairing is unavailable in tokenless development mode" });
      return;
    }
    try {
      const scopes =
        request.body?.scopes === undefined
          ? (["direct"] satisfies DeviceScope[])
          : normalizeDeviceScopes(request.body.scopes);
      if (!scopes) {
        reply.code(400).send({ code: "INVALID_DEVICE_SCOPES", error: "device scopes must contain direct or relay" });
        return;
      }
      reply.header("cache-control", "no-store").code(201).send(deviceStore.issuePairing(Date.now(), scopes));
    } catch {
      reply.code(500).send({ error: "could not start device pairing" });
    }
  });

  app.post<{ Body: { secret?: unknown } }>("/pairing/cancel", { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const secret = request.body?.secret;
    if (typeof secret !== "string" || !/^rcp_[A-Za-z0-9_-]{43}$/.test(secret)) {
      reply.code(400).send({ code: "INVALID_PAIRING", error: "valid pairing capability is required" });
      return;
    }
    let cancelled = false;
    try {
      cancelled = deviceStore.cancelPairing(secret);
    } catch {
      reply.code(500).send({ code: "PAIRING_CANCEL_FAILED", error: "could not cancel pairing" });
      return;
    }
    if (!cancelled) {
      reply.code(404).send({ code: "PAIRING_NOT_FOUND", error: "pairing is expired, cancelled, or already used" });
      return;
    }
    reply.header("cache-control", "no-store").code(204).send();
  });

  app.post("/api/v1/relay/pairing", async (_request, reply) => {
    const relay = deps.relayPairing;
    if (!relay) {
      reply.code(409).send({
        code: "RELAY_PAIRING_UNAVAILABLE",
        error: "relay pairing is not configured; set a trusted relay app URL on the host",
      });
      return;
    }
    let pendingDeviceId: string | undefined;
    try {
      const pairing = deviceStore.issueRelayPairing();
      pendingDeviceId = pairing.deviceId;
      const deviceCredential = (relay.generateDeviceCredential ?? (() => generateRelayCredential("rrd")))();
      if (!/^rrd_[A-Za-z0-9_-]{43}$/.test(deviceCredential)) {
        throw new Error("invalid generated relay device credential");
      }
      await relay.provisioner.putDevice(pairing.deviceId, relayCredentialHash(deviceCredential), pairing.expiresAt);
      const payload: RelayPairingPackage = {
        v: 1,
        label: relay.label,
        relayUrl: relay.relayUrl,
        routeId: relay.routeId,
        deviceId: pairing.deviceId,
        deviceCredential,
        deviceToken: pairing.token,
        pairingSecret: pairing.secret,
        expiresAt: pairing.expiresAt,
        hostIdentityPublicKey: relay.hostIdentityPublicKey,
        hostIdentityFingerprint: relay.hostIdentityFingerprint,
      };
      reply
        .header("cache-control", "no-store")
        .code(201)
        .send({ pairing: payload, url: buildRelayPairingUrl(relay.appUrl, payload) });
    } catch {
      if (pendingDeviceId) {
        try {
          deviceStore.cancelRelayPairing(pendingDeviceId);
        } catch {
          /* The local bootstrap is expiry-bounded even if immediate cleanup fails. */
        }
        await relay.provisioner.revokeDevice(pendingDeviceId).catch(() => {
          /* The broker-side bootstrap also expires at the pairing deadline. */
        });
      }
      reply.code(502).send({ code: "RELAY_PAIRING_FAILED", error: "could not prepare relay pairing" });
    }
  });

  app.post<{ Body: { deviceId?: unknown } }>(
    "/api/v1/relay/pairing/cancel",
    { bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const relay = deps.relayPairing;
      if (!relay) {
        reply.code(409).send({ code: "RELAY_PAIRING_UNAVAILABLE", error: "relay pairing is not configured" });
        return;
      }
      const deviceId = request.body?.deviceId;
      if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) {
        reply.code(400).send({ code: "INVALID_RELAY_DEVICE", error: "valid relay device id is required" });
        return;
      }
      try {
        const cancellation = deviceStore.beginRelayPairingCancellation(deviceId);
        if (cancellation.status === "busy") {
          reply
            .code(409)
            .send({ code: "RELAY_PAIRING_CANCEL_IN_PROGRESS", error: "relay pairing cancellation is in progress" });
          return;
        }
        if (cancellation.status === "missing") {
          reply.code(404).send({ code: "RELAY_PAIRING_NOT_FOUND", error: "relay pairing is expired or already used" });
          return;
        }
        try {
          // The reservation makes claim-versus-cancel atomic across browser, host, and CLI processes. A claim that
          // committed first makes begin return missing; once begin wins, no device can be enrolled with a broker
          // credential that this request is about to revoke.
          await relay.provisioner.revokeDevice(deviceId);
        } catch {
          deviceStore.releaseRelayPairingCancellation(cancellation.reservation);
          throw new Error("broker revocation failed");
        }
        deviceStore.finishRelayPairingCancellation(cancellation.reservation);
        reply.header("cache-control", "no-store").code(204).send();
      } catch {
        reply.code(502).send({ code: "RELAY_PAIRING_CANCEL_FAILED", error: "could not cancel relay pairing" });
      }
    },
  );

  app.get("/api/v1/relay/status", async (_request, reply) => {
    const configured = deps.relayEnabled === true;
    const metrics = configured ? deps.relayStatus?.() : undefined;
    return reply.header("cache-control", "no-store").send({
      configured,
      pairingAvailable: configured && deps.relayPairing !== undefined,
      status: configured ? (metrics?.status ?? "connecting") : "not-configured",
      activeDevices: metrics?.activeChannels ?? 0,
      reconnects: metrics?.reconnects ?? 0,
    });
  });

  app.get("/api/v1/cloud/status", async (_request, reply) => {
    return reply.header("cache-control", "no-store").send(cloudStatusResponse(deps.cloudStatus?.()));
  });

  app.post<{ Body: { secret?: unknown; name?: unknown; relayIdentityPublicKey?: unknown } }>(
    "/pairing/claim",
    { bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const secret = request.body?.secret;
      const name = normalizeDeviceName(request.body?.name);
      if (typeof secret !== "string" || !/^rcp_[A-Za-z0-9_-]{43}$/.test(secret) || !name) {
        reply.code(400).send({ error: "a valid pairing credential and device name are required" });
        return;
      }
      let enrollment;
      try {
        enrollment = deviceStore.claimPairing(
          secret,
          name,
          Date.now(),
          typeof request.body?.relayIdentityPublicKey === "string" ? request.body.relayIdentityPublicKey : undefined,
        );
      } catch (error) {
        if (error instanceof DevicePairingError) {
          reply.code(400).send({ code: error.code, error: error.message });
          return;
        }
        reply.code(500).send({ error: "could not enroll this device" });
        return;
      }
      if (!enrollment) {
        reply.code(410).send({ error: "pairing link is invalid, expired, or already used" });
        return;
      }
      reply.header("cache-control", "no-store").code(201).send(enrollment);
    },
  );

  app.post<{ Body: unknown }>(CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE, { bodyLimit: 8 * 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const principal = authenticatedPrincipals.get(request);
    if (!principal || (principal.actorType !== "device" && principal.actorType !== "relay")) {
      reply.code(403).send({
        code: "CLOUD_DEVICE_ENROLLMENT_DEVICE_REQUIRED",
        error: "a paired device credential is required to complete cloud enrollment",
      });
      return;
    }
    const confirmer = deps.cloudDeviceEnrollmentConfirmer;
    if (!confirmer) {
      reply.code(409).send({
        code: "CLOUD_DEVICE_ENROLLMENT_UNAVAILABLE",
        error: "cloud device enrollment is not configured on this host",
      });
      return;
    }
    const parsed = CloudDeviceEnrollmentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({
        code: "INVALID_CLOUD_DEVICE_ENROLLMENT",
        error: "a valid versioned cloud enrollment challenge is required",
      });
      return;
    }

    try {
      const confirmed = await confirmer.confirm({
        v: 1,
        kind: "host-device-enrollment-confirmation",
        enrollmentId: parsed.data.enrollmentId,
        challenge: parsed.data.challenge,
        // This is the only actor identity sent upstream. It came from DeviceStore.authenticate in the
        // global auth hook (or the same relay-scoped lookup), never from client-controlled JSON.
        actorId: principal.actorId,
      });
      if (confirmed.actorId !== principal.actorId) {
        throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
      }
      reply.code(201).send({ enrolled: true, actorId: principal.actorId });
    } catch (error) {
      if (error instanceof CloudDeviceEnrollmentError && error.code === "REJECTED") {
        reply.code(409).send({
          code: "CLOUD_DEVICE_ENROLLMENT_REJECTED",
          error: "cloud enrollment is invalid, expired, or unavailable for this host",
        });
        return;
      }
      if (error instanceof CloudDeviceEnrollmentError && error.retryable) reply.header("retry-after", "2");
      reply.code(502).send({
        code: "CLOUD_DEVICE_ENROLLMENT_FAILED",
        error: "cloud enrollment could not be confirmed; retry with the same challenge",
      });
    }
  });

  app.get("/devices", async (request, reply) => {
    const currentDeviceId = currentDeviceIdForRequest(request);
    reply.header("cache-control", "no-store").send({
      devices: deviceStore.list(),
      ...(currentDeviceId ? { currentDeviceId } : {}),
    });
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/devices/:id", async (request, reply) => {
    const id = request.params.id;
    const name = normalizeDeviceName(request.body?.name);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !name) {
      reply.code(400).send({ code: "INVALID_DEVICE", error: "valid device id and name are required" });
      return;
    }
    const device = deviceStore.rename(id, name);
    if (!device) {
      reply.code(404).send({ code: "DEVICE_NOT_FOUND", error: "device not found" });
      return;
    }
    reply.send({ device });
  });

  app.delete<{ Params: { id: string } }>("/devices/:id", async (request, reply) => {
    const id = request.params.id;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      reply.code(400).send({ error: "invalid device id" });
      return;
    }
    const revoked = deviceStore.revoke(id);
    if (!revoked) {
      reply.code(404).send({ error: "device not found" });
      return;
    }
    // Revocation must stop out-of-band access too: a browser that can no longer open the app must not
    // continue receiving agent names/status in Web Push notifications.
    deps.pushStore?.removeForDevice(id);
    closeRemotePrincipalSockets(id);
    notifyDeviceRevoked(id);
    reply.code(204).send();
  });

  // VERSIONED COMMAND-CENTER API. The existing unversioned terminal routes remain compatible; v1 adds
  // stable host/workspace/agent/attention/event resources for multi-host clients and automation.
  app.get("/api/v1/capabilities", async () => ({
    apiVersion: "v1",
    protocolVersion: 1,
    serverVersion: RUNNING_VERSION,
    serverTime: Date.now(),
    host: commandStore.getHost(),
    features: {
      workspaces: true,
      agents: true,
      attention: true,
      resumableEvents: true,
      sharedLayout: true,
      idempotentMutations: true,
      integrityAudit: true,
      automations: true,
      devicePairing: Boolean(config.accessToken),
      directMultiHost: true,
      inputLeases: true,
      multiObserver: true,
      teamAuthorization: true,
      enterprisePolicy: true,
      fleetInventory: true,
      peerFederation: true,
      presence: true,
      relay: deps.relayEnabled === true,
      plugins: true,
    },
    providers: providers.descriptors().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      version: provider.version,
      schemaVersion: provider.schemaVersion,
      enabled: provider.enabled,
      source: provider.source,
      platforms: provider.platforms,
      resumeIdentity: provider.resumeIdentity,
      capabilities: provider.capabilities,
      stateAuthority: provider.stateAuthority,
      optionSchema: provider.optionSchema,
    })),
  }));

  app.get("/api/v1/policy", async () => ({ policy: policyStore.get() }));

  app.patch<{ Body: EnterprisePolicyUpdate & { expectedRevision?: unknown; confirm?: unknown } }>(
    "/api/v1/policy",
    async (request, reply) => {
      const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
      if (
        principal.actorType !== "host" &&
        principal.actorType !== "local" &&
        teamStore.getTeam()?.authorizationEnabled !== true
      ) {
        reply.code(403).send({
          code: "TEAM_AUTHORIZATION_REQUIRED",
          error: "enable team authorization before delegating organization policy administration",
        });
        return;
      }
      const body = request.body ?? {};
      const { expectedRevision, confirm, ...update } = body;
      const current = policyStore.get();
      if (
        !Number.isSafeInteger(expectedRevision) ||
        (expectedRevision as number) < 1 ||
        (update.enforcementEnabled === true && !current.enforcementEnabled && confirm !== true)
      ) {
        reply.code(400).send({
          code:
            update.enforcementEnabled === true && !current.enforcementEnabled && confirm !== true
              ? "POLICY_ENFORCEMENT_CONFIRM_REQUIRED"
              : "INVALID_ENTERPRISE_POLICY",
          error:
            update.enforcementEnabled === true && !current.enforcementEnabled && confirm !== true
              ? "confirm:true is required before enforcing organization policy"
              : "invalid enterprise policy update",
        });
        return;
      }
      try {
        const policy = policyStore.update(update, expectedRevision as number);
        // A policy transition is authoritative now, not after a socket reconnect or lease expiry. Remote clients
        // reconnect through the normal uniform checks; local/host recovery remains available.
        for (const session of terminalManager.list()) inputLeases.revoke(session.id);
        for (const actorId of [...remotePrincipalSockets.keys()])
          closeRemotePrincipalSockets(actorId, "organization policy changed");
        for (const device of deviceStore.list()) {
          presence.releaseActor({ actorType: "device", actorId: device.id });
          presence.releaseActor({ actorType: "relay", actorId: device.id });
        }
        commandStore.appendEvent("policy.updated", "policy", "enterprise", {
          revision: policy.revision,
          enforcementEnabled: policy.enforcementEnabled,
        });
        return { policy };
      } catch (error) {
        if (error instanceof EnterprisePolicyRevisionConflictError) {
          reply.code(409).send({
            code: "ENTERPRISE_POLICY_REVISION_CONFLICT",
            error: "organization policy changed",
            current: error.current,
          });
          return;
        }
        reply.code(400).send({ code: "INVALID_ENTERPRISE_POLICY", error: "invalid enterprise policy update" });
      }
    },
  );

  app.get("/api/v1/fleet", async () => {
    const host = commandStore.getHost();
    const policy = policyStore.get();
    const violations: string[] = [];
    if (!evaluateEnterprisePolicy(policy, "access", { hostId: host.id }).allowed) violations.push("host-denied");
    if (deps.relayEnabled === true && !evaluateEnterprisePolicy(policy, "relay.access", { hostId: host.id }).allowed) {
      violations.push("relay-denied");
    }
    return {
      revision: Math.max(host.updatedAt, policy.updatedAt),
      hosts: [
        {
          id: host.id,
          label: host.label,
          version: RUNNING_VERSION,
          health: "healthy",
          activeSessions: terminalManager.list().filter((session) => session.status === "running").length,
          relayConfigured: deps.relayEnabled === true,
          dataDurable: [
            store.mode,
            deviceStore.mode,
            commandStore.mode,
            controlStore.mode,
            teamStore.mode,
            policyStore.mode,
            peerStore.mode,
            extensionManager.mode,
          ].every((mode) => mode === "sqlite"),
          policyPosture: {
            enforcementEnabled: policy.enforcementEnabled,
            revision: policy.revision,
            compliant: violations.length === 0,
            violations,
          },
          adapters: providers.descriptors().map((provider) => ({
            id: provider.id,
            version: provider.version,
            enabled: provider.enabled,
            source: provider.source,
            capabilities: provider.capabilities,
          })),
          updatedAt: Date.now(),
        },
      ],
    };
  });

  // Explicitly-scoped peer federation. A peer credential is a revocable device/service credential created on the
  // remote host; it remains server-side here and is never returned by inventory, audit, OpenAPI examples, or proxy
  // responses. Only the stable read/send/wait/start/focus surface is forwarded, with local RBAC + policy followed by
  // the remote host's own RBAC + policy. There is no generic URL proxy and no provider credential delegation.
  const validPeerResourceId = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
  const validPeerCredential = (value: unknown): value is string =>
    typeof value === "string" && value.length >= 16 && value.length <= 4_096 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
  const validPeerClientPart = (value: unknown, max = 256): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
  const peerActionAllowed = (peer: PeerConnection, action: PeerAction): boolean =>
    peer.status === "active" && peer.actions.includes(action);
  const peerConnection = (id: string): PeerConnection | undefined => {
    try {
      return peerStore.connection(id);
    } catch {
      return undefined;
    }
  };
  const requirePeer = (peerId: string, action: PeerAction, reply: FastifyReply): PeerConnection | undefined => {
    const peer = peerConnection(peerId);
    if (!peer) {
      reply.code(404).send({ code: "PEER_NOT_FOUND", error: "peer host not found" });
      return undefined;
    }
    if (!peerActionAllowed(peer, action)) {
      reply.code(403).send({ code: "PEER_SCOPE_DENIED", error: "peer connection does not permit this operation" });
      return undefined;
    }
    return peer;
  };
  const sendPeerFailure = (reply: FastifyReply, error: unknown): void => {
    if (error instanceof PeerRevisionConflictError) {
      reply
        .code(409)
        .send({ code: "PEER_REVISION_CONFLICT", error: "peer connection changed", current: error.current });
      return;
    }
    if (error instanceof PeerRequestError) {
      const remoteStatus = error.status;
      const status =
        remoteStatus === 401
          ? 409
          : remoteStatus !== undefined && [400, 403, 404, 409, 410, 422, 429].includes(remoteStatus)
            ? remoteStatus
            : 502;
      const knownRemoteCodes = new Set([
        "ENTERPRISE_POLICY_DENIED",
        "INPUT_LEASE_HELD",
        "INPUT_LEASE_MISMATCH",
        "INPUT_LEASE_REQUIRED",
        "INPUT_LEASE_REVOKE_CONFIRM_REQUIRED",
        "INPUT_TAKEOVER_FORBIDDEN",
        "INVALID_INPUT_LEASE_REQUEST",
        "INVALID_SESSION_INPUT",
        "SESSION_NOT_FOUND",
        "SESSION_OPERATE_FORBIDDEN",
        "TEAM_PERMISSION_DENIED",
      ]);
      const remoteCode = error.remoteCode && knownRemoteCodes.has(error.remoteCode) ? error.remoteCode : undefined;
      reply.code(status).send({
        code:
          remoteStatus === 401
            ? "PEER_CREDENTIAL_REJECTED"
            : remoteStatus === 403
              ? "PEER_REMOTE_DENIED"
              : remoteStatus === 404
                ? "PEER_RESOURCE_NOT_FOUND"
                : remoteStatus === 409
                  ? "PEER_REMOTE_CONFLICT"
                  : remoteStatus === 410
                    ? "PEER_PAIRING_EXPIRED"
                    : remoteStatus === 400 || remoteStatus === 422
                      ? "PEER_REMOTE_REQUEST_REJECTED"
                      : remoteStatus === 429
                        ? "PEER_RATE_LIMITED"
                        : "PEER_UNAVAILABLE",
        error:
          remoteStatus === 401
            ? "peer host rejected its stored credential"
            : remoteStatus === 403
              ? "peer host denied this operation"
              : remoteStatus === 404
                ? "peer resource not found"
                : remoteStatus === 410
                  ? "peer pairing link is expired or already used"
                  : "peer operation could not be completed",
        ...(remoteStatus ? { remoteStatus } : {}),
        ...(remoteCode ? { remoteCode } : {}),
      });
      return;
    }
    const message = (error as Error).message;
    const conflict = message === "peer already exists";
    reply.code(conflict ? 409 : 400).send({
      code: conflict ? "PEER_EXISTS" : "INVALID_PEER_REQUEST",
      error: conflict ? "peer host is already registered" : "invalid peer request",
    });
  };
  const peerIdempotencyKey = (request: FastifyRequest, peerId: string): string => {
    const actor = actorForRequest(request);
    const provided = request.headers["idempotency-key"];
    const key = typeof provided === "string" ? provided : randomUUID();
    return `peer-${createHash("sha256")
      .update(`${peerId}\0${actor.actorType}\0${actor.actorId}\0${key}`)
      .digest("base64url")}`;
  };
  const workspaceAllowedByPeer = (peer: PeerConnection, workspaceId: unknown): workspaceId is string =>
    typeof workspaceId === "string" &&
    (peer.allowedWorkspaceIds === null || peer.allowedWorkspaceIds.includes(workspaceId));
  const denyPeerTeamOperation = (
    request: FastifyRequest,
    reply: FastifyReply,
    peer: PeerConnection,
    permission: TeamPermission,
    reason: string,
  ): false => {
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    try {
      controlStore.appendAudit({
        actorType: principal.actorType === "relay" ? "device" : principal.actorType,
        actorId: principal.actorId,
        action: "team.peer_authorization.denied",
        targetType: "peer",
        targetId: peer.id,
        result: "denied",
        metadata: { permission, reason },
        createdAt: Date.now(),
      });
    } catch {
      /* peer authorization remains fail-closed */
    }
    reply.code(403).send({
      code: "TEAM_PERMISSION_DENIED",
      error: "your team role does not permit this peer operation",
      permission,
    });
    return false;
  };
  const peerTeamMayResolve = (
    request: FastifyRequest,
    reply: FastifyReply,
    peer: PeerConnection,
    permission: TeamPermission,
  ): boolean => {
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    const direct = authorizer.authorize(principal.actorType, principal.actorId, permission, {
      hostId: peer.remoteHostId,
    });
    if (direct.allowed) return true;
    const member = direct.member ?? teamStore.memberForPrincipal(principal.actorType, principal.actorId);
    const policy = policyStore.get();
    const workspaceRole =
      member?.status === "active" &&
      teamStore.listRoleBindings(member.id).some(
        (binding) =>
          binding.scopeType === "workspace" &&
          binding.scopeId !== undefined &&
          teamRolePermissions(binding.role).includes(permission) &&
          (peer.allowedWorkspaceIds === null || peer.allowedWorkspaceIds.includes(binding.scopeId)) &&
          (!policy.enforcementEnabled ||
            policy.allowedWorkspaceIds === null ||
            policy.allowedWorkspaceIds.includes(binding.scopeId)) &&
          authorizer.authorize(principal.actorType, principal.actorId, permission, {
            hostId: peer.remoteHostId,
            workspaceId: binding.scopeId,
          }).allowed,
      );
    return workspaceRole || denyPeerTeamOperation(request, reply, peer, permission, direct.reason);
  };
  const peerTeamAllows = (
    request: FastifyRequest,
    reply: FastifyReply,
    peer: PeerConnection,
    permission: TeamPermission,
    workspaceId: string,
  ): boolean => {
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    const decision = authorizer.authorize(principal.actorType, principal.actorId, permission, {
      hostId: peer.remoteHostId,
      workspaceId,
    });
    return decision.allowed || denyPeerTeamOperation(request, reply, peer, permission, decision.reason);
  };
  const peerPolicyAllows = (
    request: FastifyRequest,
    reply: FastifyReply,
    peer: PeerConnection,
    action: EnterprisePolicyAction,
    context: Omit<EnterprisePolicyContext, "hostId"> = {},
  ): boolean => {
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    if (principal.actorType === "host" || principal.actorType === "local") return true;
    const decision = evaluateEnterprisePolicy(policyStore.get(), action, { hostId: peer.remoteHostId, ...context });
    if (decision.allowed) return true;
    try {
      controlStore.appendAudit({
        actorType: principal.actorType === "relay" ? "device" : principal.actorType,
        actorId: principal.actorId,
        action: "enterprise.peer_policy.denied",
        targetType: "peer",
        targetId: peer.id,
        result: "denied",
        metadata: { reason: decision.reason, policyAction: action },
        createdAt: Date.now(),
      });
    } catch {
      /* peer policy remains fail-closed */
    }
    reply.code(403).send({
      code: "ENTERPRISE_POLICY_DENIED",
      error: "organization policy does not permit this peer operation",
      reason: decision.reason,
    });
    return false;
  };
  const peerJson = (peer: PeerConnection, path: string, init: Parameters<typeof requestPeerJson>[2] = {}) =>
    requestPeerJson(peer, path, { ...init, fetch: deps.peerFetch });
  const remoteWorkspaceFor = async (peer: PeerConnection, kind: "sessions" | "agents", id: string): Promise<string> => {
    const response = await peerJson(peer, `/api/v1/${kind}/${encodeURIComponent(id)}`);
    const envelope = response.body as Record<string, unknown> | undefined;
    const resource = envelope?.[kind === "sessions" ? "session" : "agent"];
    const workspaceId =
      resource && typeof resource === "object" && !Array.isArray(resource)
        ? (resource as { workspaceId?: unknown }).workspaceId
        : undefined;
    if (typeof workspaceId !== "string") throw new PeerRequestError("peer returned an invalid resource");
    if (!workspaceAllowedByPeer(peer, workspaceId)) {
      throw new PeerRequestError("peer workspace scope denied", 403, "PEER_WORKSPACE_DENIED");
    }
    return workspaceId;
  };
  const peerResourceVisible = (
    request: FastifyRequest,
    peer: PeerConnection,
    permission: TeamPermission,
    workspaceId: unknown,
  ): workspaceId is string => {
    if (!workspaceAllowedByPeer(peer, workspaceId)) return false;
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    if (principal.actorType !== "host" && principal.actorType !== "local") {
      if (!evaluateEnterprisePolicy(policyStore.get(), "access", { hostId: peer.remoteHostId, workspaceId }).allowed) {
        return false;
      }
    }
    return authorizer.authorize(principal.actorType, principal.actorId, permission, {
      hostId: peer.remoteHostId,
      workspaceId,
    }).allowed;
  };
  const filterPeerList = (
    request: FastifyRequest,
    peer: PeerConnection,
    body: unknown,
    key: "sessions" | "agents" | "workspaces",
    permission: TeamPermission,
  ): unknown => {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new PeerRequestError("invalid peer response");
    const list = (body as Record<string, unknown>)[key];
    if (!Array.isArray(list)) throw new PeerRequestError("invalid peer response");
    return {
      ...(body as Record<string, unknown>),
      [key]: list.filter(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          peerResourceVisible(
            request,
            peer,
            permission,
            key === "workspaces" ? (item as { id?: unknown }).id : (item as { workspaceId?: unknown }).workspaceId,
          ),
      ),
    };
  };
  const discoveredPeerWorkspaces = (
    body: unknown,
  ): Array<{ id: string; label: string; kind: "directory" | "worktree"; archived: boolean }> => {
    const list =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { workspaces?: unknown }).workspaces
        : undefined;
    if (!Array.isArray(list) || list.length > 1_000)
      throw new PeerRequestError("peer returned an invalid workspace inventory");
    const seen = new Set<string>();
    return list.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new PeerRequestError("peer returned an invalid workspace inventory");
      }
      const workspace = entry as { id?: unknown; label?: unknown; kind?: unknown; archivedAt?: unknown };
      const label = typeof workspace.label === "string" ? workspace.label.trim().replace(/\s+/g, " ") : "";
      if (
        !validPeerResourceId(workspace.id) ||
        seen.has(workspace.id) ||
        !label ||
        label.length > 80 ||
        /[\p{Cc}\p{Zl}\p{Zp}]/u.test(label) ||
        (workspace.kind !== "directory" && workspace.kind !== "worktree") ||
        (workspace.archivedAt !== undefined &&
          (!Number.isSafeInteger(workspace.archivedAt) || (workspace.archivedAt as number) < 0))
      ) {
        throw new PeerRequestError("peer returned an invalid workspace inventory");
      }
      seen.add(workspace.id);
      return {
        id: workspace.id,
        label,
        kind: workspace.kind,
        archived: workspace.archivedAt !== undefined,
      };
    });
  };
  const peerClientId = (request: FastifyRequest, peerId: string, clientId: string): string => {
    const actor = actorForRequest(request);
    return `peer:${createHash("sha256")
      .update(`${peerId}\0${actor.actorType}\0${actor.actorId}\0${clientId}`)
      .digest("base64url")}`;
  };

  app.get("/api/v1/peers", async () => ({ peers: peerStore.list() }));

  app.post<{
    Body: {
      label?: unknown;
      baseUrl?: unknown;
      credential?: unknown;
      pairingUrl?: unknown;
      actions?: unknown;
      allowedWorkspaceIds?: unknown;
      confirm?: unknown;
    };
  }>("/api/v1/peers", async (request, reply) => {
    if (request.body?.confirm !== true) {
      reply.code(400).send({
        code: "PEER_CONFIRM_REQUIRED",
        error: "confirm:true is required before storing cross-host access",
      });
      return;
    }
    const allowedKeys = new Set([
      "label",
      "baseUrl",
      "credential",
      "pairingUrl",
      "actions",
      "allowedWorkspaceIds",
      "confirm",
    ]);
    if (Object.keys(request.body ?? {}).some((key) => !allowedKeys.has(key))) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer request" });
      return;
    }
    const usePairing = typeof request.body.pairingUrl === "string";
    if (
      (usePairing && (request.body.baseUrl !== undefined || request.body.credential !== undefined)) ||
      (!usePairing && (!validPeerCredential(request.body.credential) || request.body.baseUrl === undefined))
    ) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer request" });
      return;
    }
    let claimed: ClaimedPeerCredential | undefined;
    let stored = false;
    try {
      let baseUrl: string;
      let credential: string;
      if (usePairing) {
        const hostLabel = commandStore.getHost().label;
        claimed = await claimPeerPairing({
          pairingUrl: request.body.pairingUrl as string,
          deviceName: `RoamCode peer · ${hostLabel}`.slice(0, 80),
          fetch: deps.peerFetch,
        });
        baseUrl = claimed.baseUrl;
        credential = claimed.credential;
      } else {
        baseUrl = normalizePeerBaseUrl(request.body.baseUrl);
        credential = request.body.credential as string;
      }
      const verified = await verifyPeerConnection({
        baseUrl,
        credential,
        localHostId: commandStore.getHost().id,
        fetch: deps.peerFetch,
      });
      const peer = peerStore.create({
        label: typeof request.body.label === "string" ? request.body.label : verified.remoteLabel,
        baseUrl,
        credential,
        remoteHostId: verified.remoteHostId,
        remoteVersion: verified.remoteVersion,
        ...(request.body.actions === undefined ? {} : { actions: request.body.actions as PeerAction[] }),
        ...(request.body.allowedWorkspaceIds === undefined
          ? {}
          : { allowedWorkspaceIds: request.body.allowedWorkspaceIds as string[] | null }),
      });
      stored = true;
      commandStore.appendEvent("peer.created", "peer", peer.id, { remoteHostId: peer.remoteHostId });
      reply.code(201).send({ peer });
    } catch (error) {
      if (claimed && !stored) await revokeClaimedPeerDevice({ ...claimed, fetch: deps.peerFetch });
      sendPeerFailure(reply, error);
    }
  });

  app.patch<{
    Params: { id: string };
    Body: Pick<UpdatePeerInput, "label" | "actions" | "allowedWorkspaceIds" | "status"> & {
      expectedRevision?: unknown;
    };
  }>("/api/v1/peers/:id", async (request, reply) => {
    const expectedRevision = request.body?.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer request" });
      return;
    }
    const allowedKeys = new Set(["label", "actions", "allowedWorkspaceIds", "status", "expectedRevision"]);
    if (Object.keys(request.body ?? {}).some((key) => !allowedKeys.has(key))) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer request" });
      return;
    }
    const { label, actions, allowedWorkspaceIds, status } = request.body;
    const input: UpdatePeerInput = {
      ...(label === undefined ? {} : { label }),
      ...(actions === undefined ? {} : { actions }),
      ...(allowedWorkspaceIds === undefined ? {} : { allowedWorkspaceIds }),
      ...(status === undefined ? {} : { status }),
    };
    try {
      const peer = peerStore.update(request.params.id, input, expectedRevision as number);
      if (!peer) {
        reply.code(404).send({ code: "PEER_NOT_FOUND", error: "peer host not found" });
        return;
      }
      commandStore.appendEvent("peer.updated", "peer", peer.id, { revision: peer.revision, status: peer.status });
      reply.send({ peer });
    } catch (error) {
      sendPeerFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { expectedRevision?: unknown } }>(
    "/api/v1/peers/:id/verify",
    async (request, reply) => {
      const peer = peerConnection(request.params.id);
      if (!peer) {
        reply.code(404).send({ code: "PEER_NOT_FOUND", error: "peer host not found" });
        return;
      }
      const expectedRevision = request.body?.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
        reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "a valid peer revision is required" });
        return;
      }
      if (expectedRevision !== peer.revision) {
        reply.code(409).send({
          code: "PEER_REVISION_CONFLICT",
          error: "peer connection changed",
          current: peerStore.get(peer.id),
        });
        return;
      }
      try {
        const verified = await verifyPeerConnection({
          baseUrl: peer.baseUrl,
          credential: peer.credential,
          localHostId: commandStore.getHost().id,
          fetch: deps.peerFetch,
        });
        if (verified.remoteHostId !== peer.remoteHostId) {
          reply.code(409).send({ code: "PEER_IDENTITY_CHANGED", error: "peer host identity changed" });
          return;
        }
        const updated = peerStore.update(
          peer.id,
          { remoteVersion: verified.remoteVersion, lastVerifiedAt: Date.now() },
          peer.revision,
        );
        if (!updated) {
          reply.code(404).send({ code: "PEER_NOT_FOUND", error: "peer host not found" });
          return;
        }
        reply.send({ peer: updated });
      } catch (error) {
        sendPeerFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { expectedRevision?: unknown } }>(
    "/api/v1/peers/:id/discover",
    async (request, reply) => {
      const peer = peerConnection(request.params.id);
      if (!peer) {
        reply.code(404).send({ code: "PEER_NOT_FOUND", error: "peer host not found" });
        return;
      }
      const expectedRevision = request.body?.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
        reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "a valid peer revision is required" });
        return;
      }
      if (expectedRevision !== peer.revision) {
        reply.code(409).send({
          code: "PEER_REVISION_CONFLICT",
          error: "peer connection changed",
          current: peerStore.get(peer.id),
        });
        return;
      }
      try {
        const verified = await verifyPeerConnection({
          baseUrl: peer.baseUrl,
          credential: peer.credential,
          localHostId: commandStore.getHost().id,
          fetch: deps.peerFetch,
        });
        if (verified.remoteHostId !== peer.remoteHostId) {
          reply.code(409).send({ code: "PEER_IDENTITY_CHANGED", error: "peer host identity changed" });
          return;
        }
        const workspaceResponse = await peerJson(peer, "/api/v1/workspaces?includeArchived=1");
        const workspaces = discoveredPeerWorkspaces(workspaceResponse.body);
        const updated = peerStore.update(
          peer.id,
          { remoteVersion: verified.remoteVersion, lastVerifiedAt: Date.now() },
          peer.revision,
        );
        if (!updated) {
          reply.code(404).send({ code: "PEER_NOT_FOUND", error: "peer host not found" });
          return;
        }
        reply.send({ peer: updated, workspaces });
      } catch (error) {
        sendPeerFailure(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { credential?: unknown; pairingUrl?: unknown; expectedRevision?: unknown; confirm?: unknown };
  }>("/api/v1/peers/:id/credential", async (request, reply) => {
    const peer = peerConnection(request.params.id);
    if (!peer) {
      reply.code(404).send({ code: "PEER_NOT_FOUND", error: "peer host not found" });
      return;
    }
    const usePairing = typeof request.body?.pairingUrl === "string";
    if (
      request.body?.confirm !== true ||
      (usePairing && request.body.credential !== undefined) ||
      (!usePairing && !validPeerCredential(request.body?.credential)) ||
      Object.keys(request.body ?? {}).some(
        (key) => !new Set(["credential", "pairingUrl", "expectedRevision", "confirm"]).has(key),
      )
    ) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "confirmed credential rotation is required" });
      return;
    }
    if (!Number.isSafeInteger(request.body.expectedRevision) || (request.body.expectedRevision as number) < 1) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "a valid peer revision is required" });
      return;
    }
    if (request.body.expectedRevision !== peer.revision) {
      reply.code(409).send({
        code: "PEER_REVISION_CONFLICT",
        error: "peer connection changed",
        current: peerStore.get(peer.id),
      });
      return;
    }
    let claimed: ClaimedPeerCredential | undefined;
    let stored = false;
    const cleanupClaim = async () => {
      if (!claimed || stored) return;
      await revokeClaimedPeerDevice({ ...claimed, fetch: deps.peerFetch });
      claimed = undefined;
    };
    try {
      let credential: string;
      if (usePairing) {
        const hostLabel = commandStore.getHost().label;
        claimed = await claimPeerPairing({
          pairingUrl: request.body.pairingUrl as string,
          deviceName: `RoamCode peer · ${hostLabel}`.slice(0, 80),
          fetch: deps.peerFetch,
        });
        if (claimed.baseUrl !== peer.baseUrl) {
          await cleanupClaim();
          reply.code(409).send({ code: "PEER_ORIGIN_CHANGED", error: "peer pairing origin changed" });
          return;
        }
        credential = claimed.credential;
      } else {
        credential = request.body.credential as string;
      }
      const verified = await verifyPeerConnection({
        baseUrl: peer.baseUrl,
        credential,
        localHostId: commandStore.getHost().id,
        fetch: deps.peerFetch,
      });
      if (verified.remoteHostId !== peer.remoteHostId) {
        await cleanupClaim();
        reply.code(409).send({ code: "PEER_IDENTITY_CHANGED", error: "peer host identity changed" });
        return;
      }
      const updated = peerStore.rotateCredential(
        peer.id,
        { credential, remoteVersion: verified.remoteVersion },
        peer.revision,
      );
      if (!updated) {
        await cleanupClaim();
        reply.code(404).send({ code: "PEER_NOT_FOUND", error: "peer host not found" });
        return;
      }
      stored = true;
      reply.send({ peer: updated });
    } catch (error) {
      await cleanupClaim();
      sendPeerFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string }; Body: { confirm?: unknown } }>("/api/v1/peers/:id", async (request, reply) => {
    if (request.body?.confirm !== true) {
      reply.code(400).send({ code: "PEER_CONFIRM_REQUIRED", error: "confirm:true is required to remove a peer" });
      return;
    }
    let removed = false;
    try {
      removed = peerStore.remove(request.params.id);
    } catch {
      /* Invalid and unknown ids have the same result. */
    }
    if (!removed) {
      reply.code(404).send({ code: "PEER_NOT_FOUND", error: "peer host not found" });
      return;
    }
    commandStore.appendEvent("peer.removed", "peer", request.params.id, {});
    reply.code(204).send();
  });

  app.get<{ Params: { peerId: string } }>("/api/v1/peers/:peerId/workspaces", async (request, reply) => {
    const peer = requirePeer(request.params.peerId, "read", reply);
    if (
      !peer ||
      !peerTeamMayResolve(request, reply, peer, "sessions:read") ||
      !peerPolicyAllows(request, reply, peer, "access")
    ) {
      return;
    }
    try {
      const response = await peerJson(peer, "/api/v1/workspaces");
      reply.code(response.status).send(filterPeerList(request, peer, response.body, "workspaces", "sessions:read"));
    } catch (error) {
      sendPeerFailure(reply, error);
    }
  });

  app.get<{ Params: { peerId: string } }>("/api/v1/peers/:peerId/agents", async (request, reply) => {
    const peer = requirePeer(request.params.peerId, "read", reply);
    if (
      !peer ||
      !peerTeamMayResolve(request, reply, peer, "sessions:read") ||
      !peerPolicyAllows(request, reply, peer, "access")
    ) {
      return;
    }
    try {
      const response = await peerJson(peer, "/api/v1/agents");
      reply.code(response.status).send(filterPeerList(request, peer, response.body, "agents", "sessions:read"));
    } catch (error) {
      sendPeerFailure(reply, error);
    }
  });

  app.get<{ Params: { peerId: string } }>("/api/v1/peers/:peerId/sessions", async (request, reply) => {
    const peer = requirePeer(request.params.peerId, "read", reply);
    if (
      !peer ||
      !peerTeamMayResolve(request, reply, peer, "sessions:read") ||
      !peerPolicyAllows(request, reply, peer, "access")
    ) {
      return;
    }
    try {
      const response = await peerJson(peer, "/api/v1/sessions");
      reply.code(response.status).send(filterPeerList(request, peer, response.body, "sessions", "sessions:read"));
    } catch (error) {
      sendPeerFailure(reply, error);
    }
  });

  app.post<{
    Params: { peerId: string };
    Body: Omit<CreateSessionBody, "cwd"> & { workspaceId?: unknown };
  }>("/api/v1/peers/:peerId/sessions", async (request, reply) => {
    const peer = requirePeer(request.params.peerId, "start", reply);
    if (!peer) return;
    const body = request.body ?? ({} as Omit<CreateSessionBody, "cwd"> & { workspaceId?: unknown });
    if (!validPeerResourceId(body.workspaceId) || typeof body.provider !== "string") {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "peer session requires workspaceId and provider" });
      return;
    }
    if (
      !peerTeamMayResolve(request, reply, peer, "sessions:operate") ||
      !peerPolicyAllows(request, reply, peer, "access")
    ) {
      return;
    }
    try {
      const workspaces = await peerJson(peer, "/api/v1/workspaces");
      const list = (workspaces.body as { workspaces?: unknown } | undefined)?.workspaces;
      const match = Array.isArray(list)
        ? list.find(
            (workspace) =>
              workspace &&
              typeof workspace === "object" &&
              !Array.isArray(workspace) &&
              (workspace as { id?: unknown }).id === body.workspaceId,
          )
        : undefined;
      const remoteCwd =
        match && typeof match === "object" && typeof (match as { cwd?: unknown }).cwd === "string"
          ? (match as { cwd: string }).cwd
          : undefined;
      if (!remoteCwd) {
        reply.code(404).send({ code: "PEER_WORKSPACE_NOT_FOUND", error: "peer workspace not found" });
        return;
      }
      if (!workspaceAllowedByPeer(peer, body.workspaceId)) {
        reply.code(403).send({ code: "PEER_WORKSPACE_DENIED", error: "peer workspace scope does not permit launch" });
        return;
      }
      if (!peerTeamAllows(request, reply, peer, "sessions:operate", body.workspaceId)) return;
      const rawOptions =
        body.options && typeof body.options === "object"
          ? body.options
          : {
              ...(typeof body.dangerouslySkip === "boolean" ? { dangerouslySkip: body.dangerouslySkip } : {}),
              ...(typeof body.permissionMode === "string" ? { permissionMode: body.permissionMode } : {}),
            };
      if (
        !peerPolicyAllows(request, reply, peer, "session.launch", {
          workspaceId: body.workspaceId,
          providerId: body.provider,
          dangerousProviderMode: usesDangerousProviderMode(rawOptions as ProviderSessionOptions),
        })
      ) {
        return;
      }
      const remoteBody: CreateSessionBody = {
        cwd: remoteCwd,
        provider: body.provider,
        ...(body.options === undefined ? {} : { options: body.options }),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.effort === undefined ? {} : { effort: body.effort }),
        ...(body.addDirs === undefined ? {} : { addDirs: body.addDirs }),
        ...(body.dangerouslySkip === undefined ? {} : { dangerouslySkip: body.dangerouslySkip }),
        ...(body.permissionMode === undefined ? {} : { permissionMode: body.permissionMode }),
        ...(body.mode === undefined ? {} : { mode: body.mode }),
      };
      const response = await peerJson(peer, "/api/v1/sessions", {
        method: "POST",
        body: remoteBody,
        idempotencyKey: peerIdempotencyKey(request, peer.id),
      });
      reply.code(response.status).send(response.body);
    } catch (error) {
      sendPeerFailure(reply, error);
    }
  });

  app.get<{ Params: { peerId: string; sessionId: string } }>(
    "/api/v1/peers/:peerId/sessions/:sessionId/input-lease",
    async (request, reply) => {
      const peer = requirePeer(request.params.peerId, "read", reply);
      if (!peer) return;
      if (!validPeerResourceId(request.params.sessionId)) {
        reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer session id" });
        return;
      }
      if (
        !peerTeamMayResolve(request, reply, peer, "sessions:read") ||
        !peerPolicyAllows(request, reply, peer, "access")
      ) {
        return;
      }
      try {
        const workspaceId = await remoteWorkspaceFor(peer, "sessions", request.params.sessionId);
        if (
          !peerTeamAllows(request, reply, peer, "sessions:read", workspaceId) ||
          !peerPolicyAllows(request, reply, peer, "access", { workspaceId })
        ) {
          return;
        }
        const response = await peerJson(
          peer,
          `/api/v1/sessions/${encodeURIComponent(request.params.sessionId)}/input-lease`,
        );
        reply.code(response.status).send(response.body);
      } catch (error) {
        sendPeerFailure(reply, error);
      }
    },
  );

  app.post<{
    Params: { peerId: string; sessionId: string };
    Body: { action?: unknown; clientId?: unknown; leaseId?: unknown; confirm?: unknown };
  }>("/api/v1/peers/:peerId/sessions/:sessionId/input-lease", async (request, reply) => {
    const peer = requirePeer(request.params.peerId, "send", reply);
    if (!peer) return;
    if (!validPeerResourceId(request.params.sessionId)) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer session id" });
      return;
    }
    const { action, clientId, leaseId, confirm } = request.body ?? {};
    if (
      !["acquire", "takeover", "renew", "release", "revoke"].includes(typeof action === "string" ? action : "") ||
      (action !== "revoke" && !validPeerClientPart(clientId, 128)) ||
      ((action === "renew" || action === "release") && !validPeerClientPart(leaseId)) ||
      (confirm !== undefined && typeof confirm !== "boolean")
    ) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer input lease request" });
      return;
    }
    const permission: TeamPermission = action === "revoke" ? "policy:manage" : "sessions:operate";
    if (!peerTeamMayResolve(request, reply, peer, permission) || !peerPolicyAllows(request, reply, peer, "access")) {
      return;
    }
    try {
      const workspaceId = await remoteWorkspaceFor(peer, "sessions", request.params.sessionId);
      if (
        !peerTeamAllows(request, reply, peer, permission, workspaceId) ||
        !peerPolicyAllows(request, reply, peer, "access", { workspaceId })
      ) {
        return;
      }
      const response = await peerJson(
        peer,
        `/api/v1/sessions/${encodeURIComponent(request.params.sessionId)}/input-lease`,
        {
          method: "POST",
          body: {
            action,
            ...(action === "revoke" ? {} : { clientId: peerClientId(request, peer.id, clientId as string) }),
            ...(typeof leaseId === "string" ? { leaseId } : {}),
            ...(typeof confirm === "boolean" ? { confirm } : {}),
          },
          idempotencyKey: peerIdempotencyKey(request, peer.id),
        },
      );
      reply.code(response.status).send(response.body);
    } catch (error) {
      sendPeerFailure(reply, error);
    }
  });

  app.post<{
    Params: { peerId: string; sessionId: string };
    Body: { data?: unknown; appendNewline?: unknown; clientId?: unknown; leaseId?: unknown };
  }>("/api/v1/peers/:peerId/sessions/:sessionId/input", async (request, reply) => {
    const peer = requirePeer(request.params.peerId, "send", reply);
    if (!peer) return;
    if (!validPeerResourceId(request.params.sessionId)) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer session id" });
      return;
    }
    const { data, appendNewline, clientId, leaseId } = request.body ?? {};
    if (
      typeof data !== "string" ||
      Buffer.byteLength(data, "utf8") > MAX_PEER_INPUT_BYTES ||
      (appendNewline !== undefined && typeof appendNewline !== "boolean") ||
      ((clientId !== undefined || leaseId !== undefined) &&
        (!validPeerClientPart(clientId, 128) || !validPeerClientPart(leaseId)))
    ) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer input" });
      return;
    }
    if (
      !peerTeamMayResolve(request, reply, peer, "sessions:operate") ||
      !peerPolicyAllows(request, reply, peer, "access")
    ) {
      return;
    }
    try {
      const workspaceId = await remoteWorkspaceFor(peer, "sessions", request.params.sessionId);
      if (
        !peerTeamAllows(request, reply, peer, "sessions:operate", workspaceId) ||
        !peerPolicyAllows(request, reply, peer, "access", { workspaceId })
      ) {
        return;
      }
      const response = await peerJson(peer, `/api/v1/sessions/${encodeURIComponent(request.params.sessionId)}/input`, {
        method: "POST",
        body: {
          data,
          ...(typeof appendNewline === "boolean" ? { appendNewline } : {}),
          ...(typeof clientId === "string" && typeof leaseId === "string"
            ? { clientId: peerClientId(request, peer.id, clientId), leaseId }
            : {}),
        },
        idempotencyKey: peerIdempotencyKey(request, peer.id),
      });
      reply.code(response.status).send(response.body);
    } catch (error) {
      sendPeerFailure(reply, error);
    }
  });

  app.get<{
    Params: { peerId: string; agentId: string };
    Querystring: { after?: string; timeoutMs?: string };
  }>("/api/v1/peers/:peerId/agents/:agentId/wait", async (request, reply) => {
    const peer = requirePeer(request.params.peerId, "wait", reply);
    if (!peer) return;
    if (!validPeerResourceId(request.params.agentId)) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer agent id" });
      return;
    }
    const after = request.query.after === undefined ? 0 : Number(request.query.after);
    const timeoutMs = request.query.timeoutMs === undefined ? 30_000 : Number(request.query.timeoutMs);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 30_000
    ) {
      reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer wait cursor" });
      return;
    }
    if (
      !peerTeamMayResolve(request, reply, peer, "sessions:read") ||
      !peerPolicyAllows(request, reply, peer, "access")
    ) {
      return;
    }
    try {
      const workspaceId = await remoteWorkspaceFor(peer, "agents", request.params.agentId);
      if (
        !peerTeamAllows(request, reply, peer, "sessions:read", workspaceId) ||
        !peerPolicyAllows(request, reply, peer, "access", { workspaceId })
      ) {
        return;
      }
      const response = await peerJson(
        peer,
        `/api/v1/agents/${encodeURIComponent(request.params.agentId)}/wait?after=${after}&timeoutMs=${timeoutMs}`,
        { timeoutMs: timeoutMs + 5_000 },
      );
      reply.code(response.status).send(response.body);
    } catch (error) {
      sendPeerFailure(reply, error);
    }
  });

  app.post<{ Params: { peerId: string; agentId: string }; Body: { mode?: unknown } }>(
    "/api/v1/peers/:peerId/agents/:agentId/focus",
    async (request, reply) => {
      const peer = requirePeer(request.params.peerId, "focus", reply);
      if (!peer) return;
      if (!validPeerResourceId(request.params.agentId)) {
        reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer agent id" });
        return;
      }
      const mode = request.body?.mode ?? "request";
      if (mode !== "request" && mode !== "activate") {
        reply.code(400).send({ code: "INVALID_PEER_REQUEST", error: "invalid peer focus mode" });
        return;
      }
      if (
        !peerTeamMayResolve(request, reply, peer, "sessions:operate") ||
        !peerPolicyAllows(request, reply, peer, "access")
      ) {
        return;
      }
      try {
        const workspaceId = await remoteWorkspaceFor(peer, "agents", request.params.agentId);
        if (
          !peerTeamAllows(request, reply, peer, "sessions:operate", workspaceId) ||
          !peerPolicyAllows(request, reply, peer, "access", { workspaceId })
        ) {
          return;
        }
        const response = await peerJson(peer, `/api/v1/agents/${encodeURIComponent(request.params.agentId)}/focus`, {
          method: "POST",
          body: { mode },
          idempotencyKey: peerIdempotencyKey(request, peer.id),
        });
        reply.code(response.status).send(response.body);
      } catch (error) {
        sendPeerFailure(reply, error);
      }
    },
  );

  app.get("/api/v1/hosts", async () => ({ hosts: [commandStore.getHost()] }));

  const currentTeamMember = (request: FastifyRequest) => {
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    return teamStore.memberForPrincipal(principal.actorType, principal.actorId);
  };
  const teamMemberEnvelope = (request: FastifyRequest) => {
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    const team = teamStore.getTeam();
    const member = teamStore.memberForPrincipal(principal.actorType, principal.actorId);
    const roles = member ? teamStore.listRoleBindings(member.id) : [];
    return {
      team,
      currentMember: member ?? null,
      roles,
      permissions: [...new Set(roles.flatMap((binding) => teamRolePermissions(binding.role)))].sort(),
      authorization: {
        enabled: team?.authorizationEnabled ?? false,
        localBreakGlass: principal.actorType === "host" || principal.actorType === "local",
      },
    };
  };
  const validTeamApiId = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
  const sendTeamError = (reply: FastifyReply, error: unknown): void => {
    if (error instanceof TeamRevisionConflictError) {
      reply.code(409).send({ code: "TEAM_REVISION_CONFLICT", error: "team state changed", current: error.current });
      return;
    }
    const message = (error as Error).message;
    const notFound = message === "team not found" || message === "member not found";
    reply.code(notFound ? 404 : message === "team already exists" ? 409 : 400).send({
      code: notFound
        ? "TEAM_RESOURCE_NOT_FOUND"
        : message === "team already exists"
          ? "TEAM_EXISTS"
          : "INVALID_TEAM_REQUEST",
      error: notFound ? message : "invalid team request",
    });
  };

  app.get("/api/v1/team", async (request) => teamMemberEnvelope(request));

  app.post<{ Body: { name?: unknown; ownerName?: unknown } }>("/api/v1/team", async (request, reply) => {
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    if (
      typeof request.body?.name !== "string" ||
      (request.body.ownerName !== undefined && typeof request.body.ownerName !== "string")
    ) {
      reply.code(400).send({ code: "INVALID_TEAM_REQUEST", error: "team name is required" });
      return;
    }
    try {
      const created = teamStore.createTeam({
        name: request.body.name,
        ownerName: typeof request.body.ownerName === "string" ? request.body.ownerName : principal.label,
        ownerPrincipal: { actorType: principal.actorType, actorId: principal.actorId },
      });
      commandStore.appendEvent("team.created", "team", created.team.id, {});
      reply.code(201).send({ ...created, ...teamMemberEnvelope(request) });
    } catch (error) {
      sendTeamError(reply, error);
    }
  });

  app.patch<{
    Body: { name?: unknown; authorizationEnabled?: unknown; expectedRevision?: unknown; confirm?: unknown };
  }>("/api/v1/team", async (request, reply) => {
    const { name, authorizationEnabled, expectedRevision, confirm } = request.body ?? {};
    if (
      (name !== undefined && typeof name !== "string") ||
      (authorizationEnabled !== undefined && typeof authorizationEnabled !== "boolean") ||
      !Number.isSafeInteger(expectedRevision) ||
      (expectedRevision as number) < 1 ||
      (authorizationEnabled === true && confirm !== true)
    ) {
      reply.code(400).send({
        code:
          authorizationEnabled === true && confirm !== true
            ? "TEAM_ENFORCEMENT_CONFIRM_REQUIRED"
            : "INVALID_TEAM_REQUEST",
        error:
          authorizationEnabled === true && confirm !== true
            ? "confirm:true is required before enforcing roles"
            : "invalid team update",
      });
      return;
    }
    try {
      const team = teamStore.updateTeam(
        {
          ...(typeof name === "string" ? { name } : {}),
          ...(typeof authorizationEnabled === "boolean" ? { authorizationEnabled } : {}),
        },
        expectedRevision as number,
      );
      commandStore.appendEvent("team.updated", "team", team.id, { authorizationEnabled: team.authorizationEnabled });
      return { team };
    } catch (error) {
      sendTeamError(reply, error);
    }
  });

  app.get<{ Querystring: { includeRemoved?: string } }>("/api/v1/team/members", async (request) => ({
    members: teamStore.listMembers({ includeRemoved: request.query.includeRemoved === "1" }).map((member) => ({
      ...member,
      roles: teamStore.listRoleBindings(member.id),
    })),
  }));

  app.post<{
    Body: { displayName?: unknown; kind?: unknown; role?: unknown; scopeType?: unknown; scopeId?: unknown };
  }>("/api/v1/team/members", async (request, reply) => {
    const { displayName, kind, role, scopeType, scopeId } = request.body ?? {};
    if (
      typeof displayName !== "string" ||
      (kind !== undefined && kind !== "person" && kind !== "service") ||
      (role !== undefined && !isTeamRole(role)) ||
      (scopeType !== undefined && !isTeamScopeType(scopeType))
    ) {
      reply.code(400).send({ code: "INVALID_TEAM_MEMBER", error: "valid member identity and role are required" });
      return;
    }
    try {
      const member = teamStore.createMember({ displayName, ...(kind ? { kind } : {}) });
      const binding = isTeamRole(role)
        ? teamStore.grantRole({
            memberId: member.id,
            role,
            ...(isTeamScopeType(scopeType) ? { scopeType } : {}),
            ...(typeof scopeId === "string" ? { scopeId } : {}),
          })
        : undefined;
      commandStore.appendEvent("team.member_created", "member", member.id, {});
      reply.code(201).send({ member, roles: binding ? [binding] : [] });
    } catch (error) {
      sendTeamError(reply, error);
    }
  });

  app.patch<{
    Params: { id: string };
    Body: { displayName?: unknown; status?: unknown; expectedRevision?: unknown };
  }>("/api/v1/team/members/:id", async (request, reply) => {
    const { displayName, status, expectedRevision } = request.body ?? {};
    if (
      !validTeamApiId(request.params.id) ||
      (displayName !== undefined && typeof displayName !== "string") ||
      (status !== undefined && !["active", "suspended", "removed"].includes(String(status))) ||
      !Number.isSafeInteger(expectedRevision) ||
      (expectedRevision as number) < 1
    ) {
      reply.code(400).send({ code: "INVALID_TEAM_MEMBER", error: "invalid member update" });
      return;
    }
    try {
      const member = teamStore.updateMember(
        request.params.id,
        {
          ...(typeof displayName === "string" ? { displayName } : {}),
          ...(status === "active" || status === "suspended" || status === "removed" ? { status } : {}),
        },
        expectedRevision as number,
      );
      if (!member) {
        reply.code(404).send({ code: "TEAM_MEMBER_NOT_FOUND", error: "team member not found" });
        return;
      }
      if (member.status !== "active") {
        for (const binding of teamStore.listPrincipalBindings(member.id)) {
          inputLeases.revokeActor(binding.actorType, binding.actorId);
          presence.releaseActor(binding);
          if (binding.actorType === "device" || binding.actorType === "relay") {
            closeRemotePrincipalSockets(binding.actorId);
          }
        }
      }
      commandStore.appendEvent("team.member_updated", "member", member.id, { status: member.status });
      return { member };
    } catch (error) {
      sendTeamError(reply, error);
    }
  });

  app.post<{
    Body: { memberId?: unknown; role?: unknown; scopeType?: unknown; scopeId?: unknown };
  }>("/api/v1/team/roles", async (request, reply) => {
    const { memberId, role, scopeType, scopeId } = request.body ?? {};
    if (!validTeamApiId(memberId) || !isTeamRole(role) || (scopeType !== undefined && !isTeamScopeType(scopeType))) {
      reply.code(400).send({ code: "INVALID_TEAM_ROLE", error: "valid member, role, and scope are required" });
      return;
    }
    try {
      const binding = teamStore.grantRole({
        memberId,
        role,
        ...(isTeamScopeType(scopeType) ? { scopeType } : {}),
        ...(typeof scopeId === "string" ? { scopeId } : {}),
      });
      commandStore.appendEvent("team.role_granted", "member", memberId, { role, scopeType: binding.scopeType });
      reply.code(201).send({ binding });
    } catch (error) {
      sendTeamError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/team/roles/:id", async (request, reply) => {
    if (!validTeamApiId(request.params.id)) {
      reply.code(400).send({ code: "INVALID_TEAM_ROLE", error: "invalid role binding" });
      return;
    }
    const existing = teamStore.listRoleBindings().find((binding) => binding.id === request.params.id);
    if (!existing || !teamStore.revokeRole(request.params.id)) {
      reply.code(404).send({ code: "TEAM_ROLE_NOT_FOUND", error: "role binding not found" });
      return;
    }
    // A role change is authoritative immediately, not after the next heartbeat. Drop mutable ownership and let
    // every still-authorized client explicitly reacquire under the new policy.
    for (const principal of teamStore.listPrincipalBindings(existing.memberId)) {
      inputLeases.revokeActor(principal.actorType, principal.actorId);
      presence.releaseActor(principal);
    }
    commandStore.appendEvent("team.role_revoked", "role", request.params.id, {});
    reply.code(204).send();
  });

  app.get("/api/v1/team/principals", async () => ({ bindings: teamStore.listPrincipalBindings() }));

  app.post<{
    Body: { memberId?: unknown; actorType?: unknown; actorId?: unknown };
  }>("/api/v1/team/principals", async (request, reply) => {
    const { memberId, actorType, actorId } = request.body ?? {};
    if (
      !validTeamApiId(memberId) ||
      !["device", "host", "local", "relay"].includes(String(actorType)) ||
      !validTeamApiId(actorId)
    ) {
      reply.code(400).send({ code: "INVALID_TEAM_PRINCIPAL", error: "valid principal binding is required" });
      return;
    }
    if (actorType === "device" && !deviceStore.list().some((device) => device.id === actorId)) {
      reply.code(404).send({ code: "DEVICE_NOT_FOUND", error: "paired device not found" });
      return;
    }
    try {
      const binding = teamStore.bindPrincipal({
        memberId,
        actorType: actorType as TeamPrincipalType,
        actorId,
      });
      commandStore.appendEvent("team.principal_bound", "member", memberId, { actorType });
      reply.code(201).send({ binding });
    } catch (error) {
      sendTeamError(reply, error);
    }
  });

  app.delete<{
    Body: { actorType?: unknown; actorId?: unknown };
  }>("/api/v1/team/principals", async (request, reply) => {
    const { actorType, actorId } = request.body ?? {};
    if (!["device", "host", "local", "relay"].includes(String(actorType)) || !validTeamApiId(actorId)) {
      reply.code(400).send({ code: "INVALID_TEAM_PRINCIPAL", error: "valid principal binding is required" });
      return;
    }
    if (!teamStore.unbindPrincipal(actorType as TeamPrincipalType, actorId)) {
      reply.code(404).send({ code: "TEAM_PRINCIPAL_NOT_FOUND", error: "principal binding not found" });
      return;
    }
    inputLeases.revokeActor(actorType as TeamPrincipalType, actorId);
    presence.releaseActor({ actorType: actorType as TeamPrincipalType, actorId });
    if (actorType === "device" || actorType === "relay") closeRemotePrincipalSockets(actorId);
    commandStore.appendEvent("team.principal_unbound", "principal", actorId, { actorType });
    reply.code(204).send();
  });

  app.get<{
    Querystring: { hostId?: string; workspaceId?: string; sessionId?: string; agentId?: string };
  }>("/api/v1/presence", async (request, reply) => {
    const filters = request.query;
    if (Object.values(filters).some((value) => value !== undefined && !validTeamApiId(value))) {
      reply.code(400).send({ code: "INVALID_PRESENCE_FILTER", error: "invalid presence filter" });
      return;
    }
    reply.header("cache-control", "no-store").send({ presence: presence.list(filters) });
  });

  app.post<{
    Body: { clientId?: unknown; mode?: unknown; workspaceId?: unknown; sessionId?: unknown; agentId?: unknown };
  }>("/api/v1/presence", async (request, reply) => {
    const {
      clientId,
      mode,
      workspaceId: rawWorkspaceId,
      sessionId: rawSessionId,
      agentId: rawAgentId,
    } = request.body ?? {};
    if (
      !validTeamApiId(clientId) ||
      (mode !== "viewing" && mode !== "operating") ||
      [rawWorkspaceId, rawSessionId, rawAgentId].some((value) => value !== undefined && !validTeamApiId(value))
    ) {
      reply.code(400).send({ code: "INVALID_PRESENCE", error: "valid client, mode, and target are required" });
      return;
    }
    let workspaceId = typeof rawWorkspaceId === "string" ? rawWorkspaceId : undefined;
    let sessionId = typeof rawSessionId === "string" ? rawSessionId : undefined;
    let agentId = typeof rawAgentId === "string" ? rawAgentId : undefined;
    if (agentId) {
      const agent = commandStore.getAgent(agentId);
      if (
        !agent ||
        (sessionId && agent.sessionId !== sessionId) ||
        (workspaceId && agent.workspaceId !== workspaceId)
      ) {
        reply.code(404).send({ code: "PRESENCE_TARGET_NOT_FOUND", error: "agent target not found" });
        return;
      }
      sessionId = agent.sessionId;
      workspaceId = agent.workspaceId;
    } else if (sessionId) {
      const placement = commandStore.placementForSession(sessionId);
      if (!terminalManager.get(sessionId) || !placement || (workspaceId && placement.workspaceId !== workspaceId)) {
        reply.code(404).send({ code: "PRESENCE_TARGET_NOT_FOUND", error: "session target not found" });
        return;
      }
      workspaceId = placement.workspaceId;
      agentId = placement.agentId;
    } else if (workspaceId && !commandStore.getWorkspace(workspaceId)) {
      reply.code(404).send({ code: "PRESENCE_TARGET_NOT_FOUND", error: "workspace target not found" });
      return;
    }
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    if (mode === "operating") {
      const lease = sessionId ? inputLeases.get(sessionId) : undefined;
      if (!lease || lease.actorType !== principal.actorType || lease.actorId !== principal.actorId) {
        reply
          .code(409)
          .send({ code: "PRESENCE_NOT_OPERATOR", error: "operating presence requires the active input lease" });
        return;
      }
    }
    try {
      const record = presence.heartbeat(principal, {
        clientId,
        mode,
        hostId: commandStore.getHost().id,
        ...(workspaceId ? { workspaceId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(currentTeamMember(request)?.id ? { memberId: currentTeamMember(request)!.id } : {}),
      });
      reply.code(200).send({ presence: record, heartbeatMs: PRESENCE_HEARTBEAT_MS });
    } catch {
      reply.code(400).send({ code: "INVALID_PRESENCE", error: "invalid presence heartbeat" });
    }
  });

  app.delete<{ Body: { clientId?: unknown } }>("/api/v1/presence", async (request, reply) => {
    if (!validTeamApiId(request.body?.clientId)) {
      reply.code(400).send({ code: "INVALID_PRESENCE", error: "valid clientId is required" });
      return;
    }
    presence.release(authenticatedPrincipals.get(request) ?? hostPrincipal(), request.body.clientId);
    reply.code(204).send();
  });

  app.get<{ Querystring: { once?: string } }>("/api/v1/presence/stream", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    const write = (name: string, data: unknown, revision?: number) => {
      if (closed || reply.raw.destroyed) return;
      if (reply.raw.writableLength > 1_000_000) {
        close();
        reply.raw.destroy();
        return;
      }
      if (revision !== undefined) reply.raw.write(`id: ${revision}\n`);
      reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const unsubscribe = presence.subscribe((event) => write("presence", event, event.presence.revision));
    const heartbeat = setInterval(() => {
      if (!closed && !reply.raw.destroyed) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 20_000);
    heartbeat.unref?.();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once("close", close);
    reply.raw.once("close", close);
    write("snapshot", { presence: presence.list(), heartbeatMs: PRESENCE_HEARTBEAT_MS, protocolVersion: 1 });
    write("ready", { heartbeatMs: 20_000, protocolVersion: 1 });
    if (request.query.once === "1") {
      close();
      reply.raw.end();
    }
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/v1/search", async (request, reply) => {
    const query = request.query.q?.trim().replace(/\s+/g, " ");
    const parsedLimit = Number(request.query.limit ?? 50);
    if (!query || query.length > 100 || !Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      reply.code(400).send({ code: "INVALID_SEARCH", error: "q and a limit from 1 to 100 are required" });
      return;
    }
    const needle = query.toLocaleLowerCase("en-US");
    type SearchResult = {
      kind: "host" | "workspace" | "session" | "agent" | "attention";
      id: string;
      label: string;
      detail?: string;
      workspaceId?: string;
      sessionId?: string;
      agentId?: string;
      score: number;
      updatedAt: number;
    };
    const results: SearchResult[] = [];
    const score = (fields: string[]): number => {
      let best = 0;
      for (const [index, field] of fields.entries()) {
        const value = field.toLocaleLowerCase("en-US");
        const weight = Math.max(0, 20 - index * 4);
        if (value === needle) best = Math.max(best, 300 + weight);
        else if (value.startsWith(needle)) best = Math.max(best, 220 + weight);
        else if (value.split(/[^\p{L}\p{N}_-]+/u).some((part) => part.startsWith(needle)))
          best = Math.max(best, 160 + weight);
        else if (value.includes(needle)) best = Math.max(best, 100 + weight);
      }
      return best;
    };
    const push = (result: Omit<SearchResult, "score">, fields: string[]) => {
      const rank = score(fields);
      if (rank > 0) results.push({ ...result, score: rank });
    };

    const host = commandStore.getHost();
    push({ kind: "host", id: host.id, label: host.label, updatedAt: host.updatedAt }, [host.label]);
    const workspaces = commandStore.listWorkspaces();
    for (const workspace of workspaces) {
      push(
        {
          kind: "workspace",
          id: workspace.id,
          label: workspace.label,
          detail: workspace.cwd,
          workspaceId: workspace.id,
          updatedAt: workspace.updatedAt,
        },
        [workspace.label, workspace.cwd],
      );
    }
    for (const session of terminalManager.list()) {
      const placement = commandStore.ensureSession(session.id, session.cwd, session.createdAt);
      syncCommandAgent(session.id, session.status === "ended" ? "ended" : session.activity);
      push(
        {
          kind: "session",
          id: session.id,
          label: session.name?.trim() || pathBasename(session.cwd) || session.id,
          detail: session.cwd,
          workspaceId: placement.workspaceId,
          sessionId: session.id,
          agentId: placement.agentId,
          updatedAt: session.lastActivityAt,
        },
        [session.name ?? "", session.cwd, session.provider ?? ""],
      );
    }
    for (const agent of commandStore.listAgents()) {
      push(
        {
          kind: "agent",
          id: agent.id,
          label: `${agent.provider} agent`,
          detail: agent.activity,
          workspaceId: agent.workspaceId,
          sessionId: agent.sessionId,
          agentId: agent.id,
          updatedAt: agent.updatedAt,
        },
        [agent.provider, agent.activity, agent.id],
      );
    }
    for (const item of commandStore.listAttention()) {
      push(
        {
          kind: "attention",
          id: item.id,
          label: item.title,
          ...(item.detail ? { detail: item.detail } : {}),
          workspaceId: item.workspaceId,
          sessionId: item.sessionId,
          agentId: item.agentId,
          updatedAt: item.updatedAt,
        },
        [item.title, item.detail ?? "", item.kind],
      );
    }
    return {
      query,
      results: results
        .sort(
          (a, b) =>
            b.score - a.score || b.updatedAt - a.updatedAt || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
        )
        .slice(0, parsedLimit),
    };
  });

  app.get("/api/v1/host", async () => {
    const host = commandStore.getHost();
    const openAttention = commandStore.listAttention();
    return {
      host,
      summary: {
        workspaceCount: commandStore.listWorkspaces().length,
        agentCount: terminalManager.list().length,
        attentionCount: openAttention.filter((item) => item.state === "open").length,
        urgency: openAttention[0]?.urgency ?? 0,
      },
    };
  });

  app.patch<{ Body: { label?: unknown } }>("/api/v1/host", async (request, reply) => {
    if (!request.body || typeof request.body.label !== "string") {
      reply.code(400).send({ code: "INVALID_HOST_LABEL", error: "label is required" });
      return;
    }
    try {
      return { host: commandStore.renameHost(request.body.label) };
    } catch {
      reply.code(400).send({ code: "INVALID_HOST_LABEL", error: "label must be 1-80 printable characters" });
    }
  });

  app.get("/api/v1/devices", async (request, reply) => {
    const currentDeviceId = currentDeviceIdForRequest(request);
    reply.header("cache-control", "no-store").send({
      devices: deviceStore.list(),
      ...(currentDeviceId ? { currentDeviceId } : {}),
    });
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/api/v1/devices/:id", async (request, reply) => {
    const name = normalizeDeviceName(request.body?.name);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.params.id) || !name) {
      reply.code(400).send({ code: "INVALID_DEVICE", error: "valid device id and name are required" });
      return;
    }
    const device = deviceStore.rename(request.params.id, name);
    if (!device) {
      reply.code(404).send({ code: "DEVICE_NOT_FOUND", error: "device not found" });
      return;
    }
    commandStore.appendEvent("device.updated", "device", device.id, {});
    return { device };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/devices/:id", async (request, reply) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.params.id)) {
      reply.code(400).send({ code: "INVALID_DEVICE", error: "invalid device id" });
      return;
    }
    if (!deviceStore.revoke(request.params.id)) {
      reply.code(404).send({ code: "DEVICE_NOT_FOUND", error: "device not found" });
      return;
    }
    deps.pushStore?.removeForDevice(request.params.id);
    closeRemotePrincipalSockets(request.params.id);
    notifyDeviceRevoked(request.params.id);
    commandStore.appendEvent("device.revoked", "device", request.params.id, {});
    reply.code(204).send();
  });

  app.get("/api/v1/adapters", async () => ({
    adapters: providers.descriptors(),
    packages: extensionManager.list("adapter"),
  }));

  app.get("/api/v1/openapi.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300").send(
      buildOpenApiDocument({
        serverVersion: RUNNING_VERSION,
        adapters: providers.descriptors(),
      }),
    );
  });

  const supportedAutomationPermissions = new Set(["attention:write", "events:write"]);
  const hasSupportedAutomationPermissions = (permissions: string[]) =>
    permissions.every((permission) => supportedAutomationPermissions.has(permission));

  app.get("/api/v1/automations", async () => ({ automations: controlStore.listAutomations() }));

  app.post<{ Body: unknown }>("/api/v1/automations", async (request, reply) => {
    const input = normalizeAutomationInput(request.body);
    if (!input || !hasSupportedAutomationPermissions(input.permissions)) {
      reply.code(400).send({
        code: "INVALID_AUTOMATION",
        error: "automation trigger, action, and supported permissions are required",
      });
      return;
    }
    try {
      const automation = controlStore.createAutomation(input);
      commandStore.appendEvent("automation.created", "automation", automation.id, {});
      reply.code(201).send({ automation });
    } catch {
      reply.code(400).send({ code: "INVALID_AUTOMATION", error: "invalid automation" });
    }
  });

  app.patch<{ Params: { id: string }; Body: UpdateAutomationInput }>(
    "/api/v1/automations/:id",
    async (request, reply) => {
      try {
        const current = controlStore.getAutomation(request.params.id);
        if (!current) {
          reply.code(404).send({ code: "AUTOMATION_NOT_FOUND", error: "automation not found" });
          return;
        }
        const candidate = normalizeAutomationInput({ ...current, ...(request.body ?? {}) });
        if (!candidate || !hasSupportedAutomationPermissions(candidate.permissions)) {
          reply.code(400).send({ code: "INVALID_AUTOMATION", error: "invalid automation update" });
          return;
        }
        const automation = controlStore.updateAutomation(request.params.id, request.body ?? {});
        commandStore.appendEvent("automation.updated", "automation", request.params.id, {});
        return { automation };
      } catch {
        reply.code(400).send({ code: "INVALID_AUTOMATION", error: "invalid automation update" });
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/automations/:id", async (request, reply) => {
    if (!controlStore.removeAutomation(request.params.id)) {
      reply.code(404).send({ code: "AUTOMATION_NOT_FOUND", error: "automation not found" });
      return;
    }
    commandStore.appendEvent("automation.removed", "automation", request.params.id, {});
    reply.code(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/v1/automations/:id/runs",
    async (request, reply) => {
      if (!controlStore.getAutomation(request.params.id)) {
        reply.code(404).send({ code: "AUTOMATION_NOT_FOUND", error: "automation not found" });
        return;
      }
      const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        reply.code(400).send({ code: "INVALID_LIMIT", error: "limit must be 1-1000" });
        return;
      }
      return { runs: controlStore.listAutomationRuns(request.params.id, limit) };
    },
  );

  app.post<{ Params: { id: string } }>("/api/v1/automations/:id/run", async (request, reply) => {
    const automation = controlStore.getAutomation(request.params.id);
    if (!automation) {
      reply.code(404).send({ code: "AUTOMATION_NOT_FOUND", error: "automation not found" });
      return;
    }
    const run = executeAutomation(automation);
    commandStore.appendEvent("automation.ran", "automation", automation.id, { status: run.status });
    reply.code(run.status === "failed" ? 409 : 200).send({ run });
  });

  const requireHostRecoveryCredential = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!config.accessToken) return true;
    const presented = extractBearerToken(request.headers.authorization);
    if (authGate.isCurrentHostToken(presented)) return true;
    reply.code(403).send({ code: "HOST_ADMIN_REQUIRED", error: "the current host recovery credential is required" });
    return false;
  };

  const parseAuditRange = (
    query: { after?: string; limit?: string },
    reply: FastifyReply,
  ): { after: number; limit: number } | undefined => {
    const after = query.after === undefined ? 0 : Number(query.after);
    const limit = query.limit === undefined ? 500 : Number(query.limit);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      reply.code(400).send({ code: "INVALID_AUDIT_CURSOR", error: "invalid audit cursor or limit" });
      return undefined;
    }
    return { after, limit };
  };

  app.get<{ Querystring: { after?: string; limit?: string; order?: string } }>(
    "/api/v1/audit",
    async (request, reply) => {
      if (!requireHostRecoveryCredential(request, reply)) return;
      if (
        (request.query.order !== undefined && request.query.order !== "latest") ||
        (request.query.order === "latest" && request.query.after !== undefined)
      ) {
        reply.code(400).send({
          code: "INVALID_AUDIT_CURSOR",
          error: "order must be latest and cannot be combined with after",
        });
        return;
      }
      const range = parseAuditRange(request.query, reply);
      if (!range) return;
      const { after, limit } = range;
      const records =
        request.query.order === "latest" ? controlStore.listAuditLatest(limit) : controlStore.listAudit(after, limit);
      const nextCursor = request.query.order === "latest" ? (records[0]?.id ?? 0) : (records.at(-1)?.id ?? after);
      reply.header("cache-control", "no-store").send({ records, nextCursor });
    },
  );

  app.get("/api/v1/audit/verify", async (request, reply) => {
    if (!requireHostRecoveryCredential(request, reply)) return;
    reply.header("cache-control", "no-store").send(controlStore.verifyAuditChain());
  });

  app.get<{ Querystring: { after?: string; limit?: string } }>("/api/v1/audit/export", async (request, reply) => {
    if (!requireHostRecoveryCredential(request, reply)) return;
    const range = parseAuditRange(request.query, reply);
    if (!range) return;
    const { after, limit } = range;
    const records = controlStore.listAudit(after, limit);
    const nextCursor = records.at(-1)?.id ?? after;
    const manifest = {
      type: "manifest",
      schemaVersion: 1,
      exportedAt: Date.now(),
      range: { after, limit, count: records.length, nextCursor },
      integrity: { algorithm: "sha256-chain", ...controlStore.verifyAuditChain() },
    };
    const body = [
      JSON.stringify(manifest),
      ...records.map((record) => JSON.stringify({ type: "record", record })),
      "",
    ].join("\n");
    reply
      .header("cache-control", "no-store")
      .header("content-disposition", 'attachment; filename="roamcode-audit.ndjson"')
      .type("application/x-ndjson; charset=utf-8")
      .send(body);
  });

  const validExtensionKind = (value: unknown): value is ExtensionKind => value === "adapter" || value === "plugin";
  const validExtensionId = (value: unknown): value is string =>
    typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
  const sendExtensionFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ExtensionError || error instanceof PluginRuntimeError) {
      reply.code(error.statusCode).send({ code: error.code, error: error.message });
      return;
    }
    if (error instanceof ProviderError) {
      reply.code(409).send({ code: error.code, error: error.message });
      return;
    }
    reply.code(500).send({ code: "EXTENSION_OPERATION_FAILED", error: "extension operation failed" });
  };
  const syncInstalledAdapter = async (id: string): Promise<void> => {
    const extension = extensionManager.get("adapter", id);
    if (!extension || extension.current.manifest.kind !== "adapter") {
      providers.unregisterInstalled(id);
      return;
    }
    if (!(await extensionManager.verify("adapter", id, extension.currentVersion))) {
      throw new ExtensionError("EXTENSION_INTEGRITY_MISMATCH", "adapter package integrity verification failed", 409);
    }
    providers.register(
      createInstalledAdapterProvider({ extensions: extensionManager, adapterId: id }),
      "installed",
      extension.enabled,
    );
  };

  app.get("/api/v1/extensions", async () => ({ extensions: extensionManager.list() }));
  app.get("/api/v1/plugins", async () => ({ plugins: extensionManager.list("plugin") }));

  app.post<{ Body: { sourceDirectory?: unknown } }>("/api/v1/extensions/inspect", async (request, reply) => {
    if (!requireHostRecoveryCredential(request, reply)) return;
    if (typeof request.body?.sourceDirectory !== "string") {
      reply.code(400).send({ code: "EXTENSION_INVALID", error: "sourceDirectory is required" });
      return;
    }
    try {
      return await inspectExtensionPackage(request.body.sourceDirectory, config.fsRoot);
    } catch (error) {
      sendExtensionFailure(reply, error);
    }
  });

  app.post<{
    Body: {
      sourceDirectory?: unknown;
      expectedIntegrity?: unknown;
      signature?: unknown;
      publicKey?: unknown;
      source?: unknown;
      allowUnsigned?: unknown;
    };
  }>("/api/v1/extensions/install", async (request, reply) => {
    if (!requireHostRecoveryCredential(request, reply)) return;
    const body = request.body ?? {};
    if (
      typeof body.sourceDirectory !== "string" ||
      typeof body.expectedIntegrity !== "string" ||
      (body.signature !== undefined && typeof body.signature !== "string") ||
      (body.publicKey !== undefined && typeof body.publicKey !== "string") ||
      (body.source !== undefined && typeof body.source !== "string") ||
      (body.allowUnsigned !== undefined && typeof body.allowUnsigned !== "boolean")
    ) {
      reply.code(400).send({ code: "EXTENSION_INVALID", error: "valid extension install fields are required" });
      return;
    }
    try {
      const extension = await extensionManager.install({
        sourceDirectory: body.sourceDirectory,
        expectedIntegrity: body.expectedIntegrity,
        ...(typeof body.signature === "string" ? { signature: body.signature } : {}),
        ...(typeof body.publicKey === "string" ? { publicKey: body.publicKey } : {}),
        ...(typeof body.source === "string" ? { source: body.source } : {}),
        ...(typeof body.allowUnsigned === "boolean" ? { allowUnsigned: body.allowUnsigned } : {}),
      });
      if (extension.kind === "adapter") {
        try {
          await syncInstalledAdapter(extension.id);
        } catch (error) {
          // Installation changes the durable current-version pointer before the runtime registry is updated.
          // Restore the previous pointer (or remove a first install) so API failure can never leave a package
          // active in storage but absent/different in the running registry.
          try {
            if (extension.previousVersion) {
              extensionManager.rollback("adapter", extension.id);
              await syncInstalledAdapter(extension.id);
            } else {
              extensionManager.setEnabled("adapter", extension.id, false);
              await extensionManager.uninstall("adapter", extension.id);
              providers.unregisterInstalled(extension.id);
            }
          } catch {
            // The original verified registry entry remains authoritative when restoration itself cannot finish.
          }
          throw error;
        }
      }
      commandStore.appendEvent("extension.installed", "extension", `${extension.kind}:${extension.id}`, {
        kind: extension.kind,
        version: extension.currentVersion,
        trust: extension.current.trust,
      });
      reply.code(201).send({ extension });
    } catch (error) {
      sendExtensionFailure(reply, error);
    }
  });

  app.patch<{
    Params: { kind: string; id: string };
    Body: { enabled?: unknown; approvedPermissions?: unknown };
  }>("/api/v1/extensions/:kind/:id", async (request, reply) => {
    if (!requireHostRecoveryCredential(request, reply)) return;
    const { kind, id } = request.params;
    const permissions = request.body?.approvedPermissions;
    if (
      !validExtensionKind(kind) ||
      !validExtensionId(id) ||
      typeof request.body?.enabled !== "boolean" ||
      (permissions !== undefined &&
        (!Array.isArray(permissions) ||
          permissions.length > 32 ||
          permissions.some((permission) => typeof permission !== "string")))
    ) {
      reply.code(400).send({ code: "EXTENSION_INVALID", error: "valid extension state and permissions are required" });
      return;
    }
    try {
      const previous = extensionManager.get(kind, id);
      const extension = extensionManager.setEnabled(
        kind,
        id,
        request.body.enabled,
        permissions as string[] | undefined,
      );
      if (kind === "adapter") {
        try {
          if (request.body.enabled) await syncInstalledAdapter(id);
          else if (providers.source(id) === "installed") providers.setEnabled(id, false);
        } catch (error) {
          if (previous) {
            extensionManager.setEnabled(kind, id, previous.enabled, previous.approvedPermissions);
            if (previous.enabled) await syncInstalledAdapter(id);
            else if (providers.source(id) === "installed") providers.setEnabled(id, false);
          }
          throw error;
        }
      }
      commandStore.appendEvent(
        request.body.enabled ? "extension.enabled" : "extension.disabled",
        "extension",
        `${kind}:${id}`,
        {
          kind,
          version: extension.currentVersion,
        },
      );
      return { extension };
    } catch (error) {
      sendExtensionFailure(reply, error);
    }
  });

  app.post<{ Params: { kind: string; id: string } }>(
    "/api/v1/extensions/:kind/:id/rollback",
    async (request, reply) => {
      if (!requireHostRecoveryCredential(request, reply)) return;
      const { kind, id } = request.params;
      if (!validExtensionKind(kind) || !validExtensionId(id)) {
        reply.code(400).send({ code: "EXTENSION_INVALID", error: "valid extension kind and id are required" });
        return;
      }
      try {
        const previous = extensionManager.get(kind, id);
        const extension = extensionManager.rollback(kind, id);
        if (kind === "adapter") {
          try {
            await syncInstalledAdapter(id);
          } catch (error) {
            // rollback() swaps current/previous, so a second swap restores the exact pre-request state.
            if (previous) {
              extensionManager.rollback(kind, id);
              await syncInstalledAdapter(id);
            }
            throw error;
          }
        }
        commandStore.appendEvent("extension.rolled_back", "extension", `${kind}:${id}`, {
          kind,
          version: extension.currentVersion,
        });
        return { extension };
      } catch (error) {
        sendExtensionFailure(reply, error);
      }
    },
  );

  app.delete<{
    Params: { kind: string; id: string };
    Body: { confirm?: unknown; purgeState?: unknown };
  }>("/api/v1/extensions/:kind/:id", async (request, reply) => {
    if (!requireHostRecoveryCredential(request, reply)) return;
    const { kind, id } = request.params;
    if (
      !validExtensionKind(kind) ||
      !validExtensionId(id) ||
      request.body?.confirm !== true ||
      (request.body?.purgeState !== undefined && typeof request.body.purgeState !== "boolean")
    ) {
      reply
        .code(400)
        .send({ code: "EXTENSION_CONFIRM_REQUIRED", error: "valid kind, id, and confirm:true are required" });
      return;
    }
    try {
      if (kind === "adapter" && store.list().some((session) => session.provider === id)) {
        throw new ExtensionError(
          "EXTENSION_IN_USE",
          "remove the adapter's preserved sessions before uninstalling it",
          409,
        );
      }
      if (!(await extensionManager.uninstall(kind, id, { purgeState: request.body?.purgeState === true }))) {
        reply.code(404).send({ code: "EXTENSION_NOT_FOUND", error: "extension not found" });
        return;
      }
      if (kind === "adapter") providers.unregisterInstalled(id);
      commandStore.appendEvent("extension.uninstalled", "extension", `${kind}:${id}`, { kind });
      reply.code(204).send();
    } catch (error) {
      sendExtensionFailure(reply, error);
    }
  });

  app.post<{
    Params: { id: string; actionId: string };
    Body: { workspaceId?: unknown; explicitCwd?: unknown; context?: unknown };
  }>("/api/v1/plugins/:id/actions/:actionId/run", async (request, reply) => {
    const { id, actionId } = request.params;
    const body = request.body ?? {};
    if (
      !validExtensionId(id) ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(actionId) ||
      (body.workspaceId !== undefined && typeof body.workspaceId !== "string") ||
      (body.explicitCwd !== undefined && typeof body.explicitCwd !== "string") ||
      (body.context !== undefined && (!body.context || typeof body.context !== "object" || Array.isArray(body.context)))
    ) {
      reply.code(400).send({ code: "PLUGIN_INVALID_RUN", error: "valid plugin action input is required" });
      return;
    }
    const workspace = typeof body.workspaceId === "string" ? commandStore.getWorkspace(body.workspaceId) : undefined;
    if (typeof body.workspaceId === "string" && !workspace) {
      reply.code(404).send({ code: "WORKSPACE_NOT_FOUND", error: "workspace not found" });
      return;
    }
    // Arbitrary cwd selection is an administrative escape hatch. The runtime still enforces FS_ROOT.
    if (body.explicitCwd !== undefined && !requireHostRecoveryCredential(request, reply)) return;
    try {
      const result = await pluginRuntime.run({
        pluginId: id,
        actionId,
        ...(workspace ? { workspacePath: workspace.cwd } : {}),
        ...(typeof body.explicitCwd === "string" ? { explicitCwd: body.explicitCwd } : {}),
        ...(body.context && typeof body.context === "object"
          ? { context: body.context as Record<string, unknown> }
          : {}),
      });
      commandStore.appendEvent("plugin.run_finished", "plugin", id, {
        actionId,
        status: result.status,
        exitCode: result.exitCode,
      });
      return { result };
    } catch (error) {
      sendExtensionFailure(reply, error);
    }
  });

  app.get<{ Querystring: { q?: string } }>("/api/v1/marketplace", async (request) => ({
    entries: searchMarketplace(deps.marketplaceEntries ?? [], request.query.q ?? ""),
  }));

  const sendWorktreeFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof WorktreeError) {
      reply.code(error.statusCode).send({ code: error.code, error: error.message });
      return;
    }
    reply.code(500).send({ code: "WORKTREE_OPERATION_FAILED", error: "worktree operation failed" });
  };
  const ensureWorktreeWorkspace = (worktree: { path: string }, label?: string) => {
    let workspace = commandStore.createWorkspace({
      cwd: worktree.path,
      ...(label ? { label } : {}),
      kind: "worktree",
    });
    if (workspace.archivedAt !== undefined)
      workspace = commandStore.updateWorkspace(workspace.id, { archived: false })!;
    return workspace;
  };

  app.post<{
    Body: { repositoryPath?: unknown; path?: unknown; branch?: unknown; baseRef?: unknown; label?: unknown };
  }>("/api/v1/worktrees", async (request, reply) => {
    const { repositoryPath, path, branch, baseRef, label } = request.body ?? {};
    if (
      typeof repositoryPath !== "string" ||
      typeof path !== "string" ||
      (branch !== undefined && typeof branch !== "string") ||
      (baseRef !== undefined && typeof baseRef !== "string") ||
      (label !== undefined && typeof label !== "string")
    ) {
      reply.code(400).send({ code: "INVALID_WORKTREE", error: "valid repositoryPath and path are required" });
      return;
    }
    try {
      const result = await worktreeService.create({
        repositoryPath,
        path,
        ...(typeof branch === "string" ? { branch } : {}),
        ...(typeof baseRef === "string" ? { baseRef } : {}),
      });
      const workspace = ensureWorktreeWorkspace(result.worktree, typeof label === "string" ? label : undefined);
      commandStore.appendEvent(result.created ? "worktree.created" : "worktree.recovered", "workspace", workspace.id, {
        dirty: result.worktree.dirty,
      });
      reply.code(result.created ? 201 : 200).send({ workspace, worktree: result.worktree, created: result.created });
    } catch (error) {
      sendWorktreeFailure(reply, error);
    }
  });

  app.post<{ Body: { cwd?: unknown; label?: unknown } }>("/api/v1/worktrees/open", async (request, reply) => {
    const { cwd, label } = request.body ?? {};
    if (typeof cwd !== "string" || (label !== undefined && typeof label !== "string")) {
      reply.code(400).send({ code: "INVALID_WORKTREE", error: "valid cwd is required" });
      return;
    }
    try {
      const worktree = await worktreeService.inspect(cwd);
      const workspace = ensureWorktreeWorkspace(worktree, typeof label === "string" ? label : undefined);
      commandStore.appendEvent("worktree.opened", "workspace", workspace.id, { dirty: worktree.dirty });
      reply.code(200).send({ workspace, worktree });
    } catch (error) {
      sendWorktreeFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/workspaces/:id/worktree", async (request, reply) => {
    const workspace = commandStore.getWorkspace(request.params.id);
    if (!workspace) {
      reply.code(404).send({ code: "WORKSPACE_NOT_FOUND", error: "workspace not found" });
      return;
    }
    if (workspace.kind !== "worktree") {
      reply.code(409).send({ code: "WORKSPACE_NOT_WORKTREE", error: "workspace is not a worktree" });
      return;
    }
    try {
      return { workspace, worktree: await worktreeService.inspect(workspace.cwd) };
    } catch (error) {
      sendWorktreeFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string }; Body: { confirm?: unknown; force?: unknown } }>(
    "/api/v1/workspaces/:id/worktree",
    async (request, reply) => {
      const workspace = commandStore.getWorkspace(request.params.id);
      if (!workspace) {
        reply.code(404).send({ code: "WORKSPACE_NOT_FOUND", error: "workspace not found" });
        return;
      }
      if (workspace.kind !== "worktree") {
        reply.code(409).send({ code: "WORKSPACE_NOT_WORKTREE", error: "workspace is not a worktree" });
        return;
      }
      if (
        request.body?.confirm !== true ||
        (request.body.force !== undefined && typeof request.body.force !== "boolean")
      ) {
        reply.code(400).send({ code: "WORKTREE_CONFIRM_REQUIRED", error: "confirm:true is required" });
        return;
      }
      try {
        const worktree = await worktreeService.remove(workspace.cwd, request.body.force === true);
        const archived = commandStore.updateWorkspace(workspace.id, { archived: true })!;
        commandStore.appendEvent("worktree.removed", "workspace", workspace.id, {
          force: request.body.force === true,
          changedFiles: worktree.changedFiles,
        });
        return { workspace: archived, worktree };
      } catch (error) {
        sendWorktreeFailure(reply, error);
      }
    },
  );

  app.get<{ Querystring: { includeArchived?: string } }>("/api/v1/workspaces", async (request) => {
    const includeArchived = request.query.includeArchived === "1";
    const attention = commandStore.listAttention({ includeSnoozed: true });
    const agents = commandStore.listAgents();
    return {
      workspaces: commandStore.listWorkspaces({ includeArchived }).map((workspace) => {
        const workspaceAttention = attention.filter((item) => item.workspaceId === workspace.id);
        return {
          ...workspace,
          agentCount: agents.filter((agent) => agent.workspaceId === workspace.id).length,
          attentionCount: workspaceAttention.filter((item) => item.state === "open").length,
          urgency: workspaceAttention.reduce((max, item) => Math.max(max, item.urgency), 0),
        };
      }),
    };
  });

  app.post<{
    Body: { cwd?: unknown; label?: unknown; kind?: unknown };
  }>("/api/v1/workspaces", async (request, reply) => {
    const { cwd, label, kind } = request.body ?? {};
    if (
      typeof cwd !== "string" ||
      (label !== undefined && typeof label !== "string") ||
      (kind !== undefined && kind !== "directory" && kind !== "worktree")
    ) {
      reply.code(400).send({ code: "INVALID_WORKSPACE", error: "valid cwd, label, and kind are required" });
      return;
    }
    try {
      // listDirectory performs both lexical and realpath confinement, including symlink escape rejection.
      const described = await fsService.listDirectory(cwd);
      if (kind === "worktree") await worktreeService.inspect(described.path);
      const workspace = commandStore.createWorkspace({
        cwd: described.path,
        ...(typeof label === "string" ? { label } : {}),
        ...(kind === "worktree" ? { kind } : {}),
      });
      reply.code(201).send({ workspace });
    } catch (error) {
      if (error instanceof WorktreeError) {
        sendWorktreeFailure(reply, error);
        return;
      }
      const status = error instanceof FsError && error.code === "forbidden" ? 403 : 400;
      reply.code(status).send({
        code: status === 403 ? "WORKSPACE_OUTSIDE_ROOT" : "INVALID_WORKSPACE",
        error: status === 403 ? "workspace is outside FS_ROOT" : "workspace directory is unavailable",
      });
    }
  });

  app.patch<{
    Params: { id: string };
    Body: { label?: unknown; sortOrder?: unknown; archived?: unknown };
  }>("/api/v1/workspaces/:id", async (request, reply) => {
    const { label, sortOrder, archived } = request.body ?? {};
    if (
      (label !== undefined && typeof label !== "string") ||
      (sortOrder !== undefined && (!Number.isSafeInteger(sortOrder) || (sortOrder as number) < 0)) ||
      (archived !== undefined && typeof archived !== "boolean")
    ) {
      reply.code(400).send({ code: "INVALID_WORKSPACE_UPDATE", error: "invalid workspace update" });
      return;
    }
    try {
      const workspace = commandStore.updateWorkspace(request.params.id, {
        ...(typeof label === "string" ? { label } : {}),
        ...(typeof sortOrder === "number" ? { sortOrder } : {}),
        ...(typeof archived === "boolean" ? { archived } : {}),
      });
      if (!workspace) {
        reply.code(404).send({ code: "WORKSPACE_NOT_FOUND", error: "workspace not found" });
        return;
      }
      return { workspace };
    } catch {
      reply.code(400).send({ code: "INVALID_WORKSPACE_UPDATE", error: "invalid workspace update" });
    }
  });

  app.get("/api/v1/agents", async () => {
    for (const meta of terminalManager.list()) {
      syncCommandAgent(meta.id, meta.status === "ended" ? "ended" : meta.activity);
    }
    return { agents: commandStore.listAgents() };
  });

  app.get("/api/v1/layout", async () => commandStore.getLayout());

  app.put<{ Body: { document?: unknown; expectedRevision?: unknown } }>("/api/v1/layout", async (request, reply) => {
    const document = request.body?.document;
    const expectedRevision = request.body?.expectedRevision;
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      !Number.isSafeInteger(expectedRevision) ||
      (expectedRevision as number) < 0
    ) {
      reply.code(400).send({ code: "INVALID_LAYOUT", error: "valid document and expectedRevision are required" });
      return;
    }
    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
      reply.code(413).send({ code: "LAYOUT_TOO_LARGE", error: "layout exceeds 64 KiB" });
      return;
    }
    try {
      return commandStore.putLayout(document as Record<string, unknown>, expectedRevision as number);
    } catch (error) {
      if (error instanceof CommandCenterRevisionConflictError) {
        reply.code(409).send({ code: "LAYOUT_CONFLICT", error: "layout revision conflict", current: error.current });
        return;
      }
      reply.code(500).send({ code: "LAYOUT_WRITE_FAILED", error: "could not persist layout" });
    }
  });

  app.get<{ Querystring: { includeResolved?: string; includeSnoozed?: string } }>(
    "/api/v1/attention",
    async (request, reply) => {
      const items = commandStore.listAttention({
        includeResolved: request.query.includeResolved === "1",
        includeSnoozed: request.query.includeSnoozed === "1",
      });
      reply.header("cache-control", "no-store").send({
        items,
        unreadCount: items.filter((item) => item.state === "open").length,
      });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { action?: unknown; until?: unknown };
  }>("/api/v1/attention/:id", async (request, reply) => {
    const action = request.body?.action;
    let item;
    try {
      if (action === "acknowledge") item = commandStore.acknowledgeAttention(request.params.id);
      else if (action === "resolve") item = commandStore.resolveAttention(request.params.id);
      else if (action === "snooze" && typeof request.body?.until === "number") {
        item = commandStore.snoozeAttention(request.params.id, request.body.until);
      } else {
        reply.code(400).send({ code: "INVALID_ATTENTION_ACTION", error: "invalid attention action" });
        return;
      }
    } catch {
      reply.code(400).send({ code: "INVALID_ATTENTION_ACTION", error: "invalid attention action" });
      return;
    }
    if (!item) {
      reply.code(404).send({ code: "ATTENTION_NOT_FOUND", error: "attention item not found" });
      return;
    }
    return { item };
  });

  app.get<{ Querystring: { after?: string; limit?: string } }>("/api/v1/events", async (request, reply) => {
    const after = request.query.after === undefined ? 0 : Number(request.query.after);
    const limit = request.query.limit === undefined ? 500 : Number(request.query.limit);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      reply.code(400).send({ code: "INVALID_EVENT_CURSOR", error: "invalid event cursor or limit" });
      return;
    }
    const events = commandStore.listEvents(after, limit);
    reply.header("cache-control", "no-store").send({
      events,
      nextCursor: events.at(-1)?.id ?? after,
    });
  });

  app.get<{
    Querystring: { after?: string; once?: string };
  }>("/api/v1/events/stream", async (request, reply) => {
    const headerCursor = request.headers["last-event-id"];
    const rawCursor = request.query.after ?? (Array.isArray(headerCursor) ? headerCursor[0] : headerCursor) ?? "0";
    const after = Number(rawCursor);
    if (!Number.isSafeInteger(after) || after < 0) {
      reply.code(400).send({ code: "INVALID_EVENT_CURSOR", error: "invalid event cursor" });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let closed = false;
    let streaming = false;
    let cursor = after;
    const pending: ReturnType<CommandCenterStore["listEvents"]> = [];
    const write = (name: string, data: unknown, id?: number) => {
      if (closed || reply.raw.destroyed) return;
      if (id !== undefined) reply.raw.write(`id: ${id}\n`);
      reply.raw.write(`event: ${name}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const writeCommand = (event: (typeof pending)[number]) => {
      if (event.id <= cursor) return;
      cursor = event.id;
      write("command", event, event.id);
    };
    const unsubscribe = commandStore.subscribeEvents((event) => {
      if (streaming) writeCommand(event);
      else pending.push(event);
    });
    const streamState: { heartbeat?: ReturnType<typeof setInterval> } = {};
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (streamState.heartbeat) clearInterval(streamState.heartbeat);
    };
    request.raw.once("close", close);
    reply.raw.once("close", close);

    const snapshot = () => {
      for (const meta of terminalManager.list()) {
        syncCommandAgent(meta.id, meta.status === "ended" ? "ended" : meta.activity);
      }
      const items = commandStore.listAttention();
      const bounds = commandStore.eventBounds();
      return {
        protocolVersion: 1,
        cursor: bounds.latest,
        host: commandStore.getHost(),
        workspaces: commandStore.listWorkspaces(),
        agents: commandStore.listAgents(),
        attention: { items, unreadCount: items.filter((item) => item.state === "open").length },
        layout: commandStore.getLayout(),
        sessions: sessionSnapshots(),
      };
    };

    const bounds = commandStore.eventBounds();
    const overflowed = after > 0 && (after > bounds.latest || (bounds.earliest > 0 && after + 1 < bounds.earliest));
    if (after === 0 || overflowed) {
      const current = snapshot();
      cursor = current.cursor;
      write(overflowed ? "reset" : "snapshot", current, cursor);
    } else {
      while (!closed) {
        const batch = commandStore.listEvents(cursor, 1000);
        for (const event of batch) writeCommand(event);
        if (batch.length < 1000) break;
      }
    }

    streaming = true;
    pending.sort((a, b) => a.id - b.id);
    for (const event of pending) writeCommand(event);
    pending.length = 0;
    write("ready", { cursor, heartbeatMs: 20_000, protocolVersion: 1 }, cursor);

    // `once=1` is a bounded diagnostics/conformance mode. Production clients omit it and keep the stream open.
    if (request.query.once === "1") {
      close();
      reply.raw.end();
      return;
    }
    streamState.heartbeat = setInterval(() => {
      if (!closed && !reply.raw.destroyed) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 20_000);
    streamState.heartbeat.unref?.();
  });

  // Server-authoritative remembered launch choices shared by every connected browser. GET seeds the wizard.
  // PUT remains for one-release compatibility with an older web bundle; current clients never expose or edit
  // these values in Settings, and every successful POST /sessions replaces them with the real launch options.
  app.get("/settings/session-defaults", async () => sessionDefaultsEnvelope(store.getSessionDefaults()));

  app.put<{ Body: unknown }>("/settings/session-defaults", { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      reply.code(400).send({ error: "invalid session defaults payload" });
      return;
    }
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);
    const expectedRevision = record.expectedRevision;
    if (
      keys.some((key) => key !== "defaults" && key !== "expectedRevision") ||
      !Object.prototype.hasOwnProperty.call(record, "defaults") ||
      !Number.isSafeInteger(expectedRevision) ||
      (expectedRevision as number) < 0
    ) {
      reply.code(400).send({ error: "invalid session defaults payload" });
      return;
    }

    let defaults;
    try {
      defaults = normalizeSessionDefaults(record.defaults);
    } catch {
      reply.code(400).send({ error: "invalid session defaults payload" });
      return;
    }

    try {
      const stored = store.putSessionDefaults(defaults, expectedRevision as number, Date.now());
      return sessionDefaultsEnvelope(stored);
    } catch (error) {
      if (error instanceof SessionDefaultsConflictError) {
        reply.code(409).send({
          code: "SETTINGS_CONFLICT",
          error: error.message,
          current: sessionDefaultsEnvelope(error.current),
        });
        return;
      }
      throw error;
    }
  });

  const sessionSnapshots = () =>
    terminalManager.list().map((t) => {
      const synced = syncCommandAgent(t.id, t.status === "ended" ? "ended" : t.activity);
      return {
        id: t.id,
        provider: t.provider,
        cwd: t.cwd,
        mode: "terminal" as const,
        status: t.status,
        createdAt: t.createdAt,
        lastActivityAt: t.lastActivityAt,
        ...(synced
          ? {
              workspaceId: synced.placement.workspaceId,
              agentId: synced.placement.agentId,
              agentActivity: synced.agent.activity,
            }
          : {}),
        // Live activity from the capture-pane monitor (working | blocked | idle) — the rail's per-session status.
        activity: t.activity,
        // Loud "needs you" flag = activity==="blocked" (claude waiting on YOUR decision). The SessionList badge +
        // count + away push key off this; a merely-idle or still-working session is NOT awaiting.
        awaiting: t.awaiting,
        // Whether this session runs with --dangerously-skip-permissions, so the rail can badge the RCE-skip risk.
        dangerouslySkip: t.dangerouslySkip,
        // Effective runtime metadata. Launch options seed it; the read-only pane monitor updates providers that
        // expose live model/effort chrome, so in-session changes reach the header on the next sessions poll.
        model: t.model,
        effort: t.effort,
        permissionMode: t.permissionMode,
        sandbox: t.sandbox,
        approvalPolicy: t.approvalPolicy,
        // User-set display name (PATCH /sessions/:id). `undefined` serializes to ABSENT, so the field only
        // appears when a name is actually set — clients `?? cwd` for the label.
        name: t.name,
        identityState: t.identityState,
        resumeIdentity: resumeIdentityFor(t.provider),
        providerSessionId: t.providerSessionId,
      };
    });

  app.get("/sessions", async () => ({ sessions: sessionSnapshots() }));
  app.get("/api/v1/sessions", async () => ({ sessions: sessionSnapshots() }));
  app.post<{ Body: CreateSessionBody }>("/api/v1/sessions", createSessionHandler);

  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id", async (request, reply) => {
    const session = sessionSnapshots().find((candidate) => candidate.id === request.params.id);
    if (!session) {
      reply.code(404).send({ code: "SESSION_NOT_FOUND", error: "session not found" });
      return;
    }
    return { session };
  });

  const validInputLeasePart = (value: unknown, max = 256): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
  const httpInputHolderId = (principal: InputLeasePrincipal, clientId: string): string =>
    `api:${createHash("sha256")
      .update(`${principal.actorType}\0${principal.actorId}\0${clientId}`)
      .digest("base64url")}`;
  const publicInputLease = (sessionId: string) => {
    const lease = inputLeases.get(sessionId);
    return lease
      ? {
          owner: { actorType: lease.actorType, label: lease.label },
          acquiredAt: lease.acquiredAt,
          renewedAt: lease.renewedAt,
          expiresAt: lease.expiresAt,
          revision: lease.revision,
        }
      : null;
  };

  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id/input-lease", async (request, reply) => {
    if (!terminalManager.get(request.params.id)) {
      reply.code(404).send({ code: "SESSION_NOT_FOUND", error: "session not found" });
      return;
    }
    return { lease: publicInputLease(request.params.id) };
  });

  app.post<{
    Params: { id: string };
    Body: { action?: unknown; clientId?: unknown; leaseId?: unknown; confirm?: unknown };
  }>("/api/v1/sessions/:id/input-lease", { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const { action, clientId, leaseId: presentedLeaseId, confirm } = request.body ?? {};
    if (!terminalManager.get(request.params.id)) {
      reply.code(404).send({ code: "SESSION_NOT_FOUND", error: "session not found" });
      return;
    }
    if (
      !["acquire", "takeover", "renew", "release", "revoke"].includes(typeof action === "string" ? action : "") ||
      (action !== "revoke" && !validInputLeasePart(clientId, 128)) ||
      ((action === "renew" || action === "release") && !validInputLeasePart(presentedLeaseId)) ||
      (confirm !== undefined && typeof confirm !== "boolean")
    ) {
      reply.code(400).send({
        code: "INVALID_INPUT_LEASE_REQUEST",
        error: "action is required; clientId is required except for admin revoke; renew/release also require a leaseId",
      });
      return;
    }
    if (action === "revoke") {
      if (confirm !== true) {
        reply.code(400).send({
          code: "INPUT_LEASE_REVOKE_CONFIRM_REQUIRED",
          error: "confirm:true is required before an administrator revokes input ownership",
        });
        return;
      }
      return { lease: null, revoked: inputLeases.revoke(request.params.id) };
    }
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    const holderId = httpInputHolderId(principal, clientId as string);
    if (action === "release") {
      if (!inputLeases.release(request.params.id, holderId, presentedLeaseId as string)) {
        reply.code(409).send({ code: "INPUT_LEASE_MISMATCH", error: "input lease is no longer owned by this client" });
        return;
      }
      return { lease: null };
    }
    if (!canWriteSession(principal, request.params.id)) {
      reply.code(403).send({
        code: "SESSION_OPERATE_FORBIDDEN",
        error: "your role can view but cannot operate this agent",
      });
      return;
    }
    if (action === "renew") {
      const renewed = inputLeases.renew(request.params.id, holderId, presentedLeaseId as string);
      if (!renewed) {
        reply.code(409).send({ code: "INPUT_LEASE_MISMATCH", error: "input lease is no longer owned by this client" });
        return;
      }
      return { leaseId: renewed.id, lease: publicInputLease(request.params.id) };
    }
    const authorized = action !== "takeover" || canTakeOverSession(principal, request.params.id);
    const result =
      action === "takeover"
        ? inputLeases.takeover(request.params.id, holderId, principal, confirm === true, authorized)
        : inputLeases.acquire(request.params.id, holderId, principal);
    if (result.status === "denied") {
      const reason = action === "takeover" && confirm !== true ? "confirmation required" : "input is already owned";
      reply.code(action === "takeover" && !authorized ? 403 : 409).send({
        code: action === "takeover" && !authorized ? "INPUT_TAKEOVER_FORBIDDEN" : "INPUT_LEASE_HELD",
        error: action === "takeover" && !authorized ? "input takeover is not allowed" : reason,
        lease: publicInputLease(request.params.id),
      });
      return;
    }
    reply.code(result.status === "granted" ? 201 : 200).send({
      leaseId: result.lease.id,
      lease: publicInputLease(request.params.id),
    });
  });

  app.post<{
    Params: { id: string };
    Body: { data?: unknown; appendNewline?: unknown; clientId?: unknown; leaseId?: unknown };
  }>("/api/v1/sessions/:id/input", { bodyLimit: 96 * 1024 }, async (request, reply) => {
    const { data, appendNewline, clientId, leaseId: presentedLeaseId } = request.body ?? {};
    if (
      typeof data !== "string" ||
      Buffer.byteLength(data, "utf8") > 64 * 1024 ||
      (appendNewline !== undefined && typeof appendNewline !== "boolean") ||
      ((clientId !== undefined || presentedLeaseId !== undefined) &&
        (!validInputLeasePart(clientId, 128) || !validInputLeasePart(presentedLeaseId)))
    ) {
      reply.code(400).send({
        code: "INVALID_SESSION_INPUT",
        error: "data must be a string up to 64 KiB; clientId and leaseId must be supplied together",
      });
      return;
    }
    if (!terminalManager.get(request.params.id)) {
      reply.code(404).send({ code: "SESSION_NOT_FOUND", error: "session not found" });
      return;
    }
    const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
    if (!canWriteSession(principal, request.params.id)) {
      reply.code(403).send({
        code: "SESSION_OPERATE_FORBIDDEN",
        error: "your role can view but cannot operate this agent",
      });
      return;
    }
    let holderId: string;
    let leaseId: string;
    let releaseAfterWrite = false;
    if (typeof clientId === "string" && typeof presentedLeaseId === "string") {
      holderId = httpInputHolderId(principal, clientId);
      leaseId = presentedLeaseId;
      if (!inputLeases.canWrite(request.params.id, holderId, leaseId)) {
        reply.code(409).send({
          code: "INPUT_LEASE_REQUIRED",
          error: "this client does not own terminal input",
          lease: publicInputLease(request.params.id),
        });
        return;
      }
    } else {
      if (inputLeases.get(request.params.id)) {
        reply.code(409).send({
          code: "INPUT_LEASE_REQUIRED",
          error: "terminal input is controlled by another client; acquire a lease first",
          lease: publicInputLease(request.params.id),
        });
        return;
      }
      holderId = `api-once:${randomUUID()}`;
      const acquired = inputLeases.acquire(request.params.id, holderId, principal);
      if (acquired.status === "denied") {
        reply.code(409).send({ code: "INPUT_LEASE_REQUIRED", error: "terminal input is already controlled" });
        return;
      }
      leaseId = acquired.lease.id;
      releaseAfterWrite = true;
    }
    try {
      terminalManager.write(request.params.id, appendNewline === true ? `${data}\r` : data);
      if (!releaseAfterWrite) inputLeases.renew(request.params.id, holderId, leaseId);
    } finally {
      if (releaseAfterWrite) inputLeases.release(request.params.id, holderId, leaseId);
    }
    commandStore.appendEvent("session.input_sent", "session", request.params.id, {
      byteLength: Buffer.byteLength(data, "utf8"),
    });
    reply.code(202).send({ accepted: true, focused: false });
  });

  app.get<{ Params: { id: string } }>("/api/v1/agents/:id", async (request, reply) => {
    const existing = commandStore.getAgent(request.params.id);
    if (!existing) {
      reply.code(404).send({ code: "AGENT_NOT_FOUND", error: "agent not found" });
      return;
    }
    const live = terminalManager.get(existing.sessionId);
    const agent = live ? syncCommandAgent(live.id, live.status === "ended" ? "ended" : live.activity)?.agent : existing;
    return { agent: agent ?? existing };
  });

  app.get<{
    Params: { id: string };
    Querystring: { after?: string; timeoutMs?: string };
  }>("/api/v1/agents/:id/wait", async (request, reply) => {
    const initial = commandStore.getAgent(request.params.id);
    if (!initial) {
      reply.code(404).send({ code: "AGENT_NOT_FOUND", error: "agent not found" });
      return;
    }
    const after = request.query.after === undefined ? initial.updatedAt : Number(request.query.after);
    const timeoutMs = request.query.timeoutMs === undefined ? 30_000 : Number(request.query.timeoutMs);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 30_000
    ) {
      reply.code(400).send({ code: "INVALID_WAIT", error: "after and timeoutMs are invalid" });
      return;
    }
    if (initial.updatedAt > after || initial.activity !== "working" || timeoutMs === 0) {
      return { agent: initial, timedOut: initial.updatedAt <= after && initial.activity === "working" };
    }
    const outcome = await new Promise<{ agent: typeof initial; timedOut: boolean }>((resolve) => {
      let settled = false;
      const finish = (value: { agent: typeof initial; timedOut: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const unsubscribe = commandStore.subscribeEvents((event) => {
        if (event.resourceType !== "agent" || event.resourceId !== request.params.id) return;
        const agent = commandStore.getAgent(request.params.id);
        if (agent && (agent.updatedAt > after || agent.activity !== "working")) finish({ agent, timedOut: false });
      });
      const timer = setTimeout(() => {
        finish({ agent: commandStore.getAgent(request.params.id) ?? initial, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
    });
    reply.header("cache-control", "no-store").send(outcome);
  });

  app.post<{
    Params: { id: string };
    Body: { mode?: unknown };
  }>("/api/v1/agents/:id/focus", async (request, reply) => {
    const agent = commandStore.getAgent(request.params.id);
    const mode = request.body?.mode ?? "request";
    if (!agent) {
      reply.code(404).send({ code: "AGENT_NOT_FOUND", error: "agent not found" });
      return;
    }
    if (mode !== "request" && mode !== "activate") {
      reply.code(400).send({ code: "INVALID_FOCUS_MODE", error: "mode must be request or activate" });
      return;
    }
    commandStore.appendEvent(
      mode === "activate" ? "focus.activation_requested" : "focus.requested",
      "agent",
      agent.id,
      { sessionId: agent.sessionId, stealFocus: mode === "activate" },
    );
    reply.code(202).send({ accepted: true, mode, focused: false, agentId: agent.id, sessionId: agent.sessionId });
  });

  // Rename a session (server-side, so the name shows on EVERY device and survives restarts). Contract:
  // {name: string} trims + sets; an empty/whitespace-only string, null, or an absent field CLEARS back to
  // unnamed. 204 on success, 404 for an unknown id, 400 for a non-string/oversized name. Token-gated by
  // the global default-deny preHandler.
  const renameSessionHandler = async (
    request: FastifyRequest<{ Params: { id: string }; Body: { name?: unknown } }>,
    reply: FastifyReply,
  ) => {
    const { id } = request.params;
    if (!terminalManager.get(id)) {
      reply.code(404).send({ code: "SESSION_NOT_FOUND", error: "session not found" });
      return;
    }
    const raw = request.body?.name;
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      reply.code(400).send({ code: "INVALID_SESSION_NAME", error: "name must be a string or null" });
      return;
    }
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    // A UI label, not a document — cap it so a runaway client can't bloat every GET /sessions response.
    if (trimmed.length > 120) {
      reply.code(400).send({ code: "INVALID_SESSION_NAME", error: "name too long (max 120 characters)" });
      return;
    }
    terminalManager.setName(id, trimmed.length > 0 ? trimmed : undefined);
    reply.code(204).send();
  };
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/sessions/:id", renameSessionHandler);
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/api/v1/sessions/:id", renameSessionHandler);

  // Close a session: stop its live process AND remove it from the list + store. Idempotent — deleting an
  // unknown id is a 204 no-op, not a 404 — so a double-close / a stale client both succeed.
  const deleteSessionHandler = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    inputLeases.revoke(id);
    if (terminalManager.get(id)) terminalManager.stop(id);
    commandStore.removeSession(id);
    reply.code(204).send();
  };
  app.delete<{ Params: { id: string } }>("/sessions/:id", deleteSessionHandler);
  app.delete<{ Params: { id: string } }>("/api/v1/sessions/:id", deleteSessionHandler);

  // Legacy stop endpoint — kept working, converges on full removal (stop + delete). 404 only when the
  // session is already gone, preserving the old "stop a known session" contract.
  app.post<{ Params: { id: string } }>("/sessions/:id/stop", async (request, reply) => {
    const { id } = request.params;
    if (!terminalManager.get(id)) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    inputLeases.revoke(id);
    terminalManager.stop(id);
    commandStore.removeSession(id);
    return { ok: true };
  });

  // Claude sends a file/image to the terminal: the mcp-send stdio server (spawned as claude's subprocess)
  // POSTs here on a send_image/send_file tool call. The path is fsRoot+realpath-validated (no traversal,
  // no symlink escape — same defense as /fs/download); on success a control frame is pushed to the
  // terminal session over the existing WS. Token-gated by the global preHandler.
  app.post<{ Params: { id: string }; Body: { path?: string; caption?: string; kind?: "image" | "file" } }>(
    "/sessions/:id/attach",
    async (request, reply) => {
      const sessionId = request.params.id;
      if (!terminalManager.get(sessionId)) {
        reply.code(404).send({ error: "session not found" });
        return;
      }
      const body = request.body;
      if (!body || typeof body.path !== "string") {
        reply.code(400).send({ error: "path is required" });
        return;
      }
      const caption = typeof body.caption === "string" ? body.caption : undefined;
      let described: { name: string; isImage: boolean };
      let fileInfo: { size: number };
      try {
        described = await fsService.describeForAttachment(body.path);
        fileInfo = await fsService.describeFile(body.path);
      } catch (err) {
        if (err instanceof FsError) {
          reply.code(err.code === "forbidden" ? 403 : 404).send({ error: err.message });
        } else {
          reply.code(404).send({ error: (err as Error).message });
        }
        return;
      }
      // kind=image forces inline image rendering even for an unknown extension; kind=file forces a
      // download chip. Absent → infer from the extension (describeForAttachment.isImage).
      const isImage = body.kind === "image" ? true : body.kind === "file" ? false : described.isImage;
      const id = randomUUID();
      const now = Date.now();
      const media = attachmentMedia(described.name);
      const stored: StoredSessionFile = {
        id,
        sessionId,
        direction: "received",
        storage: "workspace",
        name: described.name,
        path: body.path,
        mimeType: media.mimeType,
        size: fileInfo.size,
        kind: isImage ? "image" : media.kind,
        ...(caption ? { caption } : {}),
        createdAt: now,
        updatedAt: now,
        expiresAt: now + TERMINAL_FILE_TTL_MS,
      };
      store.putFile(stored);
      // Push a control frame over the terminal WS (the client renders it in the Files panel). The manager
      // also BUFFERS this frame so a client that (re)connects later still sees the file (replay on attach).
      terminalManager.pushControl(sessionId, {
        t: "attach",
        ...publicSessionFile(stored),
      });
      // Away-from-desk: ping the phone that a file arrived. Fire-and-forget (dispatch never throws/blocks).
      if (!terminalManager.isAttached(sessionId)) {
        const meta = terminalManager.get(sessionId);
        const label = meta?.name?.trim() || (meta ? pathBasename(meta.cwd) : "Agent");
        recordAttentionForSession(
          sessionId,
          "file",
          `${label} shared a file`,
          `file:${sessionId}:${id}`,
          described.name,
        );
      }
      dispatchPush({ kind: "file", sessionId, detail: described.name });
      reply.code(200).send({ ok: true, id });
    },
  );

  // Deterministic "needs you" via claude's OWN hooks (per-session settings written by the spawn layer — see
  // config.buildHooksSettingsDocument). claude's `Stop` hook POSTs ?event=stop when it finishes a turn and is
  // now waiting on the user; `UserPromptSubmit` POSTs ?event=submit when you send a prompt. This REPLACES the
  // old terminal-output scraping, which couldn't tell "still working / waiting on a background agent" from
  // "waiting for you" and fired false positives. Token-gated by the global preHandler. The away-from-desk PUSH
  // fires only when nobody is watching (you're right there otherwise), and works even with the app CLOSED —
  // the hook runs inside claude regardless of any browser attachment.
  app.post<{ Params: { id: string }; Querystring: { event?: string } }>(
    "/sessions/:id/hook",
    async (request, reply) => {
      const sessionId = request.params.id;
      if (!terminalManager.get(sessionId)) {
        reply.code(404).send({ error: "session not found" });
        return;
      }
      // NOTE: these hooks NO LONGER drive `awaiting`. A `Stop` (a TURN finished) now means the session is
      // IDLE — a calm "your turn whenever" — NOT the loud "needs you", which is reserved for claude actually
      // BLOCKING on a decision (a permission or plan prompt). The capture-pane activity monitor
      // (TerminalManager.refreshActivity) is the sole authority for working/blocked/idle, so it can tell those
      // apart (incl. "main loop done but background agents still developing" = working). The route is kept so
      // existing sessions' hooks don't 404; it just validates the event.
      if (request.query.event !== "submit" && request.query.event !== "stop") {
        reply.code(400).send({ error: "unknown event" });
        return;
      }
      reply.code(200).send({ ok: true });
    },
  );

  // Web Push opt-in routes (spec §1). The whole `/push/*` namespace is token-gated by the global
  // preHandler (it is in API_PATH_DENYLIST), including GET /push/vapid — the PWA already holds the
  // token by the time it opts into push, so no special-casing is needed.
  app.get("/push/vapid", async (_request, reply) => {
    if (!deps.vapidPublicKey) {
      reply.code(404).send({ error: "push not configured" });
      return;
    }
    // SECURITY: return ONLY the public key. NEVER serialize the whole VapidKeys (the private key
    // must never reach a client).
    return { publicKey: deps.vapidPublicKey };
  });

  app.post<{ Body: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; sessionId?: string } }>(
    "/push/subscribe",
    async (request, reply) => {
      if (!deps.pushStore) {
        reply.code(404).send({ error: "push not configured" });
        return;
      }
      const b = request.body;
      if (
        !b ||
        typeof b.endpoint !== "string" ||
        typeof b.keys?.p256dh !== "string" ||
        typeof b.keys?.auth !== "string"
      ) {
        reply.code(400).send({ error: "endpoint + keys.p256dh + keys.auth are required" });
        return;
      }
      // SSRF guard: the server later POSTs to this endpoint (web-push). Require a well-formed HTTPS URL
      // so a client can't register an arbitrary/loopback target to make the server issue requests to it.
      let endpointUrl: URL;
      try {
        endpointUrl = new URL(b.endpoint);
      } catch {
        reply.code(400).send({ error: "endpoint must be a valid URL" });
        return;
      }
      if (endpointUrl.protocol !== "https:") {
        reply.code(400).send({ error: "endpoint must be an https: URL" });
        return;
      }
      if (isDisallowedPushHost(endpointUrl.hostname)) {
        reply.code(400).send({ error: "endpoint host is not allowed" });
        return;
      }
      const presented = extractBearerToken(request.headers.authorization);
      const deviceId = presented ? deviceStore.authenticate(presented)?.id : undefined;
      deps.pushStore.upsert({
        endpoint: b.endpoint,
        p256dh: b.keys.p256dh,
        auth: b.keys.auth,
        sessionId: typeof b.sessionId === "string" ? b.sessionId : undefined,
        ...(deviceId ? { deviceId } : {}),
        createdAt: Date.now(),
      });
      reply.code(201).send({ ok: true });
    },
  );

  app.post<{ Body: { endpoint?: string } }>("/push/unsubscribe", async (request, reply) => {
    if (!deps.pushStore) {
      reply.code(404).send({ error: "push not configured" });
      return;
    }
    const endpoint = request.body?.endpoint;
    if (typeof endpoint !== "string") {
      reply.code(400).send({ error: "endpoint is required" });
      return;
    }
    deps.pushStore.remove(endpoint);
    return { ok: true };
  });

  // POST /push/test → send a harmless "notifications are working ✓" ping to EVERY stored subscription (the
  // dispatcher fans a session-less "test" event to all subs). Powers the web Settings "Send test
  // notification" button so a user can confirm delivery end-to-end. Always 200; the body's `ok` says whether
  // it went out. Reasons: push isn't configured (no dispatcher/store) or there are no subscriptions yet.
  // Token-gated by the global preHandler (the whole /push/* namespace is in API_PATH_DENYLIST).
  app.post("/push/test", async (_request, reply) => {
    const { pushDispatcher, pushStore } = deps;
    if (!pushDispatcher || !pushStore) {
      reply.code(200).send({ ok: false, reason: "push not configured" });
      return;
    }
    // No subscriptions → nothing to deliver to; tell the client so it can prompt the user to enable push.
    let subCount = 0;
    try {
      subCount = pushStore.list().length;
    } catch {
      // a store read failure is treated as "no subs" — never 500 a diagnostic button
    }
    if (subCount === 0) {
      reply.code(200).send({ ok: false, reason: "no push subscriptions" });
      return;
    }
    // Fire-and-forget-ish: dispatch never throws (dead subs are pruned on 404/410). We don't inspect
    // per-endpoint results — a 200 { ok:true } means "we attempted delivery to your subscriptions".
    await pushDispatcher.dispatch({ kind: "test" });
    reply.code(200).send({ ok: true });
  });

  // OTA self-update (token-gated by the global preHandler).
  // GET /version → the cached check {current,latest,behind,updatable,updateAvailable,changelog}.
  app.get("/version", async (request, reply) => {
    try {
      // `?force=1` bypasses the cached GitHub Releases check.
      const force = (request.query as { force?: string } | undefined)?.force === "1";
      const version = await updater.getVersion(force);
      return { ...version, terminalAvailable };
    } catch (err) {
      // A feed/spawn failure must not 500 the open-on-load probe; expose a degraded version snapshot.
      reply.code(200).send({
        current: "—",
        latest: "—",
        behind: 0,
        updatable: false,
        updateAvailable: false,
        changelog: [],
        runningVersion: RUNNING_VERSION,
        runningBuild: RUNNING_VERSION,
        buildDrift: false,
        installDrift: false,
        releaseCount: 0,
        updateAction: "none",
        installation: "unmanaged",
        rollbackAvailable: false,
        checkStatus: "error",
        terminalAvailable,
        error: (err as Error).message,
      });
    }
  });

  // POST /update {confirm:true,target?} → verify and install the exact stable version. The confirm flag
  // is a deliberate double-gate (alongside the token) for a server-restarting action.
  app.post<{ Body: { confirm?: boolean; target?: string } }>("/update", async (request, reply) => {
    if (request.body?.confirm !== true) {
      reply.code(400).send({ error: "confirm:true is required to apply an update" });
      return;
    }
    let result;
    try {
      result = await updater.startUpdate({ targetVersion: request.body?.target });
    } catch (err) {
      reply.code(409).send({ error: (err as Error).message });
      return;
    }
    if (!result.started) {
      reply.code(409).send({ error: result.reason ?? "update not available" });
      return;
    }
    reply.code(202).send({ ok: true, state: "starting", operationId: result.operationId, target: result.target });
  });

  // GET /update/status → the detached updater's status file {state,phase,error?,target?,log?}.
  app.get("/update/status", async () => {
    return updater.readStatus();
  });

  // POST /update/rollback swaps the managed runtime to the previously verified release. No git state is
  // touched; the same boot-smoke + atomic pointer + restart pipeline is used.
  app.post<{ Body: { confirm?: boolean } }>("/update/rollback", async (request, reply) => {
    if (request.body?.confirm !== true) {
      reply.code(400).send({ error: "confirm:true is required to roll back" });
      return;
    }
    const targetVersion = updater.readLastGoodVersion();
    if (!targetVersion) {
      reply.code(409).send({ error: "no previous managed version is available" });
      return;
    }
    let result;
    try {
      result = await updater.startUpdate({ rollback: true });
    } catch (err) {
      reply.code(409).send({ error: (err as Error).message });
      return;
    }
    if (!result.started) {
      reply.code(409).send({ error: result.reason ?? "rollback not available" });
      return;
    }
    reply.code(202).send({
      ok: true,
      state: "starting",
      operationId: result.operationId,
      target: result.target ?? targetVersion,
    });
  });

  // GET /diag → authed fleet-observability snapshot (token-gated by the global preHandler; distinct from
  // the minimal unauthenticated /health). Reports the running/active version relationship,
  // storeMode (sqlite vs the non-durable memory fallback), best-effort claude availability+version
  // (cached; never blocks long), node version, and the last update state. Never 500s — each field degrades
  // independently so one failing probe can't take down the whole diagnostic.
  app.get("/diag", async () => {
    let installDrift = false;
    let current = "—";
    try {
      const v = await updater.getVersion();
      installDrift = v.installDrift;
      current = v.current;
    } catch {
      // a release-feed failure must not 500 /diag — leave the defaults
    }
    let claude: { available: boolean; version?: string };
    try {
      claude = await claudeVersionProbe.get();
    } catch {
      claude = { available: false };
    }
    return {
      current,
      runningVersion: RUNNING_VERSION,
      runningBuild: RUNNING_VERSION,
      installDrift,
      buildDrift: installDrift,
      storeMode,
      claude,
      providers: await readProviderAvailability(),
      node: process.version,
      update: updater.readStatus(),
    };
  });

  // POST /token/rotate → rotate the single access token (authed; token-gated by the global preHandler,
  // and in API_PATH_DENYLIST). Generates a fresh CSPRNG token (data-dir.ts's generator), persists it to
  // the same 0600 token file, atomically swaps it into the live AuthGate (the OLD token is rejected the
  // instant this returns — every later request must present the new one), and returns it ONCE in the body
  // so the client can re-store it.
  // NOTE: rotation requires a persistable token file — it's unavailable in tokenless (NO_TOKEN) loopback
  // dev (no token is configured); a rotate there is a 409. There's no in-memory rotate of a config-injected
  // ACCESS_TOKEN: an env-set token reappears on restart, so we persist + swap and report that caveat.
  app.post("/token/rotate", async (_request, reply) => {
    if (!config.accessToken) {
      reply.code(409).send({ error: "token rotation is unavailable when no access token is configured" });
      return;
    }
    // Generate a fresh CSPRNG token (injectable for tests) and persist it to the same 0600 token file so
    // the on-disk secret stays authoritative across a restart.
    let next: string;
    try {
      next = (deps.generateToken ?? generateAccessToken)();
      persistAccessToken(dataDir, next);
    } catch (err) {
      reply.code(500).send({ error: `failed to persist rotated token: ${(err as Error).message}` });
      return;
    }
    // Swap into the live gate; the OLD token is rejected from here on. Keep `config.accessToken` coherent
    // so anything that re-reads it sees the new secret. CAVEAT (inherent to the single-token model): an
    // mcp-send subprocess ALREADY running holds the old token in its per-session 0600 config, so its next
    // callback would 401 until the session respawns; new spawns pick up the persisted token. The client
    // must re-store the returned token (the web side updates token-store on a rotate response).
    authGate.rotateToken(next);
    config.accessToken = next;
    reply.code(200).send({ token: next });
  });

  app.post<{ Body: { confirm?: unknown } }>("/access/reset", async (request, reply) => {
    if (request.body?.confirm !== true) {
      reply.code(400).send({ code: "RESET_CONFIRMATION_REQUIRED", error: "explicit reset confirmation is required" });
      return;
    }
    if (!config.accessToken) {
      reply.code(409).send({ code: "TOKENLESS_MODE", error: "access reset is unavailable without a host token" });
      return;
    }
    const presented = extractBearerToken(request.headers.authorization);
    if (!authGate.isCurrentHostToken(presented)) {
      reply.code(403).send({ code: "HOST_CREDENTIAL_REQUIRED", error: "the host recovery credential is required" });
      return;
    }
    let next: string;
    try {
      next = (deps.generateToken ?? generateAccessToken)();
      persistAccessToken(dataDir, next);
    } catch (error) {
      reply
        .code(500)
        .send({ code: "RESET_PERSIST_FAILED", error: `failed to persist reset: ${(error as Error).message}` });
      return;
    }
    const revokedDeviceIds = deviceStore.list().map((device) => device.id);
    const revokedDevices = deviceStore.revokeAll();
    for (const actorId of [...remotePrincipalSockets.keys()]) closeRemotePrincipalSockets(actorId);
    for (const deviceId of revokedDeviceIds) notifyDeviceRevoked(deviceId);
    for (const subscription of deps.pushStore?.list() ?? []) deps.pushStore?.remove(subscription.endpoint);
    authGate.resetToken(next);
    config.accessToken = next;
    commandStore.appendEvent("access.reset", "host", commandStore.getHost().id, { revokedDevices });
    reply.header("cache-control", "no-store").send({ token: next, revokedDevices });
  });

  // POST /ws-ticket → { ticket, expiresInMs }: a single-use, ~30s credential for the terminal WS URL
  // (`?ticket=<t>`), so the LONG-LIVED token never has to ride in a WS query string (query strings are
  // routinely written into proxy/access logs). Token-gated by the global default-deny preHandler — only
  // a client that already holds the real token can mint tickets. Consumed (and thus dead) by the very
  // upgrade that presents it; see the preHandler + ws-ticket.ts.
  app.post("/ws-ticket", async (request) => wsTickets.issue(authenticatedPrincipals.get(request) ?? hostPrincipal()));

  const providerFrom = (raw: string): ProviderId | undefined => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(raw)) return undefined;
    try {
      providers.get(raw);
      return raw;
    } catch {
      return undefined;
    }
  };
  const unknownProvider = (reply: FastifyReply): void => {
    reply.code(404).send({ code: "PROVIDER_NOT_FOUND", error: "Provider not found" });
  };
  const metadataUnavailable = (reply: FastifyReply): void => {
    reply.code(503).send({ code: "PROVIDER_METADATA_UNAVAILABLE", error: "Provider metadata is unavailable" });
  };
  const claudeVersion = async () => {
    const [installed, latest] = await Promise.all([
      claudeVersionProbe
        .get()
        .then((v) => v.version ?? null)
        .catch(() => null),
      deps.claudeLatest ? deps.claudeLatest.getLatest().then((v) => v ?? null) : Promise.resolve(null),
    ]);
    return { installed, latest };
  };
  const claudeUsage = async () => ({ usage: deps.usage ? await deps.usage.getUsage() : null });
  const claudeAuthStatus = async (reply?: FastifyReply) => {
    if (!deps.claudeAuth) return { available: false as const };
    try {
      return { available: true as const, ...(await deps.claudeAuth.status()) };
    } catch {
      if (reply) return metadataUnavailable(reply);
      return { available: false as const };
    }
  };
  const startClaudeLogin = async (reply: FastifyReply) => {
    if (!deps.claudeAuth) return metadataUnavailable(reply);
    try {
      return await deps.claudeAuth.startLogin();
    } catch {
      return metadataUnavailable(reply);
    }
  };
  const cancelClaudeLogin = () => {
    deps.claudeAuth?.cancel();
    return { ok: true as const };
  };

  const readProviderAvailability = async (): Promise<Record<string, ProviderAvailability>> => {
    const capabilityByProvider: Record<string, ProviderAvailability> = {};
    const registered = providers.list();
    await Promise.all(
      registered.map(async (provider) => {
        let availability: ProviderAvailability;
        try {
          availability = providers.isEnabled(provider.id)
            ? await provider.probe()
            : { terminalAvailable: false, metadataAvailable: false, detail: "adapter disabled" };
        } catch {
          availability = { terminalAvailable: false, metadataAvailable: false };
        }
        availability = normalizeProviderAvailability(terminalAvailable, availability);
        if (provider.id === "codex" && availability.terminalAvailable) {
          let metadataAvailable = false;
          try {
            metadataAvailable = Boolean(
              deps.codexMetadata && deps.codexCapabilityProbe && (await deps.codexCapabilityProbe.get()),
            );
          } catch {
            metadataAvailable = false;
          }
          availability = normalizeProviderAvailability(terminalAvailable, availability, metadataAvailable);
        }
        capabilityByProvider[provider.id] = availability;
      }),
    );
    return capabilityByProvider;
  };

  const currentNodeOwner = (): OwnerRef => {
    if (deps.nodeOwner) return { ...deps.nodeOwner };
    // TeamStore is an authorization overlay for a self-hosted Node, not an ownership transfer. Ownership moves
    // only when provisioning supplies an explicit nodeOwner (for example a managed-cloud organization), so merely
    // creating a local team can never hide personal automations or silently change product context.
    return { type: "person", id: commandStore.getHost().id };
  };
  const currentNode = () =>
    projectNodeRecord({
      host: commandStore.getHost(),
      owner: currentNodeOwner(),
      status: terminalAvailable ? "online" : "degraded",
      platform: `${process.platform}-${process.arch}`,
      lastSeenAt: Date.now(),
      aliases: deps.nodeAliases,
    });
  const currentProductContext = () => {
    const owner = currentNodeOwner();
    const ownerName =
      deps.nodeOwnerName ??
      (owner.type === "organization" ? (teamStore.getTeam()?.name ?? "Organization") : "Personal");
    return productContextFromOwner(owner, ownerName);
  };
  const sendNodeNotFound = (reply: FastifyReply): void => {
    reply.code(404).send({ code: "NODE_NOT_FOUND", error: "node not found" });
  };
  const isCurrentNode = (nodeId: string): boolean => nodeId === commandStore.getHost().id;
  const resolveAgentRuntime = (nodeId: string, runtimeId: unknown) => {
    if (typeof runtimeId !== "string") return undefined;
    const descriptor = providers.descriptors().find((candidate) => agentRuntimeId(nodeId, candidate.id) === runtimeId);
    return descriptor ? { id: runtimeId, nodeId, provider: descriptor.id, descriptor } : undefined;
  };
  const readAgentRuntimeAuthStates = async (): Promise<Record<string, AgentRuntimeAuthState>> => {
    const states: Record<string, AgentRuntimeAuthState> = {};
    if (deps.claudeAuth && providers.source("claude") !== undefined) {
      try {
        states.claude = (await deps.claudeAuth.status()).loggedIn ? "ready" : "required";
      } catch {
        states.claude = "error";
      }
    }
    if (deps.codexMetadata && providers.source("codex") !== undefined) {
      try {
        states.codex = (await deps.codexMetadata.getAccount()).authenticated ? "ready" : "required";
      } catch {
        states.codex = "error";
      }
    }
    return states;
  };
  const readCurrentNodeRuntimes = async () => {
    const nodeId = commandStore.getHost().id;
    const activeSessionCountByProvider: Record<string, number> = {};
    for (const session of terminalManager.list()) {
      if (session.status !== "running") continue;
      activeSessionCountByProvider[session.provider] = (activeSessionCountByProvider[session.provider] ?? 0) + 1;
    }
    const [availabilityByProvider, authStateByProvider] = await Promise.all([
      readProviderAvailability(),
      readAgentRuntimeAuthStates(),
    ]);
    return projectAgentRuntimeRecords({
      nodeId,
      descriptors: providers.descriptors(),
      availabilityByProvider,
      authStateByProvider,
      activeSessionCountByProvider,
      additionalCapabilitiesByProvider: {
        claude: ["task-bootstrap", ...(deps.claudeAuth ? ["authentication"] : [])],
        codex: ["task-bootstrap", ...(deps.codexMetadata ? ["authentication"] : [])],
      },
      observedAt: Date.now(),
    });
  };
  const projectV2Session = (session: ReturnType<typeof sessionSnapshots>[number]) => {
    const { workspaceId, agentId, agentActivity, ...publicSession } = session;
    void workspaceId;
    void agentId;
    void agentActivity;
    const automationRun = sessionAutomationStore.getRunBySessionId(session.id);
    return {
      ...publicSession,
      nodeId: commandStore.getHost().id,
      agentRuntimeId: agentRuntimeId(commandStore.getHost().id, session.provider),
      ...(automationRun
        ? {
            automation: {
              id: automationRun.automationId,
              runId: automationRun.id,
              status: projectAutomationRun(automationRun).status,
            },
          }
        : {}),
    };
  };
  const ownedAutomation = (id: string): SessionAutomationDefinition | undefined => {
    const automation = sessionAutomationStore.get(id);
    const owner = currentNodeOwner();
    return automation && automation.owner.type === owner.type && automation.owner.id === owner.id
      ? automation
      : undefined;
  };
  const ownedAutomationIncludingRemoved = (id: string): SessionAutomationDefinition | undefined => {
    const automation = sessionAutomationStore.getIncludingRemoved(id);
    const owner = currentNodeOwner();
    return automation && automation.owner.type === owner.type && automation.owner.id === owner.id
      ? automation
      : undefined;
  };
  const projectAutomationDefinition = (automation: SessionAutomationDefinition) => ({
    ...automation,
    triggers: automation.triggers.map((trigger) => {
      if (trigger.type !== "webhook") return trigger;
      const { secretHash, ...publicTrigger } = trigger;
      void secretHash;
      return publicTrigger;
    }),
  });
  const newTriggerId = (): string => `rct_${randomBytes(12).toString("base64url")}`;
  const newWebhookHookId = (): string => `rcwh_${randomBytes(24).toString("base64url")}`;
  const newWebhookSecret = (): string => `rcws_${randomBytes(32).toString("base64url")}`;
  const prepareAutomationTriggers = (
    value: unknown,
    current: SessionAutomationDefinition | undefined,
  ): {
    triggers: SessionAutomationConfiguredTrigger[];
    webhookSecrets: Array<{ triggerId: string; hookId: string; secret: string; path: string }>;
  } => {
    if (!Array.isArray(value) || value.length > 16) throw new Error("invalid automation triggers");
    const existing = new Map(current?.triggers.map((trigger) => [trigger.id, trigger]) ?? []);
    const ids = new Set<string>();
    const webhookSecrets: Array<{ triggerId: string; hookId: string; secret: string; path: string }> = [];
    const triggers = value.map((candidate): SessionAutomationConfiguredTrigger => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("invalid automation trigger");
      }
      const raw = candidate as Record<string, unknown>;
      const requestedId = typeof raw.id === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(raw.id) ? raw.id : undefined;
      const id = requestedId ?? newTriggerId();
      if (ids.has(id)) throw new Error("duplicate automation trigger id");
      ids.add(id);
      if (typeof raw.enabled !== "boolean") throw new Error("invalid automation trigger state");
      if (raw.type === "schedule") {
        if (
          typeof raw.cron !== "string" ||
          typeof raw.timeZone !== "string" ||
          raw.timeZone.length > 80 ||
          raw.missedRunPolicy !== "skip" ||
          Object.keys(raw).some(
            (key) => !["id", "type", "enabled", "cron", "timeZone", "missedRunPolicy"].includes(key),
          )
        ) {
          throw new Error("invalid schedule trigger");
        }
        new Intl.DateTimeFormat("en-US", { timeZone: raw.timeZone }).format(0);
        return {
          id,
          type: "schedule",
          enabled: raw.enabled,
          cron: validateCronExpression(raw.cron),
          timeZone: raw.timeZone,
          missedRunPolicy: "skip",
        };
      }
      if (raw.type === "webhook") {
        if (Object.keys(raw).some((key) => !["id", "type", "enabled", "hookId"].includes(key))) {
          throw new Error("invalid webhook trigger");
        }
        const previous = existing.get(id);
        if (previous?.type === "webhook") {
          if (raw.hookId !== undefined && raw.hookId !== previous.hookId) {
            throw new Error("webhook identity cannot be replaced");
          }
          return { ...previous, enabled: raw.enabled };
        }
        const hookId = newWebhookHookId();
        const secret = newWebhookSecret();
        webhookSecrets.push({ triggerId: id, hookId, secret, path: `/api/v2/automation-hooks/${hookId}` });
        return {
          id,
          type: "webhook",
          enabled: raw.enabled,
          hookId,
          secretHash: createHash("sha256").update(secret).digest("hex"),
        };
      }
      throw new Error("invalid automation trigger");
    });
    return { triggers, webhookSecrets };
  };
  const automationInvocationIdentity = (
    request: FastifyRequest,
    automationId: string,
  ): { invocationId: string; sessionId: string } => {
    const idempotency = mutationContexts.get(request)?.idempotency;
    if (!idempotency) return { invocationId: randomUUID(), sessionId: randomUUID() };
    const actor = actorForRequest(request);
    const digest = createHash("sha256")
      .update("roamcode-automation-invocation-v1\0")
      .update(JSON.stringify([actor.actorType, actor.actorId, idempotency.key, idempotency.fingerprint, automationId]))
      .digest("hex");
    const uuidHex = digest.slice(0, 32).split("");
    uuidHex[12] = "5";
    uuidHex[16] = ((Number.parseInt(uuidHex[16]!, 16) & 0x3) | 0x8).toString(16);
    const compact = uuidHex.join("");
    return {
      invocationId: `rci_${digest.slice(0, 48)}`,
      sessionId: `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`,
    };
  };
  const projectAutomationRun = (run: SessionAutomationRun): SessionAutomationRun => {
    if (run.status === "failed" || run.status === "cancelled") return run;
    const session = terminalManager.get(run.sessionId);
    const projectLiveStatus = (): Exclude<SessionAutomationRun["status"], "starting" | "failed"> =>
      !session
        ? "cancelled"
        : session.status === "ended"
          ? "ready"
          : session.activity === "blocked"
            ? "needs-input"
            : session.activity === "idle"
              ? "ready"
              : "running";
    if (run.status === "starting") {
      // A live tmux Session proves only that process creation succeeded, not that the instruction reached its PTY.
      // The private bootstrap journal is the authority; promoting `starting` from terminal activity alone creates a
      // false-success window after a crash between durable Run creation and task submission.
      if (session) {
        const snapshot = sessionAutomationStore.getRunInputSnapshot(run.id);
        if (snapshot?.bootstrapState === "submitted") {
          const status = projectLiveStatus();
          return sessionAutomationStore.setRunStatus(run.id, status) ?? { ...run, status };
        }
        return run;
      }
      if (Date.now() - run.createdAt <= 60_000) return run;
      return (
        sessionAutomationStore.markRunFailed(run.id, "AUTOMATION_START_INTERRUPTED") ?? {
          ...run,
          status: "failed",
          failureCode: "AUTOMATION_START_INTERRUPTED",
        }
      );
    }
    const status = projectLiveStatus();
    if (status === run.status) return run;
    return sessionAutomationStore.setRunStatus(run.id, status) ?? { ...run, status };
  };
  const validObjectBody = (body: unknown): body is Record<string, unknown> =>
    typeof body === "object" && body !== null && !Array.isArray(body);
  const hasOnlyKeys = (body: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
    Object.keys(body).every((key) => allowed.has(key));
  const sendInvalidAutomation = (reply: FastifyReply, error = "invalid automation request"): void => {
    reply.code(400).send({ code: "INVALID_SESSION_AUTOMATION", error });
  };
  const validateAutomationTarget = async (
    nodeId: unknown,
    runtimeId: unknown,
    cwd: unknown,
    runtimeOptions: unknown,
    reply: FastifyReply,
    options: { requireReadyAuth?: boolean } = {},
  ): Promise<
    | {
        nodeId: string;
        agentRuntimeId: string;
        provider: string;
        cwd: string;
        runtimeOptions: Record<string, unknown>;
      }
    | undefined
  > => {
    if (typeof nodeId !== "string" || !isCurrentNode(nodeId)) {
      sendNodeNotFound(reply);
      return;
    }
    const runtime = resolveAgentRuntime(nodeId, runtimeId);
    if (!runtime) {
      reply.code(404).send({ code: "AGENT_RUNTIME_NOT_FOUND", error: "agent runtime not found" });
      return;
    }
    if (runtime.provider !== "claude" && runtime.provider !== "codex") {
      reply.code(409).send({
        code: "AUTOMATION_RUNTIME_UNSUPPORTED",
        error: "agent runtime does not support task bootstrap",
      });
      return;
    }
    if (options.requireReadyAuth) {
      const authState = (await readAgentRuntimeAuthStates())[runtime.provider] ?? "unknown";
      if (authState === "required" || authState === "error") {
        reply.code(409).send({
          code: authState === "required" ? "AGENT_RUNTIME_AUTH_REQUIRED" : "AGENT_RUNTIME_AUTH_UNAVAILABLE",
          error:
            authState === "required"
              ? "agent runtime must be authenticated on its Node before this automation can run"
              : "agent runtime authentication state could not be verified",
        });
        return;
      }
    }
    if (typeof cwd !== "string") {
      sendInvalidAutomation(reply, "cwd is required");
      return;
    }
    const resolvedCwd = resolvePath(cwd);
    try {
      const cwdStat = await stat(resolvedCwd);
      if (!cwdStat.isDirectory()) throw new Error("not a directory");
    } catch {
      sendInvalidAutomation(reply, "automation cwd must be an existing directory");
      return;
    }
    const rawOptions = runtimeOptions ?? {};
    let parsedOptions: ProviderSessionOptions;
    try {
      parsedOptions = parseProviderOptions(
        runtime.provider,
        rawOptions,
        providers.manifest(runtime.provider).optionSchema,
      );
      for (const dir of parsedOptions.addDirs ?? []) {
        const dirStat = await stat(dir);
        if (!dirStat.isDirectory()) throw new Error("not a directory");
      }
    } catch {
      sendInvalidAutomation(reply, "invalid runtime options");
      return;
    }
    return {
      nodeId,
      agentRuntimeId: runtime.id,
      provider: runtime.provider,
      cwd: resolvedCwd,
      runtimeOptions: JSON.parse(JSON.stringify(rawOptions)) as Record<string, unknown>,
    };
  };

  app.get("/api/v2/context", async () => ({ context: currentProductContext() }));

  app.get("/api/v2/nodes", async () => ({ nodes: [currentNode()] }));

  app.get<{ Params: { nodeId: string } }>("/api/v2/nodes/:nodeId", async (request, reply) => {
    if (!isCurrentNode(request.params.nodeId)) return sendNodeNotFound(reply);
    return { node: currentNode() };
  });

  app.get<{ Params: { nodeId: string } }>("/api/v2/nodes/:nodeId/runtimes", async (request, reply) => {
    if (!isCurrentNode(request.params.nodeId)) return sendNodeNotFound(reply);
    return { runtimes: await readCurrentNodeRuntimes() };
  });

  app.get<{ Params: { nodeId: string } }>("/api/v2/nodes/:nodeId/sessions", async (request, reply) => {
    if (!isCurrentNode(request.params.nodeId)) return sendNodeNotFound(reply);
    return { sessions: sessionSnapshots().map(projectV2Session) };
  });

  app.post<{ Params: { nodeId: string }; Body: CreateNodeSessionBody }>(
    "/api/v2/nodes/:nodeId/sessions",
    async (request, reply) => {
      if (!isCurrentNode(request.params.nodeId)) return sendNodeNotFound(reply);
      const body = request.body;
      if (
        !validObjectBody(body) ||
        !hasOnlyKeys(body, new Set(["agentRuntimeId", "cwd", "runtimeOptions"])) ||
        typeof body.cwd !== "string" ||
        (body.runtimeOptions !== undefined && !validObjectBody(body.runtimeOptions))
      ) {
        reply.code(400).send({ code: "INVALID_NODE_SESSION", error: "invalid node session request" });
        return;
      }
      const runtime = resolveAgentRuntime(request.params.nodeId, body.agentRuntimeId);
      if (!runtime) {
        reply.code(404).send({ code: "AGENT_RUNTIME_NOT_FOUND", error: "agent runtime not found" });
        return;
      }
      await launchSession(
        request,
        reply,
        {
          provider: runtime.provider,
          cwd: body.cwd,
          options: body.runtimeOptions ?? {},
        },
        { nodeId: request.params.nodeId, agentRuntimeId: runtime.id },
      );
    },
  );

  const nodeAccessBindings = (nodeId: string) =>
    teamStore
      .listRoleBindings()
      .filter(
        (binding) =>
          (binding.scopeType === "team" || (binding.scopeType === "host" && binding.scopeId === nodeId)) &&
          (binding.role === "viewer" ||
            binding.role === "operator" ||
            binding.role === "node-admin" ||
            binding.role === "organization-admin"),
      );

  const projectCloudNodeAccessGrants = (nodeId: string) => {
    const snapshot = deps.cloudAuthorizationStore?.getActiveSnapshot();
    if (!snapshot) return [];
    return snapshot.grants.flatMap((grant, index) => {
      if (
        (grant.scope.type !== "organization" && !(grant.scope.type === "host" && grant.scope.id === snapshot.hostId)) ||
        (!grant.permissions.includes("sessions:read") &&
          !grant.permissions.includes("sessions:operate") &&
          !grant.permissions.includes("node-access:manage"))
      ) {
        return [];
      }
      const role = grant.permissions.includes("node-access:manage")
        ? "admin"
        : grant.permissions.includes("sessions:operate")
          ? "operator"
          : "viewer";
      return [
        {
          id: `cloud_${snapshot.revision}_${index}`,
          nodeId,
          subject: { type: grant.principalType, id: grant.principalId },
          role,
          permissions: [...grant.permissions].sort(),
          source: "cloud" as const,
          mutable: false,
          revision: snapshot.revision,
        },
      ];
    });
  };

  const projectNodeAccessGrant = (nodeId: string, binding: ReturnType<TeamStore["listRoleBindings"]>[number]) => {
    const member = teamStore.getMember(binding.memberId);
    const permissions = teamRolePermissions(binding.role);
    const role =
      binding.role === "organization-admin" || binding.role === "node-admin"
        ? "admin"
        : permissions.includes("sessions:operate")
          ? "operator"
          : "viewer";
    return {
      id: binding.id,
      nodeId,
      subject: {
        type: "member" as const,
        id: binding.memberId,
        ...(member ? { displayName: member.displayName } : {}),
      },
      role,
      permissions: [...permissions].sort(),
      source: "team" as const,
      mutable: binding.scopeType === "host" && binding.scopeId === nodeId && binding.role !== "organization-admin",
    };
  };

  app.get<{ Params: { nodeId: string } }>("/api/v2/nodes/:nodeId/access-grants", async (request, reply) => {
    if (!isCurrentNode(request.params.nodeId)) return sendNodeNotFound(reply);
    if (deps.managedAuthorization || deps.cloudAuthorizationStore) {
      return { grants: projectCloudNodeAccessGrants(request.params.nodeId) };
    }
    return {
      grants: nodeAccessBindings(request.params.nodeId).map((binding) =>
        projectNodeAccessGrant(request.params.nodeId, binding),
      ),
    };
  });

  app.post<{
    Params: { nodeId: string };
    Body: { subject?: unknown; role?: unknown };
  }>("/api/v2/nodes/:nodeId/access-grants", async (request, reply) => {
    if (!isCurrentNode(request.params.nodeId)) return sendNodeNotFound(reply);
    if (deps.managedAuthorization || deps.cloudAuthorizationStore) {
      reply.code(409).send({
        code: "CLOUD_AUTHORITY_REQUIRED",
        error: "managed Node access must be changed in organization People & Access",
      });
      return;
    }
    const body = request.body;
    const subject = validObjectBody(body?.subject) ? body.subject : undefined;
    if (
      !body ||
      !hasOnlyKeys(body as unknown as Record<string, unknown>, new Set(["subject", "role"])) ||
      !subject ||
      !hasOnlyKeys(subject, new Set(["type", "id"])) ||
      subject.type !== "member" ||
      !validTeamApiId(subject.id) ||
      (body.role !== "viewer" && body.role !== "operator" && body.role !== "admin")
    ) {
      reply.code(400).send({ code: "INVALID_NODE_ACCESS_GRANT", error: "valid subject and node role are required" });
      return;
    }
    if (!teamStore.getMember(subject.id)) {
      reply.code(404).send({ code: "NODE_ACCESS_SUBJECT_NOT_FOUND", error: "node access subject not found" });
      return;
    }
    try {
      const binding = teamStore.setNodeAccessRole({
        memberId: subject.id,
        role: body.role === "admin" ? "node-admin" : body.role,
        nodeId: request.params.nodeId,
      });
      commandStore.appendEvent("node.access_granted", "host", request.params.nodeId, {
        role: binding.role,
        scopeType: binding.scopeType,
      });
      reply.code(201).send({ grant: projectNodeAccessGrant(request.params.nodeId, binding) });
    } catch (error) {
      sendTeamError(reply, error);
    }
  });

  app.delete<{ Params: { nodeId: string; grantId: string } }>(
    "/api/v2/nodes/:nodeId/access-grants/:grantId",
    async (request, reply) => {
      if (!isCurrentNode(request.params.nodeId)) return sendNodeNotFound(reply);
      if (deps.managedAuthorization || deps.cloudAuthorizationStore) {
        reply.code(409).send({
          code: "CLOUD_AUTHORITY_REQUIRED",
          error: "managed Node access must be changed in organization People & Access",
        });
        return;
      }
      const existing = teamStore
        .listRoleBindings()
        .find(
          (binding) =>
            binding.id === request.params.grantId &&
            binding.scopeType === "host" &&
            binding.scopeId === request.params.nodeId &&
            (binding.role === "viewer" || binding.role === "operator" || binding.role === "node-admin"),
        );
      if (!existing || !teamStore.revokeRole(existing.id)) {
        reply.code(404).send({ code: "NODE_ACCESS_GRANT_NOT_FOUND", error: "node access grant not found" });
        return;
      }
      for (const principal of teamStore.listPrincipalBindings(existing.memberId)) {
        inputLeases.revokeActor(principal.actorType, principal.actorId);
        presence.releaseActor(principal);
        if (principal.actorType === "device" || principal.actorType === "relay") {
          closeRemotePrincipalSockets(principal.actorId, "node access revoked");
        }
      }
      commandStore.appendEvent("node.access_revoked", "host", request.params.nodeId, {});
      reply.code(204).send();
    },
  );

  const automationCreateKeys = new Set([
    "name",
    "enabled",
    "nodeId",
    "agentRuntimeId",
    "cwd",
    "instruction",
    "runtimeOptions",
    "trigger",
    "triggers",
  ]);
  const automationUpdateKeys = new Set([...automationCreateKeys, "expectedRevision"]);

  app.get("/api/v2/automations", async () => ({
    automations: sessionAutomationStore.list(currentNodeOwner()).map(projectAutomationDefinition),
  }));

  app.post<{ Body: unknown }>("/api/v2/automations", { bodyLimit: 128 * 1024 }, async (request, reply) => {
    if (!validObjectBody(request.body)) return sendInvalidAutomation(reply);
    if ("owner" in request.body || "provider" in request.body) {
      reply.code(400).send({
        code: "SERVER_ASSIGNED_AUTOMATION_FIELD",
        error: "automation owner and provider are server assigned",
      });
      return;
    }
    if (!hasOnlyKeys(request.body, automationCreateKeys)) return sendInvalidAutomation(reply);
    const target = await validateAutomationTarget(
      request.body.nodeId,
      request.body.agentRuntimeId,
      request.body.cwd,
      request.body.runtimeOptions,
      reply,
    );
    if (!target) return;
    try {
      const prepared = prepareAutomationTriggers(request.body.triggers ?? [], undefined);
      const automation = sessionAutomationStore.create({
        owner: currentNodeOwner(),
        name: request.body.name as string,
        ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled as boolean }),
        ...target,
        instruction: request.body.instruction as string,
        ...(request.body.trigger === undefined
          ? { trigger: { type: "manual" as const } }
          : { trigger: request.body.trigger as { type: "manual" } }),
        triggers: prepared.triggers,
      });
      reply
        .code(201)
        .send({ automation: projectAutomationDefinition(automation), webhookSecrets: prepared.webhookSecrets });
    } catch {
      sendInvalidAutomation(reply);
    }
  });

  app.get<{ Params: { automationId: string } }>("/api/v2/automations/:automationId", async (request, reply) => {
    const automation = ownedAutomation(request.params.automationId);
    if (!automation) {
      reply.code(404).send({ code: "SESSION_AUTOMATION_NOT_FOUND", error: "automation not found" });
      return;
    }
    return { automation: projectAutomationDefinition(automation) };
  });

  app.patch<{ Params: { automationId: string }; Body: unknown }>(
    "/api/v2/automations/:automationId",
    { bodyLimit: 128 * 1024 },
    async (request, reply) => {
      const current = ownedAutomation(request.params.automationId);
      if (!current) {
        reply.code(404).send({ code: "SESSION_AUTOMATION_NOT_FOUND", error: "automation not found" });
        return;
      }
      if (!validObjectBody(request.body)) return sendInvalidAutomation(reply);
      if ("owner" in request.body || "provider" in request.body) {
        reply.code(400).send({
          code: "SERVER_ASSIGNED_AUTOMATION_FIELD",
          error: "automation owner and provider are server assigned",
        });
        return;
      }
      if (
        !hasOnlyKeys(request.body, automationUpdateKeys) ||
        Object.keys(request.body).length < 2 ||
        !Number.isSafeInteger(request.body.expectedRevision) ||
        (request.body.expectedRevision as number) < 1
      ) {
        return sendInvalidAutomation(reply);
      }
      const target = await validateAutomationTarget(
        request.body.nodeId ?? current.nodeId,
        request.body.agentRuntimeId ?? current.agentRuntimeId,
        request.body.cwd ?? current.cwd,
        request.body.runtimeOptions ?? current.runtimeOptions,
        reply,
      );
      if (!target) return;
      const input: UpdateSessionAutomationInput = {
        ...(request.body.name === undefined ? {} : { name: request.body.name as string }),
        ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled as boolean }),
        ...(request.body.instruction === undefined ? {} : { instruction: request.body.instruction as string }),
        ...(request.body.trigger === undefined ? {} : { trigger: request.body.trigger as { type: "manual" } }),
        ...target,
      };
      try {
        const prepared = prepareAutomationTriggers(request.body.triggers ?? current.triggers, current);
        input.triggers = prepared.triggers;
        const automation = sessionAutomationStore.update(current.id, input, request.body.expectedRevision as number);
        if (!automation) {
          reply.code(404).send({ code: "SESSION_AUTOMATION_NOT_FOUND", error: "automation not found" });
          return;
        }
        return { automation: projectAutomationDefinition(automation), webhookSecrets: prepared.webhookSecrets };
      } catch (error) {
        if (error instanceof SessionAutomationRevisionConflictError) {
          reply.code(409).send({
            code: "SESSION_AUTOMATION_REVISION_CONFLICT",
            error: "automation state changed",
            current: projectAutomationDefinition(error.current),
          });
          return;
        }
        sendInvalidAutomation(reply);
      }
    },
  );

  app.delete<{ Params: { automationId: string } }>("/api/v2/automations/:automationId", async (request, reply) => {
    if (!ownedAutomation(request.params.automationId) || !sessionAutomationStore.remove(request.params.automationId)) {
      reply.code(404).send({ code: "SESSION_AUTOMATION_NOT_FOUND", error: "automation not found" });
      return;
    }
    reply.code(204).send();
  });

  app.get<{ Params: { automationId: string }; Querystring: { limit?: string } }>(
    "/api/v2/automations/:automationId/activity",
    async (request, reply) => {
      const automation = ownedAutomationIncludingRemoved(request.params.automationId);
      if (!automation) {
        reply.code(404).send({ code: "SESSION_AUTOMATION_NOT_FOUND", error: "automation not found" });
        return;
      }
      const limit = request.query.limit === undefined ? 25 : Number(request.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        reply.code(400).send({ code: "INVALID_AUTOMATION_ACTIVITY_LIMIT", error: "limit must be between 1 and 100" });
        return;
      }
      return { activities: sessionAutomationStore.listActivities(automation.id, limit) };
    },
  );

  app.post<{ Params: { automationId: string; triggerId: string }; Body: unknown }>(
    "/api/v2/automations/:automationId/triggers/:triggerId/secret",
    { bodyLimit: 1024 },
    async (request, reply) => {
      const current = ownedAutomation(request.params.automationId);
      if (!current) {
        reply.code(404).send({ code: "SESSION_AUTOMATION_NOT_FOUND", error: "automation not found" });
        return;
      }
      if (
        !validObjectBody(request.body) ||
        !hasOnlyKeys(request.body, new Set(["expectedRevision"])) ||
        !Number.isSafeInteger(request.body.expectedRevision) ||
        request.body.expectedRevision !== current.revision
      ) {
        return sendInvalidAutomation(reply, "a current expectedRevision is required");
      }
      const selected = current.triggers.find(
        (trigger) => trigger.id === request.params.triggerId && trigger.type === "webhook",
      );
      if (!selected || selected.type !== "webhook") {
        reply.code(404).send({ code: "AUTOMATION_TRIGGER_NOT_FOUND", error: "webhook trigger not found" });
        return;
      }
      const secret = newWebhookSecret();
      const triggers = current.triggers.map((trigger) =>
        trigger.id === selected.id
          ? { ...selected, secretHash: createHash("sha256").update(secret).digest("hex") }
          : trigger,
      );
      try {
        const automation = sessionAutomationStore.update(current.id, { triggers }, current.revision);
        if (!automation) throw new Error("automation disappeared");
        return {
          automation: projectAutomationDefinition(automation),
          webhookSecret: {
            triggerId: selected.id,
            hookId: selected.hookId,
            secret,
            path: `/api/v2/automation-hooks/${selected.hookId}`,
          },
        };
      } catch (error) {
        if (error instanceof SessionAutomationRevisionConflictError) {
          reply.code(409).send({
            code: "SESSION_AUTOMATION_REVISION_CONFLICT",
            error: "automation state changed",
            current: projectAutomationDefinition(error.current),
          });
          return;
        }
        sendInvalidAutomation(reply);
      }
    },
  );

  app.get<{ Params: { automationId: string }; Querystring: { limit?: string } }>(
    "/api/v2/automations/:automationId/runs",
    async (request, reply) => {
      const automation = ownedAutomationIncludingRemoved(request.params.automationId);
      if (!automation) {
        reply.code(404).send({ code: "SESSION_AUTOMATION_NOT_FOUND", error: "automation not found" });
        return;
      }
      const limit = request.query.limit === undefined ? 25 : Number(request.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        reply.code(400).send({ code: "INVALID_AUTOMATION_RUN_LIMIT", error: "limit must be between 1 and 100" });
        return;
      }
      return { runs: sessionAutomationStore.listRuns(automation.id, limit).map(projectAutomationRun) };
    },
  );

  app.post<{ Params: { automationId: string }; Body: unknown }>(
    "/api/v2/automations/:automationId/runs",
    { bodyLimit: 1024 },
    async (request, reply) => {
      const ownedRecord = ownedAutomationIncludingRemoved(request.params.automationId);
      if (!ownedRecord) {
        reply.code(404).send({ code: "SESSION_AUTOMATION_NOT_FOUND", error: "automation not found" });
        return;
      }
      if (request.body !== undefined && (!validObjectBody(request.body) || Object.keys(request.body).length > 0)) {
        sendInvalidAutomation(reply, "manual runs do not accept input");
        return;
      }
      // Resolve a deterministic invocation before consulting mutable definition state. A retry after a crash must
      // recover the exact immutable Run even when its definition has since been edited, disabled, or soft-deleted.
      const invocation = automationInvocationIdentity(request, ownedRecord.id);
      const durableRun = sessionAutomationStore.getRunByInvocationId(invocation.invocationId);
      if (durableRun && durableRun.automationId !== ownedRecord.id) {
        reply.code(409).send({
          code: "AUTOMATION_INVOCATION_CONFLICT",
          error: "durable automation invocation belongs to another definition",
        });
        return;
      }
      let automation: SessionAutomationDefinition;
      let executionInstruction: string;
      let executionProvider: string;
      let executionNodeId: string;
      let executionRuntimeId: string;
      let executionCwd: string;
      let executionRuntimeOptions: Record<string, unknown>;
      if (durableRun) {
        const snapshot = sessionAutomationStore.getRunInputSnapshot(durableRun.id);
        if (
          !snapshot ||
          snapshot.automationId !== durableRun.automationId ||
          snapshot.definitionRevision !== durableRun.definitionRevision
        ) {
          const failed =
            durableRun.status === "starting"
              ? (sessionAutomationStore.markRunFailed(durableRun.id, "AUTOMATION_BOOTSTRAP_STATE_UNKNOWN") ??
                durableRun)
              : durableRun;
          reply.code(502).send({
            code: "AUTOMATION_BOOTSTRAP_STATE_UNKNOWN",
            error: "the durable automation invocation has no trustworthy launch snapshot",
            run: failed,
          });
          return;
        }
        automation = ownedRecord;
        executionInstruction = snapshot.instruction;
        executionProvider = snapshot.provider;
        executionNodeId = durableRun.nodeId;
        executionRuntimeId = durableRun.agentRuntimeId;
        executionCwd = durableRun.cwd;
        executionRuntimeOptions = snapshot.runtimeOptions;
      } else {
        const activeAutomation = ownedAutomation(ownedRecord.id);
        if (!activeAutomation) {
          reply.code(404).send({ code: "SESSION_AUTOMATION_NOT_FOUND", error: "automation not found" });
          return;
        }
        if (!activeAutomation.enabled) {
          reply.code(409).send({ code: "SESSION_AUTOMATION_DISABLED", error: "automation is disabled" });
          return;
        }
        automation = activeAutomation;
        executionInstruction = activeAutomation.instruction;
        executionProvider = activeAutomation.provider;
        executionNodeId = activeAutomation.nodeId;
        executionRuntimeId = activeAutomation.agentRuntimeId;
        executionCwd = activeAutomation.cwd;
        executionRuntimeOptions = activeAutomation.runtimeOptions;
      }
      const target = await validateAutomationTarget(
        executionNodeId,
        executionRuntimeId,
        executionCwd,
        executionRuntimeOptions,
        reply,
        { requireReadyAuth: true },
      );
      if (!target) return;
      if (target.provider !== executionProvider) {
        const failed =
          durableRun?.status === "starting"
            ? (sessionAutomationStore.markRunFailed(durableRun.id, "AUTOMATION_RUN_SNAPSHOT_CONFLICT") ?? durableRun)
            : durableRun;
        reply.code(502).send({
          code: "AUTOMATION_RUN_SNAPSHOT_CONFLICT",
          error: "the durable automation launch snapshot conflicts with its bound runtime",
          ...(failed ? { run: failed } : {}),
        });
        return;
      }
      if (durableRun && !terminalManager.get(durableRun.sessionId) && durableRun.status !== "starting") {
        const projected = projectAutomationRun(durableRun);
        const failed = projected.status === "failed";
        reply.code(failed ? 502 : 409).send({
          code: failed ? (projected.failureCode ?? "AUTOMATION_RUN_FAILED") : "AUTOMATION_RUN_NOT_RESUMABLE",
          error: failed
            ? "the durable automation invocation failed before its response was committed"
            : "the durable automation invocation no longer has a resumable session",
          run: projected,
        });
        return;
      }
      await launchSession(
        request,
        reply,
        { provider: target.provider, cwd: target.cwd, options: target.runtimeOptions },
        { nodeId: target.nodeId, agentRuntimeId: target.agentRuntimeId },
        async ({ meta, response, reused }) => {
          let run = durableRun;
          if (run && run.sessionId !== meta.id) {
            reply.code(409).send({
              code: "AUTOMATION_INVOCATION_CONFLICT",
              error: "durable automation invocation belongs to another session",
            });
            return;
          }
          if (!run) {
            try {
              run = sessionAutomationStore.createRun({
                automationId: automation.id,
                definitionRevision: automation.revision,
                invocationId: invocation.invocationId,
                sessionId: meta.id,
                nodeId: target.nodeId,
                agentRuntimeId: target.agentRuntimeId,
                cwd: target.cwd,
                provider: automation.provider,
                instruction: automation.instruction,
                runtimeOptions: automation.runtimeOptions,
              });
            } catch {
              if (!reused) {
                terminalManager.stop(meta.id);
                commandStore.removeSession(meta.id);
              }
              reply.code(500).send({
                code: "AUTOMATION_RUN_CREATE_FAILED",
                error: "automation run could not be created",
              });
              return;
            }
          }
          // A completed durable invocation found after a restart owns this exact deterministic Session. Its task has
          // already crossed the private bootstrap journal, so returning the inspectable Session cannot submit twice.
          if (durableRun && reused && run.status !== "starting") {
            const projected = projectAutomationRun(run);
            if (projected.status === "failed") {
              reply.code(502).send({
                code: projected.failureCode ?? "AUTOMATION_RUN_FAILED",
                error: "the durable automation invocation failed before its response was committed",
                run: projected,
                session: response.session,
              });
              return;
            }
            if (projected.status === "cancelled") {
              reply.code(409).send({
                code: "AUTOMATION_RUN_NOT_RESUMABLE",
                error: "the durable automation invocation is no longer resumable",
                run: projected,
                session: response.session,
              });
              return;
            }
            reply.code(201).send({ run: projected, session: response.session });
            return;
          }
          let bootstrapClaim: ReturnType<SessionAutomationStore["beginRunBootstrap"]>;
          try {
            bootstrapClaim = sessionAutomationStore.beginRunBootstrap(run.id);
          } catch {
            run = sessionAutomationStore.markRunFailed(run.id, "AUTOMATION_BOOTSTRAP_JOURNAL_FAILED") ?? run;
            reply.code(502).send({
              code: "AUTOMATION_BOOTSTRAP_JOURNAL_FAILED",
              error: "automation session started but task submission could not be journaled",
              run,
              session: response.session,
            });
            return;
          }
          if (bootstrapClaim !== "claimed") {
            const failureCode =
              bootstrapClaim === "missing" ? "AUTOMATION_BOOTSTRAP_STATE_UNKNOWN" : "AUTOMATION_BOOTSTRAP_INTERRUPTED";
            run = sessionAutomationStore.markRunFailed(run.id, failureCode) ?? run;
            reply.code(502).send({
              code: failureCode,
              error:
                bootstrapClaim === "missing"
                  ? "automation task submission state is unavailable"
                  : "automation task submission was interrupted and will not be repeated",
              run,
              session: response.session,
            });
            return;
          }
          try {
            await terminalManager.bootstrapTask(meta.id, executionInstruction);
          } catch {
            run = sessionAutomationStore.markRunFailed(run.id, "AUTOMATION_BOOTSTRAP_FAILED") ?? run;
            reply.code(502).send({
              code: "AUTOMATION_BOOTSTRAP_FAILED",
              error: "automation session started but its task could not be submitted",
              run,
              session: response.session,
            });
            return;
          }
          try {
            const completed = sessionAutomationStore.completeRunBootstrap(run.id);
            if (!completed) throw new Error("bootstrap journal completion conflict");
            run = completed;
          } catch {
            run = sessionAutomationStore.markRunFailed(run.id, "AUTOMATION_BOOTSTRAP_COMMIT_FAILED") ?? run;
            reply.code(502).send({
              code: "AUTOMATION_BOOTSTRAP_COMMIT_FAILED",
              error: "automation task was submitted but its completion state could not be committed",
              run,
              session: response.session,
            });
            return;
          }
          reply.code(201).send({ run: projectAutomationRun(run), session: response.session });
        },
        invocation.sessionId,
      );
    },
  );

  const parsedAutomationConcurrency = Number.parseInt(process.env.ROAMCODE_AUTOMATION_CONCURRENCY ?? "2", 10);
  const automationTriggerEngine = createAutomationTriggerEngine({
    store: sessionAutomationStore,
    concurrency:
      Number.isSafeInteger(parsedAutomationConcurrency) && parsedAutomationConcurrency > 0
        ? parsedAutomationConcurrency
        : 2,
    execute: async (activity: SessionAutomationActivity) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v2/automations/${encodeURIComponent(activity.automationId)}/runs`,
        headers: {
          "idempotency-key": activity.id,
          ...(config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {}),
        },
      });
      const body = (() => {
        try {
          return response.json() as { run?: { id?: unknown } };
        } catch {
          return {};
        }
      })();
      if (response.statusCode !== 201 || typeof body.run?.id !== "string") {
        throw new Error("automation trigger execution failed");
      }
      return { runId: body.run.id };
    },
  });

  app.post<{ Params: { hookId: string }; Body: unknown }>(
    "/api/v2/automation-hooks/:hookId",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const authorized = automationWebhookRequests.get(request);
      if (!authorized || authorized.trigger.type !== "webhook" || authorized.trigger.hookId !== request.params.hookId) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
      // Deliberately ignore the body. A webhook is only a signal; payload bytes never enter prompts or storage.
      automationTriggerEngine.enqueueWebhook(authorized.automation, authorized.trigger);
      reply.code(202).send({ accepted: true });
    },
  );

  app.addHook("onReady", async () => automationTriggerEngine.start());

  /** Provider capability discovery is independent per provider and per capability. */
  app.get("/providers", async () => {
    return { providers: await readProviderAvailability() };
  });

  app.get<{ Params: { provider: string } }>("/providers/:provider/auth/status", async (request, reply) => {
    const provider = providerFrom(request.params.provider);
    if (!provider) return unknownProvider(reply);
    if (provider === "claude") {
      return claudeAuthStatus(reply);
    }
    if (provider !== "codex") return { available: false as const, unsupported: true as const };
    if (!deps.codexMetadata) return { available: false as const };
    try {
      return { available: true as const, ...(await deps.codexMetadata.getAccount()) };
    } catch {
      return metadataUnavailable(reply);
    }
  });

  app.post<{ Params: { provider: string } }>("/providers/:provider/auth/login/start", async (request, reply) => {
    const provider = providerFrom(request.params.provider);
    if (!provider) return unknownProvider(reply);
    try {
      if (provider === "claude") {
        return startClaudeLogin(reply);
      }
      if (provider !== "codex") {
        reply.code(404).send({ code: "PROVIDER_CAPABILITY_UNAVAILABLE", error: "Provider login is unavailable" });
        return;
      }
      if (!deps.codexMetadata) return metadataUnavailable(reply);
      const login = await deps.codexMetadata.startDeviceLogin();
      return {
        loginId: login.loginId,
        userCode: login.userCode,
        verificationUrl: login.verificationUrl,
        expiresAt: login.expiresAt,
      };
    } catch {
      return metadataUnavailable(reply);
    }
  });

  app.get<{ Params: { provider: string }; Querystring: { loginId?: unknown } }>(
    "/providers/:provider/auth/login/status",
    async (request, reply) => {
      const provider = providerFrom(request.params.provider);
      if (!provider) return unknownProvider(reply);
      if (provider !== "codex") {
        reply.code(404).send({ code: "LOGIN_STATUS_UNAVAILABLE", error: "Login status is unavailable" });
        return;
      }
      const loginId = request.query?.loginId;
      if (
        typeof loginId !== "string" ||
        loginId.length === 0 ||
        loginId.length > 256 ||
        /[\p{Cc}\p{Zl}\p{Zp}]/u.test(loginId)
      ) {
        reply.code(400).send({ code: "INVALID_LOGIN", error: "loginId is required" });
        return;
      }
      if (!deps.codexMetadata) return metadataUnavailable(reply);
      try {
        return deps.codexMetadata.getLoginStatus(loginId);
      } catch {
        return metadataUnavailable(reply);
      }
    },
  );

  app.post<{ Params: { provider: string }; Body: { loginId?: unknown } }>(
    "/providers/:provider/auth/login/cancel",
    async (request, reply) => {
      const provider = providerFrom(request.params.provider);
      if (!provider) return unknownProvider(reply);
      if (provider === "claude") {
        return cancelClaudeLogin();
      }
      if (provider !== "codex") {
        reply.code(404).send({ code: "PROVIDER_CAPABILITY_UNAVAILABLE", error: "Provider login is unavailable" });
        return;
      }
      const loginId = request.body?.loginId;
      if (typeof loginId !== "string") {
        reply.code(400).send({ code: "INVALID_LOGIN", error: "loginId is required" });
        return;
      }
      if (!deps.codexMetadata) return metadataUnavailable(reply);
      try {
        return await deps.codexMetadata.cancelLogin(loginId);
      } catch {
        return metadataUnavailable(reply);
      }
    },
  );

  app.get<{ Params: { provider: string } }>("/providers/:provider/models", async (request, reply) => {
    const provider = providerFrom(request.params.provider);
    if (!provider) return unknownProvider(reply);
    if (provider === "claude") {
      if (!deps.claudeMetadata) return metadataUnavailable(reply);
      try {
        return { models: await deps.claudeMetadata.getModels() };
      } catch {
        return metadataUnavailable(reply);
      }
    }
    if (provider !== "codex") {
      if (providers.manifest(provider).capabilities.metadata) return metadataUnavailable(reply);
      return { models: [] };
    }
    if (!deps.codexMetadata) return metadataUnavailable(reply);
    try {
      return { models: await deps.codexMetadata.getModels() };
    } catch {
      return metadataUnavailable(reply);
    }
  });

  app.get<{ Params: { provider: string } }>("/providers/:provider/profiles", async (request, reply) => {
    const provider = providerFrom(request.params.provider);
    if (!provider) return unknownProvider(reply);
    if (provider === "claude") return { profiles: [] };
    if (provider !== "codex") return { profiles: [] };
    if (!deps.codexMetadata) return metadataUnavailable(reply);
    try {
      return { profiles: await deps.codexMetadata.listProfiles() };
    } catch {
      return metadataUnavailable(reply);
    }
  });

  app.get<{ Params: { provider: string } }>("/providers/:provider/usage", async (request, reply) => {
    const provider = providerFrom(request.params.provider);
    if (!provider) return unknownProvider(reply);
    if (provider === "claude") return claudeUsage();
    if (provider !== "codex") {
      if (providers.manifest(provider).capabilities.usage) return metadataUnavailable(reply);
      return { usage: null };
    }
    if (!deps.codexMetadata) return metadataUnavailable(reply);
    try {
      return { usage: await deps.codexMetadata.getUsage() };
    } catch {
      return metadataUnavailable(reply);
    }
  });

  app.get<{ Params: { provider: string } }>("/providers/:provider/version", async (request, reply) => {
    const provider = providerFrom(request.params.provider);
    if (!provider) return unknownProvider(reply);
    if (provider === "claude") return claudeVersion();
    if (provider !== "codex") {
      return { installed: providers.manifest(provider).version, latest: null };
    }
    if (!deps.codexLatest) return metadataUnavailable(reply);
    try {
      return await deps.codexLatest.getVersion();
    } catch {
      return metadataUnavailable(reply);
    }
  });

  // GET /usage → the Claude usage bars {usage: UsageInfo | null} (token-gated by the global preHandler).
  // The UsageService caches with a TTL so this poll is cheap; a spawn/parse failure degrades to
  // `usage:null` (the UI hides the bars) and never 500s. Absent dep (tests / no claude) → null.
  app.get("/usage", async () => {
    return claudeUsage();
  });

  // In-app Claude re-authentication (token-gated by the global preHandler). Lets a user whose server-side
  // Claude login expired sign in again from the app: start → returns the authorize URL; the user authorizes
  // in any browser + pastes the code back; code → finishes the exchange (fresh creds, no restart needed).
  // GET /auth/status → which account is signed in (or {available:false} when the feature is off).
  app.get("/auth/status", async () => {
    return claudeAuthStatus();
  });
  // POST /auth/login/start → { loginId, url } (503 if the feature is off / the URL never appears).
  app.post("/auth/login/start", async (_request, reply) => {
    return startClaudeLogin(reply);
  });
  // POST /auth/login/code { loginId, code } → { ok, message? }.
  app.post<{ Body: { loginId?: string; code?: string } }>("/auth/login/code", async (request, reply) => {
    if (!deps.claudeAuth) {
      reply.code(503).send({ error: "Claude sign-in is not available on this server." });
      return;
    }
    const { loginId, code } = request.body ?? {};
    if (typeof loginId !== "string" || typeof code !== "string") {
      reply.code(400).send({ error: "loginId and code are required" });
      return;
    }
    return await deps.claudeAuth.submitCode(loginId, code);
  });
  // POST /auth/login/cancel → abandon an in-flight sign-in.
  app.post("/auth/login/cancel", async () => {
    return cancelClaudeLogin();
  });

  // GET /claude/version → { installed, latest } (token-gated). `installed` is the server's `claude --version`;
  // `latest` is the newest published version (null when unknown). The UI compares a session's claudeVersion
  // against `latest` to show a subtle "update available" hint. Never 500s — both degrade to null.
  app.get("/claude/version", async () => {
    return claudeVersion();
  });

  app.get<{ Querystring: { path?: string } }>("/fs/list", async (request, reply) => {
    try {
      const target = request.query.path ?? config.fsRoot;
      return await fsService.listDirectory(target);
    } catch (err) {
      if (err instanceof FsError) {
        reply.code(err.code === "forbidden" ? 403 : 404).send({ error: err.message });
      } else {
        reply.code(400).send({ error: (err as Error).message });
      }
    }
  });

  // POST /fs/mkdir {path} → 201 { path }: create ONE directory for the picker's "new folder" flow.
  // Non-recursive by design (the parent must already exist — 404 otherwise); 409 when the path is taken;
  // fsRoot-confined exactly like /fs/list (403 on any escape). Token-gated by the global preHandler.
  app.post<{ Body: { path?: string } }>("/fs/mkdir", async (request, reply) => {
    const target = request.body?.path;
    if (typeof target !== "string" || target.trim().length === 0) {
      reply.code(400).send({ error: "path is required" });
      return;
    }
    try {
      const created = await fsService.makeDirectory(target);
      reply.code(201).send({ path: created.path });
    } catch (err) {
      if (err instanceof FsError) {
        reply.code(err.code === "forbidden" ? 403 : err.code === "exists" ? 409 : 404).send({ error: err.message });
      } else {
        reply.code(400).send({ error: (err as Error).message });
      }
    }
  });

  // GET /fs/search?q=<substr>&base=<abs dir, default fsRoot> → { results: [{path,name,isGitRepo}] }:
  // case-insensitive substring match on DIRECTORY names for the picker's "type to find your repo" flow.
  // Bounded walk (depth ≤5, ≤400 dirs, ≤30 results, shallowest-first; dot-dirs + node_modules skipped) —
  // see FsService.searchDirectories. fsRoot-confined; token-gated by the global preHandler.
  app.get<{ Querystring: { q?: string; base?: string } }>("/fs/search", async (request, reply) => {
    const q = request.query.q;
    if (typeof q !== "string" || q.trim().length === 0) {
      reply.code(400).send({ error: "q is required" });
      return;
    }
    try {
      const results = await fsService.searchDirectories(q.trim(), request.query.base);
      return { results };
    } catch (err) {
      if (err instanceof FsError) {
        reply.code(err.code === "forbidden" ? 403 : 404).send({ error: err.message });
      } else {
        reply.code(400).send({ error: (err as Error).message });
      }
    }
  });

  app.get<{ Querystring: { path?: string } }>("/fs/download", async (request, reply) => {
    if (!request.query.path) {
      return reply.code(400).send({ error: "path is required" });
    }
    try {
      const file = await fsService.describeFile(request.query.path);
      reply
        .header("accept-ranges", "bytes")
        .header("cache-control", "private, no-cache")
        .header("etag", fileEntityTag(file.size, file.mtimeMs))
        .header("content-disposition", contentDisposition(file.filename))
        .header("content-type", "application/octet-stream")
        .header("x-content-type-options", "nosniff");
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match) return reply.code(416).header("content-range", `bytes */${file.size}`).send();
        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
        if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= file.size) {
          return reply.code(416).header("content-range", `bytes */${file.size}`).send();
        }
        return reply
          .code(206)
          .header("content-range", `bytes ${start}-${end}/${file.size}`)
          .header("content-length", String(end - start + 1))
          .send(createReadStream(file.path, { start, end }));
      }
      return reply.header("content-length", String(file.size)).send(createReadStream(file.path));
    } catch (err) {
      if (err instanceof FsError) {
        return reply.code(err.code === "forbidden" ? 403 : 404).send({ error: err.message });
      } else {
        return reply.code(404).send({ error: (err as Error).message });
      }
    }
  });

  app.post<{ Querystring: { dir?: string } }>("/fs/upload", async (request, reply) => {
    const targetDir = request.query.dir ?? config.fsRoot;
    let data;
    try {
      data = await request.file();
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
    if (!data) {
      reply.code(400).send({ error: "no file field in the upload" });
      return;
    }
    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch (err) {
      // @fastify/multipart throws when the per-file limit is exceeded.
      reply.code(413).send({ error: (err as Error).message });
      return;
    }
    if (data.file.truncated) {
      reply.code(413).send({ error: "file exceeds the upload size limit" });
      return;
    }
    try {
      const written = await fsService.writeUploadedFile(targetDir, data.filename, buffer);
      reply.code(201).send({ path: written.path });
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Serve the built PWA same-origin when a webDir was provided. Registered LAST so it never
  // Durable terminal file inventory. Metadata survives PWA/server reloads; file availability is checked
  // against the real fsRoot-confined path so a removed workspace file is represented explicitly.
  app.get<{ Params: { id: string } }>("/sessions/:id/files", async (request, reply) => {
    if (!terminalManager.get(request.params.id)) {
      reply.code(404).send({ error: "terminal session not found" });
      return;
    }
    // Preserve fast local legacy backfill, but never let a slow mount delay the terminal. The scan continues
    // safely in the background and a later panel retry/refresh will pick up anything discovered afterward.
    await completionWithin(backfillManagedFiles(request.params.id), FILE_HISTORY_BACKFILL_BUDGET_MS);
    const files = await Promise.all(
      store.listFiles(request.params.id).map(async (file) => {
        const available = await fileAvailableWithinBudget(file);
        return publicSessionFile(file, available);
      }),
    );
    return {
      files,
      policy: {
        maxUploadBytes: config.maxUploadBytes,
        retentionMs: TERMINAL_FILE_TTL_MS,
        durable: store.mode === "sqlite",
      },
    };
  });

  app.get<{ Params: { id: string; fileId: string }; Querystring: { disposition?: "inline" | "attachment" } }>(
    "/sessions/:id/files/:fileId/content",
    async (request, reply) => {
      const file = store.getFile(request.params.id, request.params.fileId);
      if (!file || file.hiddenAt !== undefined) {
        return reply.code(404).send({ error: "file not found" });
      }
      if (file.expiresAt <= Date.now()) {
        return reply.code(410).send({ error: "file has expired" });
      }
      try {
        const info = await fsService.describeFile(file.path);
        const disposition = request.query.disposition === "inline" ? "inline" : "attachment";
        reply
          .header("accept-ranges", "bytes")
          .header("cache-control", "private, no-cache")
          .header("etag", fileEntityTag(info.size, info.mtimeMs))
          .header("content-type", file.mimeType)
          .header("x-content-type-options", "nosniff")
          .header(
            "content-security-policy",
            "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'",
          )
          .header("content-disposition", contentDisposition(info.filename, disposition));
        const range = request.headers.range;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (!match) {
            reply.code(416).header("content-range", `bytes */${info.size}`).send();
            return;
          }
          const start = Number(match[1]);
          const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
          if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= info.size) {
            reply.code(416).header("content-range", `bytes */${info.size}`).send();
            return;
          }
          return reply
            .code(206)
            .header("content-range", `bytes ${start}-${end}/${info.size}`)
            .header("content-length", String(end - start + 1))
            .send(createReadStream(info.path, { start, end }));
        }
        return reply.header("content-length", String(info.size)).send(createReadStream(info.path));
      } catch (err) {
        const code = err instanceof FsError && err.code === "forbidden" ? 403 : 404;
        return reply.code(code).send({ error: (err as Error).message });
      }
    },
  );

  // Terminal upload (user → provider): each file gets a unique managed folder and is streamed to an atomic
  // partial before it is exposed or persisted. The response retains `path` for prompt insertion compatibility.
  app.post<{ Params: { id: string } }>("/sessions/:id/upload", async (request, reply) => {
    const sessionId = request.params.id;
    if (!terminalManager.get(sessionId)) {
      reply.code(404).send({ error: "terminal session not found" });
      return;
    }
    let data;
    try {
      data = await request.file();
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
    if (!data) {
      reply.code(400).send({ error: "no file field in the upload" });
      return;
    }
    const id = randomUUID();
    try {
      const dir = await fsService.ensureDirWithinRoot(
        `${terminalSharedDir({ dataDir, fsRoot: config.fsRoot, sessionId })}/${id}`,
      );
      const written = await fsService.writeUploadedStream(dir, data.filename, data.file, () => !data.file.truncated);
      const now = Date.now();
      const media = attachmentMedia(data.filename, data.mimetype);
      const stored: StoredSessionFile = {
        id,
        sessionId,
        direction: "sent",
        storage: "managed",
        name: data.filename,
        path: written.path,
        mimeType: media.mimeType,
        size: written.size,
        kind: media.kind,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + TERMINAL_FILE_TTL_MS,
      };
      store.putFile(stored);
      terminalManager.pushControl(sessionId, { t: "file", op: "added", file: publicSessionFile(stored) });
      reply.code(201).send({ path: stored.path, file: publicSessionFile(stored) });
    } catch (err) {
      reply.code(data.file.truncated ? 413 : 400).send({
        error: data.file.truncated ? "file exceeds the upload size limit" : (err as Error).message,
      });
    }
  });

  app.post<{ Params: { id: string; fileId: string } }>("/sessions/:id/files/:fileId/derive", async (request, reply) => {
    const source = store.getFile(request.params.id, request.params.fileId);
    if (!source || source.hiddenAt !== undefined || source.kind !== "image") {
      reply.code(404).send({ error: "source image not found" });
      return;
    }
    if (source.expiresAt <= Date.now()) {
      reply.code(410).send({ error: "source image has expired" });
      return;
    }
    let data;
    try {
      data = await request.file();
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
    if (!data || !data.mimetype.startsWith("image/")) {
      reply.code(400).send({ error: "an edited image is required" });
      return;
    }
    const id = randomUUID();
    try {
      const dir = await fsService.ensureDirWithinRoot(
        `${terminalSharedDir({ dataDir, fsRoot: config.fsRoot, sessionId: source.sessionId })}/${id}`,
      );
      const written = await fsService.writeUploadedStream(dir, data.filename, data.file, () => !data.file.truncated);
      const now = Date.now();
      const media = attachmentMedia(data.filename, data.mimetype);
      const stored: StoredSessionFile = {
        id,
        sessionId: source.sessionId,
        direction: "sent",
        storage: "managed",
        name: data.filename,
        path: written.path,
        mimeType: media.mimeType,
        size: written.size,
        kind: "image",
        createdAt: now,
        updatedAt: now,
        expiresAt: now + TERMINAL_FILE_TTL_MS,
        derivedFromId: source.id,
      };
      store.putFile(stored);
      terminalManager.pushControl(source.sessionId, { t: "file", op: "added", file: publicSessionFile(stored) });
      reply.code(201).send({ path: stored.path, file: publicSessionFile(stored) });
    } catch (err) {
      reply.code(data.file.truncated ? 413 : 400).send({
        error: data.file.truncated ? "file exceeds the upload size limit" : (err as Error).message,
      });
    }
  });

  app.put<{ Params: { id: string; fileId: string } }>("/sessions/:id/files/:fileId/content", async (request, reply) => {
    const file = store.getFile(request.params.id, request.params.fileId);
    if (!file || file.hiddenAt !== undefined) {
      reply.code(404).send({ error: "file not found" });
      return;
    }
    if (file.expiresAt <= Date.now()) {
      reply.code(410).send({ error: "file has expired" });
      return;
    }
    if (file.direction !== "sent" || file.storage !== "managed" || file.kind !== "image") {
      reply.code(409).send({ error: "only managed sent images can be replaced" });
      return;
    }
    let data;
    try {
      data = await request.file();
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
    if (!data || !data.mimetype.startsWith("image/")) {
      reply.code(400).send({ error: "an image file is required" });
      return;
    }
    try {
      const written = await fsService.replaceFileStream(file.path, data.file, () => !data.file.truncated);
      const now = Date.now();
      const updated: StoredSessionFile = {
        ...file,
        mimeType: data.mimetype,
        size: written.size,
        updatedAt: now,
        expiresAt: now + TERMINAL_FILE_TTL_MS,
      };
      store.putFile(updated);
      terminalManager.pushControl(file.sessionId, { t: "file", op: "updated", file: publicSessionFile(updated) });
      reply.send({ file: publicSessionFile(updated) });
    } catch (err) {
      reply.code(data.file.truncated ? 413 : 400).send({
        error: data.file.truncated ? "file exceeds the upload size limit" : (err as Error).message,
      });
    }
  });

  app.patch<{ Params: { id: string; fileId: string }; Body: { hidden?: boolean } }>(
    "/sessions/:id/files/:fileId",
    async (request, reply) => {
      const file = store.getFile(request.params.id, request.params.fileId);
      if (!file) {
        reply.code(404).send({ error: "file not found" });
        return;
      }
      store.setFileHidden(file.sessionId, file.id, request.body?.hidden === false ? undefined : Date.now());
      terminalManager.pushControl(file.sessionId, {
        t: "file",
        op: request.body?.hidden === false ? "restored" : "hidden",
        id: file.id,
      });
      reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; fileId: string }; Querystring: { content?: string } }>(
    "/sessions/:id/files/:fileId",
    async (request, reply) => {
      const file = store.getFile(request.params.id, request.params.fileId);
      if (!file) {
        reply.code(204).send();
        return;
      }
      if (request.query.content === "true") {
        if (file.direction !== "sent" || file.storage !== "managed") {
          reply.code(409).send({ error: "workspace files cannot be deleted by RoamCode" });
          return;
        }
        try {
          await fsService.removeManagedPath(file.path);
        } catch (err) {
          if (!(err instanceof FsError && err.code === "not-found")) {
            reply.code(err instanceof FsError && err.code === "forbidden" ? 403 : 500).send({
              error: "managed file could not be deleted",
            });
            return;
          }
        }
        store.deleteFile(file.sessionId, file.id);
      } else {
        store.setFileHidden(file.sessionId, file.id, Date.now());
      }
      terminalManager.pushControl(file.sessionId, { t: "file", op: "removed", id: file.id });
      reply.code(204).send();
    },
  );

  // shadows the API/WS routes above (the SPA fallback is scoped by isPublicPath).
  if (deps.webDir) registerStatic(app, { webDir: deps.webDir });

  // Graceful shutdown: app.close() stops the file-sweep timer and closes the SQLite-backed stores opened
  // by startServer (session, device, push) so their DB handles are released — they're opened once at boot and never
  // reopened, so closing them on shutdown is safe. Terminal sessions live in tmux (detached from this
  // process), so they intentionally SURVIVE a server restart (rehydrate reattaches them on the next boot).
  app.addHook("onClose", async () => {
    automationTriggerEngine.stop();
    clearInterval(sharedSweepTimer);
    inputLeases.close();
    unsubscribeAutomations();
    unsubscribePlugins();
    try {
      if (typeof deps.codexMetadata?.dispose === "function") deps.codexMetadata.dispose();
    } catch {
      /* provider metadata teardown is best-effort; continue closing all other resources */
    }
    try {
      if (typeof deps.claudeMetadata?.dispose === "function") await deps.claudeMetadata.dispose();
    } catch {
      /* provider metadata teardown is best-effort; continue closing all other resources */
    }
    try {
      deps.claudeAuth?.cancel();
    } catch {
      /* continue closing */
    }
    try {
      await deps.disposeProviders?.();
    } catch {
      /* continue closing */
    }
    try {
      deps.store?.close();
    } catch {
      /* continue closing */
    }
    try {
      deviceStore.close();
    } catch {
      /* continue closing */
    }
    try {
      commandStore.close();
    } catch {
      /* continue closing */
    }
    try {
      controlStore.close();
    } catch {
      /* continue closing */
    }
    try {
      sessionAutomationStore.close();
    } catch {
      /* continue closing */
    }
    try {
      teamStore.close();
    } catch {
      /* continue closing */
    }
    try {
      policyStore.close();
    } catch {
      /* continue closing */
    }
    try {
      peerStore.close();
    } catch {
      /* continue closing */
    }
    try {
      presence.close();
    } catch {
      /* continue closing */
    }
    try {
      extensionManager.close();
    } catch {
      /* continue closing */
    }
    try {
      deps.pushStore?.close();
    } catch {
      /* every owned resource gets an independent teardown attempt */
    }
  });

  const relayHeaders = (token: string, headers: Record<string, string> = {}) => ({
    ...headers,
    authorization: `Bearer ${token}`,
    "x-roamcode-internal-relay": relayInternalCapability,
  });
  const dispatchRelayRequest = async (token: string, request: RelayRpcRequest): Promise<RelayRpcResponse> => {
    const response = await app.inject({
      method: request.method,
      url: request.path,
      headers: relayHeaders(token, request.headers),
      ...(request.body ? { payload: request.body } : {}),
    });
    return relayRpcResponse({
      id: request.id,
      status: response.statusCode,
      headers: response.headers,
      body: response.rawPayload,
    });
  };
  const issueRelayTerminalTicket = async (token: string): Promise<string> => {
    const response = await app.inject({ method: "POST", url: "/ws-ticket", headers: relayHeaders(token) });
    const ticket = response.statusCode === 200 ? (response.json() as { ticket?: unknown }).ticket : undefined;
    if (typeof ticket !== "string" || !ticket) throw new Error("relay device is not authorized for this terminal");
    return ticket;
  };

  return {
    app,
    authGate,
    terminalManager,
    terminalAvailable,
    automationWebhookRegistrations: () =>
      sessionAutomationStore.list().flatMap((automation) =>
        automation.triggers
          .filter((trigger) => trigger.type === "webhook")
          .map((trigger) => ({
            hookId: trigger.hookId,
            automationId: automation.id,
            triggerId: trigger.id,
            secretHash: trigger.secretHash,
            enabled: automation.enabled && trigger.enabled,
          })),
      ),
    acceptCloudAutomationInvocation: async (invocation) => {
      const automation = sessionAutomationStore.get(invocation.automationId);
      const trigger = automation?.triggers.find(
        (candidate) =>
          candidate.type === "webhook" &&
          candidate.id === invocation.triggerId &&
          candidate.hookId === invocation.hookId,
      );
      if (!automation?.enabled || !trigger?.enabled || trigger.type !== "webhook") {
        throw new Error("managed automation webhook is no longer active");
      }
      automationTriggerEngine.enqueueWebhook(automation, trigger, invocation.id);
    },
    inputLeases,
    teamStore,
    policyStore,
    peerStore,
    presence,
    issuePairing: () => deviceStore.issuePairing(),
    dispatchRelayRequest,
    issueRelayTerminalTicket,
    relayLoopbackHeaders: relayHeaders,
  };
}

/**
 * Build a safe `Content-Disposition` value for a download. A filename containing `"`, `\`, or a
 * CR/LF could break out of the header (header injection) or corrupt the quoted-string. We strip
 * control chars for the ASCII `filename=` fallback (quotes/backslashes escaped) and carry the full
 * UTF-8 name via RFC 5987 `filename*=` (percent-encoded), which modern clients prefer.
 */
function contentDisposition(filename: string, disposition: "attachment" | "inline" = "attachment"): string {
  // Drop control chars (incl. CR/LF) from the ASCII fallback, then escape `\` and `"`.
  const ascii = filename.replace(/[\x00-\x1f\x7f"\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function fileEntityTag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}
