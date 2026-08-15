import { createHash, randomUUID } from "node:crypto";
import { basename as pathBasename, resolve as resolvePath } from "node:path";
import { createReadStream } from "node:fs";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { FsService, FsError } from "./fs-service.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { WebSocket } from "ws";
import { AuthGate, extractBearerToken } from "./auth.js";
import { isOriginAllowed } from "./origin-check.js";
import { RateLimiter } from "./rate-limit.js";
import { generateAccessToken, persistAccessToken } from "./data-dir.js";
import { registerStatic, isPublicPath, isShellPath, pathForGate, hasEncodedSep } from "./static-routes.js";
import { WsTicketStore } from "./ws-ticket.js";
import { stat } from "node:fs/promises";
import type { ServerRuntimeConfig } from "./server-config.js";
import {
  isStoredShellSession,
  type SessionStore,
  type StoreMode,
  type StoredSessionFile,
  type SessionFileKind,
} from "./session-store.js";
import {
  TERMINAL_FILE_TTL_MS,
  TERMINAL_SWEEP_INTERVAL_MS,
  terminalSharedBase,
  terminalSharedDir,
} from "./terminal-shared.js";
import type { PushStore } from "./push-store.js";
import { normalizeDeviceName, openDeviceStore } from "./device-store.js";
import type { DeviceStore, PairingTicket } from "./device-store.js";
import { CommandCenterRevisionConflictError, openCommandCenterStore } from "./command-center-store.js";
import type { AgentActivity, AttentionKind, CommandCenterStore } from "./command-center-store.js";
import { IDEMPOTENCY_TTL_MS, openIdempotencyStore } from "./idempotency-store.js";
import type { IdempotencyStore } from "./idempotency-store.js";
import {
  agentRuntimeId,
  projectAgentRuntimeRecords,
  projectNodeRecord,
  type AgentRuntimeAuthState,
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
import {
  createHostClipboardWriter,
  HostClipboardError,
  HOST_CLIPBOARD_MAX_BYTES,
  type HostClipboardWriter,
} from "./host-clipboard.js";
import { openSessionStore } from "./session-store.js";
import type { ProviderAvailability, ProviderId } from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createClaudeProvider } from "./providers/claude-provider.js";
import { createCodexProvider } from "./providers/codex-provider.js";
import type { CodexMetadataService } from "./providers/codex-metadata-service.js";
import type { ClaudeMetadataService } from "./providers/claude-metadata-service.js";
import type { CodexLatestService } from "./providers/codex-latest-service.js";
import type { CodexThreadResolver } from "./providers/codex-thread-resolver.js";
import { buildOpenApiDocument } from "./openapi.js";
import { PresenceCoordinator, PRESENCE_HEARTBEAT_MS } from "./presence.js";
import type { PresencePrincipal } from "./presence.js";

/** Terminal WS guards. Input: cap a single frame so a client can't force a huge alloc / flood the pty (1MB
 *  still allows large pastes). Output: if the client buffers more than this undrained, close (it reconnects
 *  and tmux redraws) rather than grow Node's heap unbounded on a slow link. */
const MAX_TERMINAL_INPUT_BYTES = 1_000_000;
const MAX_PENDING_TERMINAL_INPUT_FRAMES = 64;
const MAX_PENDING_TERMINAL_INPUT_BYTES = 1_000_000;
const MAX_TERMINAL_WS_BUFFER = 16_000_000;
/** Server→client WS ping cadence. An idle terminal (no output, no keystrokes) carries zero WS traffic, so
 *  a fronting proxy with a short idle cap could drop the connection and force the client to flap through a
 *  reconnect. A periodic ping keeps the link warm (the browser auto-pongs), below common proxy timeouts. */
const TERMINAL_WS_PING_MS = 25_000;

const CLAUDE_HOOK_EVENTS = [
  "start",
  "submit",
  "stop",
  "tool",
  "post-tool",
  "permission",
  "permission-denied",
  "elicitation",
  "notification",
] as const;
type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

function hookObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function claudeHookHasBackgroundWork(payload: Record<string, unknown>): boolean {
  if (Array.isArray(payload.session_crons) && payload.session_crons.length > 0) return true;
  return (
    Array.isArray(payload.background_tasks) &&
    payload.background_tasks.some((task) => hookObject(task)?.status === "running")
  );
}

/** Lifecycle mapping grounded in Claude Code's current hook contract. An absent body identifies an older
 * RoamCode hook file; ignore it so a legacy Stop cannot falsely announce completion while background work is
 * still running. Live screen detection remains the fallback for those already-running sessions. */
function claudeHookActivity(event: ClaudeHookEvent, body: unknown): "working" | "blocked" | "idle" | undefined {
  const payload = hookObject(body);
  if (!payload) return undefined;
  switch (event) {
    case "start":
      return "idle";
    case "submit":
    case "post-tool":
    case "permission-denied":
      return "working";
    case "stop":
      return claudeHookHasBackgroundWork(payload) ? "working" : "idle";
    case "permission":
    case "elicitation":
      return "blocked";
    case "tool": {
      const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
      return toolName === "AskUserQuestion" || toolName === "ExitPlanMode" ? "blocked" : "working";
    }
    case "notification": {
      const notificationType =
        typeof payload.notification_type === "string" ? payload.notification_type.toLowerCase() : "";
      if (
        ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"].includes(
          notificationType,
        )
      ) {
        return "blocked";
      }
      return notificationType === "idle_prompt" ? "idle" : undefined;
    }
  }
}

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
  /** Durable replay protection for mutating API requests. */
  idempotencyStore?: IdempotencyStore;
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
   * failed to load; NOT durable across restarts). Surfaced by the authenticated GET /diag.
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
  /** Boot-only tmux inventory probe. A failed probe returns undefined and must never trigger reconciliation. */
  tmuxSessionLister?: () => string[] | undefined;
  /**
   * Terminal session manager (injectable for tests; a real one is constructed from deps.store +
   * config.claude.claudeBin when omitted).
   */
  terminalManager?: TerminalManager;
  /** Native clipboard of the computer running RoamCode. Injected in tests so no developer clipboard is touched. */
  hostClipboard?: HostClipboardWriter;
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
  /** Ephemeral, bounded presence heartbeats. */
  presence?: PresenceCoordinator;
}

export interface CreateServerResult {
  app: FastifyInstance;
  authGate: AuthGate;
  /** Issue a five-minute, one-use pairing capability without exposing the host's master token. */
  issuePairing(): PairingTicket;
  /** Exposed so startServer can late-bind the MCP attach config (after listen() resolves the port) —
   *  this is what gives the terminal's claude send_image/send_file. */
  terminalManager: TerminalManager;
  presence: PresenceCoordinator;
  /** False when tmux/node-pty is unavailable → terminal sessions are disabled (startServer warns loudly). */
  terminalAvailable: boolean;
}

interface CreateSessionBody {
  cwd: string;
  /** Session mode: terminal is the only mode (a pty-backed tmux terminal session). */
  mode?: "terminal";
}

interface CreateNodeSessionBody {
  cwd?: unknown;
}

interface V2SessionProjection {
  nodeId: string;
  agentRuntimeId?: string;
}

/**
 * A filesystem failure that is NOT an {@link FsError} is a raw Node error, and its `message` used to be sent
 * to the browser verbatim — the directory picker showed things like
 * `EACCES: permission denied, scandir '/Users/<name>/private'`, which leaks a host path and tells the user
 * nothing they can act on. Translate the errno; the machine-readable half stays in `code`.
 */
function fsSystemFailure(err: unknown): { code: string; error: string } {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  if (errno === "EACCES" || errno === "EPERM") {
    return { code: "FS_FORBIDDEN_BY_OS", error: "This Node's user isn't allowed to read that folder." };
  }
  if (errno === "ENOENT") return { code: "FS_NOT_FOUND", error: "That path no longer exists on the Node." };
  if (errno === "ENOTDIR") return { code: "FS_NOT_A_DIRECTORY", error: "That path isn't a folder." };
  if (errno === "ELOOP") return { code: "FS_LOOP", error: "That path loops through itself and can't be opened." };
  if (errno === "EMFILE" || errno === "ENFILE") {
    return { code: "FS_BUSY", error: "The Node has too many files open right now — try again in a moment." };
  }
  return { code: "FS_UNAVAILABLE", error: "The Node couldn't read that location." };
}

/**
 * SSRF guard for a Web-Push endpoint the server will later POST to: reject loopback / private / link-local
 * hosts (including the link-local metadata address 169.254.169.254) so an authenticated client can't point delivery at an
 * internal service. Real push services (FCM / Apple / Mozilla) are public HTTPS hosts, so this never blocks a
 * legitimate subscription.
 */
function isDisallowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6 checks apply ONLY to an IPv6 literal, which always contains a colon. Testing the fc00::/7
  // unique-local prefixes against a bare hostname rejected every name starting "fc" or "fd" — including
  // fcm.googleapis.com, so no Android or Chrome browser could ever register for push.
  if (host.includes(":")) {
    if (host === "::1" || /^(0+:){7}0*1$/.test(host)) return true; // loopback, compressed or expanded
    if (host.startsWith("fe80:")) return true; // link-local
    return /^f[cd][0-9a-f]{0,2}:/.test(host); // fc00::/7 unique-local
  }
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
  const idempotencyStore = deps.idempotencyStore ?? openIdempotencyStore({ dbPath: ":memory:" });
  const presence = deps.presence ?? new PresenceCoordinator();
  const hostClipboard = deps.hostClipboard ?? createHostClipboardWriter();
  const syncCommandAgent = (id: string, activity: AgentActivity) => {
    const live = terminalManager?.get(id);
    const stored = store.get(id);
    if (!live && !stored) return undefined;
    const cwd = live?.cwd ?? stored!.cwd;
    const createdAt = live?.createdAt ?? stored!.createdAt;
    const placement = commandStore.ensureSession(id, cwd);
    const provider = live?.agent?.provider ?? (stored && !isStoredShellSession(stored) ? stored.provider : undefined);
    const agent = provider
      ? commandStore.upsertAgent({
          sessionId: id,
          workspaceId: placement.workspaceId,
          provider,
          activity,
          createdAt,
        })
      : undefined;
    if (!provider) commandStore.removeAgentForSession(id);
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
    if (!synced?.agent) return;
    commandStore.recordAttention({
      workspaceId: synced.placement.workspaceId,
      sessionId: id,
      agentId: synced.agent.id,
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
      // Away-from-desk pushes: a genuine blocker, task completion, or process exit with nobody watching.
      // Every event goes through dispatchPush so it carries the current awaiting-session badge count.
      onAwaiting: (id) => dispatchPush({ kind: "awaiting", sessionId: id }),
      onActivityChanged: (id, previous, current, viewed) => {
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
        // Clearing a standing signal means the notification for it is now stale on every device.
        if (commandStore.resolveAttentionByDedupeKey(`blocked:${id}`) > 0)
          dispatchPush({ kind: "dismiss", sessionId: id });
        if (current === "idle" && (previous === "working" || previous === "blocked") && !viewed) {
          recordAttentionForSession(id, "done", `${label} finished a turn`, `done:${id}`);
          dispatchPush({ kind: "finished", sessionId: id });
          return;
        }
        syncCommandAgent(id, current);
        if (current === "working" && commandStore.resolveAttentionByDedupeKey(`done:${id}`) > 0) {
          dispatchPush({ kind: "dismiss", sessionId: id });
        }
        if (viewed) commandStore.markSessionViewed(id);
      },
      onAgentChanged: (id, _previous, current) => {
        const meta = terminalManager.get(id);
        if (!meta) return;
        if (current) syncCommandAgent(id, current.activity);
        else commandStore.removeAgentForSession(id);
      },
      onViewed: (id) => {
        // Opening the session answers what it was asking for. When that actually resolved a standing signal,
        // every OTHER device is still showing a notification for a question that is now settled.
        if (commandStore.markSessionViewed(id) > 0) dispatchPush({ kind: "dismiss", sessionId: id });
        const meta = terminalManager.get(id);
        if (meta) syncCommandAgent(id, meta.status === "ended" ? "ended" : meta.activity);
      },
      onFinished: (id, wasViewed) => {
        const meta = terminalManager.get(id);
        const label = meta?.name?.trim() || (meta ? pathBasename(meta.cwd) : "Agent");
        syncCommandAgent(id, "ended");
        commandStore.resolveAttentionByDedupeKey(`blocked:${id}`);
        const alreadyOpen = commandStore.listAttention().some((item) => item.sessionId === id && item.kind === "done");
        if (!wasViewed && !alreadyOpen) {
          recordAttentionForSession(id, "done", `${label} ended`, `done:${id}`);
          dispatchPush({ kind: "finished", sessionId: id });
        }
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
    const tmuxSessionLister = deps.tmuxSessionLister ?? listTmuxSessions;
    let liveTmuxNames = tmuxSessionLister();
    for (let i = 0; liveTmuxNames === undefined && i < 2; i += 1) liveTmuxNames = tmuxSessionLister();
    if (liveTmuxNames !== undefined) {
      terminalManager.rehydrate({ liveTmuxNames });
      // TerminalManager first removes SessionStore rows whose tmux process is definitively gone. Reconcile the
      // command hierarchy against that surviving durable inventory so stale rail agents disappear in the same
      // boot, while provider-unavailable or malformed but still-live sessions remain recoverable.
      commandStore.reconcileSessions?.(store.list().map((session) => session.id));
    }
  }
  // Backfill the command-center hierarchy for pre-existing sessions on first boot. Exact cwd grouping keeps
  // the migration deterministic and requires no user reorganization.
  for (const meta of terminalManager.list())
    syncCommandAgent(meta.id, meta.status === "ended" ? "ended" : meta.activity);
  const stopAndRemoveSession = (id: string): void => {
    if (terminalManager.get(id)) terminalManager.stop(id);
    commandStore.removeSession(id);
  };

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
  const fsService = new FsService({ root: config.fsRoot });
  // Terminal uploads live under the app data dir (outside session working directories), one
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
  const authenticatedPrincipals = new WeakMap<FastifyRequest, PresencePrincipal>();
  const hostPrincipal = (): PresencePrincipal => ({
    actorType: config.accessToken ? "host" : "local",
    actorId: commandStore.getHost().id,
    label: config.accessToken ? "Host credential" : "Local client",
  });
  const principalForToken = (token: string | undefined): PresencePrincipal => {
    const device = token ? deviceStore.authenticate(token) : undefined;
    if (device) return { actorType: "device", actorId: device.id, label: device.name };
    return hostPrincipal();
  };
  const currentDeviceIdForRequest = (request: FastifyRequest): string | undefined => {
    const principal = authenticatedPrincipals.get(request);
    return principal?.actorType === "device" ? principal.actorId : undefined;
  };
  // Keep every paired browser actor in one revocation registry so revoking a device cuts off terminal output
  // immediately, not only future input.
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
  // Multipart uploads, capped at the configured size.
  app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });

  // Global token gate — applies to BOTH REST routes AND the WebSocket upgrade request
  // (a Fastify global preHandler runs for the WS route's GET upgrade and a 401 there
  // aborts the upgrade — verified). The token for a WS upgrade may arrive in the
  // Authorization header, a single-use `?ticket=`, or the (deprecated) `?token=` query param.
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // DEFAULT-DENY: every route is token-gated unless EXPLICITLY allowlisted here. Only three things are
    // public: (1) the static PWA shell/assets (the login screen must render before a token exists), and
    // (2) /health and (3) the one-use /pairing/claim exchange (below). CRITICAL: gate on the DECODED path
    // (and reject encoded separators) so this
    // matches the path Fastify's router actually routes — otherwise `GET /%73essions` (=/sessions) would
    // look public here yet reach the protected handler, bypassing the token check.
    const path = pathForGate(request.url);
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
    // A pairing claim exchanges a short-lived, single-use, 256-bit capability for one independently
    // revocable device credential. It is the ONLY public API mutation. Keep the exception exact, enforce
    // the normal browser Origin policy, and rate-limit malformed guesses before they reach SQLite.
    if (request.method === "POST" && path === "/pairing/claim" && !hasEncodedSep(request.url)) {
      const originAllowed = isOriginAllowed(request.headers.origin, request.headers.host, {
        publicUrl: config.publicUrl,
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
    let authenticatedPrincipal: PresencePrincipal | undefined = ticketRecord?.context;
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
    // puppeting the host. SAFE DEFAULT: allow absent / same-origin / loopback / public-URL
    // origins (the real PWA is always one of these); reject only a PRESENT foreign
    // Origin. The page cannot forge its Origin header, so this can never reject the genuine app.
    const originAllowed = isOriginAllowed(request.headers.origin, request.headers.host, {
      publicUrl: config.publicUrl,
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
    actorType: PresencePrincipal["actorType"];
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
        actorType: principal.actorType,
        actorId: principal.actorId,
      };
    }
    const token = extractBearerToken(request.headers.authorization);
    const device = token ? deviceStore.authenticate(token) : undefined;
    if (device) return { actorType: "device", actorId: device.id };
    if (!config.accessToken) return { actorType: "local", actorId: commandStore.getHost().id };
    // Current and brief rotation-grace host credentials intentionally share one idempotency identity.
    return { actorType: "host", actorId: commandStore.getHost().id };
  };

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
          bindingId?: unknown;
          grantId?: unknown;
        }
      | undefined;
    const targetType = path.split("/")[3] || "resource";
    const targetId = [rawParams?.id, rawParams?.bindingId, rawParams?.grantId, rawParams?.nodeId].find(
      (candidate): candidate is string => typeof candidate === "string",
    );
    const actor = actorForRequest(request);
    const context: MutationContext = { ...actor, route, targetType, ...(targetId ? { targetId } : {}) };
    mutationContexts.set(request, context);

    const rawKey = request.headers["idempotency-key"];
    if (rawKey === undefined) return;
    const key = Array.isArray(rawKey) ? undefined : rawKey.trim();
    if (!key || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
      reply.code(400).send({ code: "INVALID_IDEMPOTENCY_KEY", error: "idempotency-key must be 1-128 safe characters" });
      return;
    }
    // The concrete path is part of the operation identity. A route template alone would let the same key/body
    // target two different resources.
    const fingerprint = mutationFingerprint(request.method, path, request.body);
    const stored = idempotencyStore.get(actor.actorId, key);
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
    // API responses are intentionally small. Refuse to persist an unexpectedly large payload while
    // still returning it normally.
    if (Buffer.byteLength(body, "utf8") <= 256 * 1024) {
      try {
        const now = Date.now();
        idempotencyStore.put({
          actorId: context.actorId,
          key: context.idempotency.key,
          fingerprint: context.idempotency.fingerprint,
          statusCode: reply.statusCode,
          body,
          createdAt: now,
          expiresAt: now + IDEMPOTENCY_TTL_MS,
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
        const sessionMeta = terminalManager.get(id);
        if (!sessionMeta) {
          socket.close(4404, "terminal session not found");
          return;
        }
        const principal = authenticatedPrincipals.get(request) ?? hostPrincipal();
        if (principal.actorType === "device") {
          const sockets = remotePrincipalSockets.get(principal.actorId) ?? new Set<WebSocket>();
          sockets.add(socket);
          remotePrincipalSockets.set(principal.actorId, sockets);
        }
        // The client fits its terminal BEFORE connecting and passes the size as `?cols=&rows=`, so the pty/tmux
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
          if (principal.actorType === "device") {
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
        type TerminalClientMessage = {
          t?: string;
          d?: string;
          c?: number;
          r?: number;
          v?: boolean;
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
        const dispatchInput = (raw: Buffer) => {
          const msg = parseMessage(raw);
          if (!msg) return;
          try {
            if (msg.t === "i" && typeof msg.d === "string") terminalManager.write(id, msg.d);
            else if (msg.t === "r" && typeof msg.c === "number" && typeof msg.r === "number")
              terminalManager.resize(id, msg.c, msg.r);
            else if (msg.t === "v" && typeof msg.v === "boolean") sub?.setViewing(msg.v);
          } catch {
            closeSafely(4400, "terminal input failed");
          }
        };
        socket.on("message", (raw: Buffer) => {
          if (closed) return;
          const frame = Buffer.from(raw);
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
            size,
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
            const replay = pendingFrames;
            pendingFrames = [];
            pendingBytes = 0;
            for (const frame of replay) {
              if (closed || socket.readyState !== socket.OPEN || sub !== liveSub) break;
              dispatchInput(frame);
            }
          })
          .catch(async () => {
            if (closed || socket.readyState !== socket.OPEN) return;
            // Carry WHY the attach failed. Every attach error used to close as a bare 4404, which the client
            // renders as "<provider> exited" plus a sign-out hint — so a deleted working directory or a
            // missing tmux was reported to the user as "your agent is signed out", and both recovery buttons
            // just re-ran the same failing spawn. These two checks are facts, not string-matching on an
            // error message: the reason travels in the close reason, which older clients simply ignore.
            const reason = !terminalAvailable
              ? "attach-failed:terminal-unavailable"
              : (await stat(sessionMeta.cwd).then(
                    (s) => s.isDirectory(),
                    () => false,
                  ))
                ? "attach-failed"
                : "attach-failed:cwd-missing";
            if (!closed && socket.readyState === socket.OPEN) closeSafely(4404, reason);
          });
      },
    );
  });

  const launchShellSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    body: CreateSessionBody | undefined,
    v2Projection?: V2SessionProjection,
    requestedSessionId?: string,
  ) => {
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.cwd !== "string" ||
      Object.keys(body).some((key) => key !== "cwd" && key !== "mode") ||
      (body.mode !== undefined && body.mode !== "terminal")
    ) {
      reply.code(400).send({
        code: "INVALID_SESSION_REQUEST",
        error: "manual Sessions accept only cwd and mode",
      });
      return;
    }
    if (!terminalAvailable) {
      reply.code(400).send({
        code: "TERMINAL_UNAVAILABLE",
        error: "terminal mode unavailable",
        hint: "install tmux on the host (and ensure node-pty loads)",
      });
      return;
    }
    try {
      const cwdStat = await stat(body.cwd);
      if (!cwdStat.isDirectory()) {
        reply.code(400).send({ code: "INVALID_CWD", error: `cwd is not a directory: ${body.cwd}` });
        return;
      }
    } catch {
      reply.code(400).send({ code: "INVALID_CWD", error: `cwd does not exist: ${body.cwd}` });
      return;
    }
    const id = requestedSessionId ?? randomUUID();
    const existingMeta = requestedSessionId ? terminalManager.get(id) : undefined;
    if (
      !existingMeta &&
      config.maxSessions > 0 &&
      terminalManager.list().filter((terminal) => terminal.status === "running").length >= config.maxSessions
    ) {
      reply.code(429).send({ code: "SESSION_CAP_REACHED", error: sessionCapMessage });
      return;
    }
    let meta: ReturnType<TerminalManager["createShell"]>;
    try {
      if (existingMeta) {
        if (existingMeta.launch.kind !== "shell" || resolvePath(existingMeta.cwd) !== resolvePath(body.cwd)) {
          reply.code(409).send({
            code: "SESSION_IDENTITY_CONFLICT",
            error: "idempotent session identity belongs to another launch or directory",
          });
          return;
        }
        meta = existingMeta;
      } else {
        // Re-check after stat yielded so concurrent creates cannot exceed the host cap.
        if (
          config.maxSessions > 0 &&
          terminalManager.list().filter((terminal) => terminal.status === "running").length >= config.maxSessions
        ) {
          reply.code(429).send({ code: "SESSION_CAP_REACHED", error: sessionCapMessage });
          return;
        }
        meta = terminalManager.createShell({ id, cwd: body.cwd });
      }
    } catch {
      reply.code(500).send({ code: "SESSION_CREATE_FAILED", error: "Terminal could not be created" });
      return;
    }
    const synced = syncCommandAgent(meta.id, meta.activity);
    reply.code(201).send({
      session: {
        id: meta.id,
        launch: meta.launch,
        agent: meta.agent,
        cwd: meta.cwd,
        mode: meta.mode,
        status: meta.status,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        activity: meta.activity,
        awaiting: meta.awaiting,
        dangerouslySkip: false,
        name: meta.name,
        ...(v2Projection ?? {}),
        ...(synced ? { workspaceId: synced.placement.workspaceId } : {}),
      },
    });
  };
  const createSessionHandler = async (request: FastifyRequest<{ Body: CreateSessionBody }>, reply: FastifyReply) =>
    launchShellSession(request, reply, request.body);
  app.post<{ Body: CreateSessionBody }>("/sessions", createSessionHandler);

  // Unauthenticated liveness probe (the preHandler lets /health through). Returns only { ok: true }.
  app.get("/health", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { ok: true };
  });

  // DEVICE PAIRING: an authenticated device (or the host master token / explicit CLI command writing the
  // same durable store) issues a short-lived capability. The claim route is the sole public API mutation;
  // it returns a fresh per-device credential ONCE and persists only digests of both secrets.
  app.post("/pairing/start", async (_request, reply) => {
    if (!config.accessToken) {
      reply.code(409).send({ error: "device pairing is unavailable in tokenless development mode" });
      return;
    }
    try {
      reply.header("cache-control", "no-store").code(201).send(deviceStore.issuePairing());
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

  app.post<{ Body: { secret?: unknown; name?: unknown } }>(
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
        enrollment = deviceStore.claimPairing(secret, name);
      } catch {
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
    reply.code(204).send();
  });

  // VERSIONED COMMAND-CENTER API. The existing unversioned terminal routes remain compatible; v1 adds
  // stable host, workspace, agent, event, device, and presence resources.
  app.get("/api/v1/capabilities", async () => ({
    apiVersion: "v1",
    protocolVersion: 1,
    serverVersion: RUNNING_VERSION,
    serverTime: Date.now(),
    host: commandStore.getHost(),
    features: {
      workspaces: true,
      agents: true,
      resumableEvents: true,
      sharedLayout: true,
      idempotentMutations: true,
      devicePairing: Boolean(config.accessToken),
      presence: true,
    },
    providers: providers.descriptors().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      version: provider.version,
      schemaVersion: provider.schemaVersion,
      platforms: provider.platforms,
      resumeIdentity: provider.resumeIdentity,
      capabilities: provider.capabilities,
      stateAuthority: provider.stateAuthority,
      optionSchema: provider.optionSchema,
    })),
  }));

  app.get("/api/v1/hosts", async () => ({ hosts: [commandStore.getHost()] }));

  const validApiId = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);

  app.get<{
    Querystring: { hostId?: string; workspaceId?: string; sessionId?: string; agentId?: string };
  }>("/api/v1/presence", async (request, reply) => {
    const filters = request.query;
    if (Object.values(filters).some((value) => value !== undefined && !validApiId(value))) {
      reply.code(400).send({ code: "INVALID_PRESENCE_FILTER", error: "invalid presence filter" });
      return;
    }
    reply.header("cache-control", "no-store").send({ presence: presence.list(filters) });
  });

  app.post<{
    Body: { clientId?: unknown; workspaceId?: unknown; sessionId?: unknown; agentId?: unknown };
  }>("/api/v1/presence", async (request, reply) => {
    const { clientId, workspaceId: rawWorkspaceId, sessionId: rawSessionId, agentId: rawAgentId } = request.body ?? {};
    if (
      !validApiId(clientId) ||
      [rawWorkspaceId, rawSessionId, rawAgentId].some((value) => value !== undefined && !validApiId(value))
    ) {
      reply.code(400).send({ code: "INVALID_PRESENCE", error: "valid client and target are required" });
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
    try {
      const record = presence.heartbeat(principal, {
        clientId,
        hostId: commandStore.getHost().id,
        ...(workspaceId ? { workspaceId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
      });
      reply.code(200).send({ presence: record, heartbeatMs: PRESENCE_HEARTBEAT_MS });
    } catch {
      reply.code(400).send({ code: "INVALID_PRESENCE", error: "invalid presence heartbeat" });
    }
  });

  app.delete<{ Body: { clientId?: unknown } }>("/api/v1/presence", async (request, reply) => {
    if (!validApiId(request.body?.clientId)) {
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
      kind: "host" | "workspace" | "session" | "agent";
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
    commandStore.appendEvent("device.revoked", "device", request.params.id, {});
    reply.code(204).send();
  });

  app.get("/api/v1/adapters", async () => ({
    adapters: providers.descriptors(),
  }));

  app.get("/api/v1/openapi.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300").send(
      buildOpenApiDocument({
        serverVersion: RUNNING_VERSION,
        adapters: providers.descriptors(),
      }),
    );
  });

  app.get<{ Querystring: { includeArchived?: string } }>("/api/v1/workspaces", async (request) => {
    const includeArchived = request.query.includeArchived === "1";
    const attention = commandStore.listAttention();
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
    Body: { cwd?: unknown; label?: unknown };
  }>("/api/v1/workspaces", async (request, reply) => {
    const { cwd, label } = request.body ?? {};
    if (typeof cwd !== "string" || (label !== undefined && typeof label !== "string")) {
      reply.code(400).send({ code: "INVALID_WORKSPACE", error: "valid cwd and label are required" });
      return;
    }
    try {
      // listDirectory performs both lexical and realpath confinement, including symlink escape rejection.
      const described = await fsService.listDirectory(cwd);
      const workspace = commandStore.createWorkspace({
        cwd: described.path,
        ...(typeof label === "string" ? { label } : {}),
      });
      reply.code(201).send({ workspace });
    } catch (error) {
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
      const bounds = commandStore.eventBounds();
      return {
        protocolVersion: 1,
        cursor: bounds.latest,
        host: commandStore.getHost(),
        workspaces: commandStore.listWorkspaces(),
        agents: commandStore.listAgents(),
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

  const sessionSnapshots = () =>
    terminalManager.list().map((t) => {
      const synced = syncCommandAgent(t.id, t.status === "ended" ? "ended" : t.activity);
      return {
        id: t.id,
        launch: t.launch,
        agent: t.agent,
        ...(t.provider ? { provider: t.provider } : {}),
        cwd: t.cwd,
        mode: "terminal" as const,
        status: t.status,
        createdAt: t.createdAt,
        lastActivityAt: t.lastActivityAt,
        ...(synced
          ? {
              workspaceId: synced.placement.workspaceId,
              ...(synced.agent
                ? {
                    agentId: synced.agent.id,
                    agentActivity: synced.agent.activity,
                  }
                : {}),
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
        ...(t.provider ? { resumeIdentity: resumeIdentityFor(t.provider) } : {}),
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

  app.post<{
    Params: { id: string };
    Body: {
      active?: unknown;
      provider?: unknown;
      activity?: unknown;
      model?: unknown;
      effort?: unknown;
      providerSessionId?: unknown;
    };
  }>("/api/v1/sessions/:id/agent-state", { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const meta = terminalManager.get(request.params.id);
    if (!meta) {
      reply.code(404).send({ code: "SESSION_NOT_FOUND", error: "session not found" });
      return;
    }
    if (meta.launch.kind !== "shell") {
      reply.code(409).send({
        code: "SESSION_NOT_SHELL",
        error: "agent state can only be reported for a plain shell Session",
      });
      return;
    }
    const body = request.body ?? {};
    const allowedKeys = new Set(["active", "provider", "activity", "model", "effort", "providerSessionId"]);
    const textIsSafe = (value: unknown, maxLength: number): value is string =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength &&
      !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      reply.code(400).send({ code: "INVALID_AGENT_STATE", error: "invalid agent state report" });
      return;
    }
    if (body.active === false) {
      if (Object.keys(body).some((key) => key !== "active")) {
        reply.code(400).send({
          code: "INVALID_AGENT_STATE",
          error: "an inactive report cannot include agent fields",
        });
        return;
      }
      terminalManager.reportAgentState(request.params.id, undefined);
      syncCommandAgent(request.params.id, "idle");
      reply.code(202).send({ accepted: true, agent: null });
      return;
    }
    if (
      body.active !== true ||
      !textIsSafe(body.provider, 64) ||
      !["working", "blocked", "idle"].includes(typeof body.activity === "string" ? body.activity : "") ||
      (body.model !== undefined && !textIsSafe(body.model, 256)) ||
      (body.effort !== undefined && !textIsSafe(body.effort, 256)) ||
      (body.providerSessionId !== undefined && !textIsSafe(body.providerSessionId, 2048))
    ) {
      reply.code(400).send({
        code: "INVALID_AGENT_STATE",
        error: "active, provider, and activity are required; optional metadata must be bounded text",
      });
      return;
    }
    const accepted = terminalManager.reportAgentState(request.params.id, {
      provider: body.provider as ProviderId,
      activity: body.activity as "working" | "blocked" | "idle",
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
      ...(typeof body.providerSessionId === "string" ? { providerSessionId: body.providerSessionId } : {}),
    });
    if (!accepted) {
      reply.code(400).send({ code: "UNSUPPORTED_AGENT_PROVIDER", error: "unsupported agent provider" });
      return;
    }
    const current = terminalManager.get(request.params.id)?.agent;
    syncCommandAgent(request.params.id, current?.activity ?? "idle");
    reply.code(202).send({ accepted: true, agent: current });
  });

  app.post<{
    Params: { id: string };
    Body: { data?: unknown; appendNewline?: unknown };
  }>("/api/v1/sessions/:id/input", { bodyLimit: 96 * 1024 }, async (request, reply) => {
    const { data, appendNewline } = request.body ?? {};
    if (
      typeof data !== "string" ||
      Buffer.byteLength(data, "utf8") > 64 * 1024 ||
      (appendNewline !== undefined && typeof appendNewline !== "boolean") ||
      Object.keys(request.body ?? {}).some((key) => key !== "data" && key !== "appendNewline")
    ) {
      reply.code(400).send({
        code: "INVALID_SESSION_INPUT",
        error: "data must be a string up to 64 KiB; appendNewline must be boolean when supplied",
      });
      return;
    }
    if (!terminalManager.get(request.params.id)) {
      reply.code(404).send({ code: "SESSION_NOT_FOUND", error: "session not found" });
      return;
    }
    terminalManager.write(request.params.id, appendNewline === true ? `${data}\r` : data);
    commandStore.appendEvent("session.input_sent", "session", request.params.id, {
      byteLength: Buffer.byteLength(data, "utf8"),
    });
    reply.code(202).send({ accepted: true, focused: false });
  });

  app.post<{
    Params: { id: string };
    Body: { text?: unknown };
  }>(
    "/api/v1/sessions/:id/clipboard",
    // JSON may encode one UTF-8 byte as a six-byte Unicode escape. Keep the transport cap aligned with the
    // validated 512 KiB text contract without accepting an unbounded request body.
    { bodyLimit: HOST_CLIPBOARD_MAX_BYTES * 6 + 8 * 1024 },
    async (request, reply) => {
      const { text } = request.body ?? {};
      if (
        typeof text !== "string" ||
        text.length === 0 ||
        Buffer.byteLength(text, "utf8") > HOST_CLIPBOARD_MAX_BYTES ||
        Object.keys(request.body ?? {}).some((key) => key !== "text")
      ) {
        reply.code(400).send({
          code: "INVALID_CLIPBOARD_TEXT",
          error: `text must be a non-empty string up to ${HOST_CLIPBOARD_MAX_BYTES} bytes`,
        });
        return;
      }
      if (!terminalManager.get(request.params.id)) {
        reply.code(404).send({ code: "SESSION_NOT_FOUND", error: "session not found" });
        return;
      }
      try {
        await hostClipboard.writeText(text);
      } catch (error) {
        if (error instanceof HostClipboardError && (error.code === "EMPTY" || error.code === "TOO_LARGE")) {
          reply.code(400).send({ code: "INVALID_CLIPBOARD_TEXT", error: error.message });
          return;
        }
        reply.code(503).send({
          code: "HOST_CLIPBOARD_UNAVAILABLE",
          error: "the connected computer clipboard is unavailable",
        });
        return;
      }
      reply.code(200).send({ copied: true, target: "host" });
    },
  );

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
    stopAndRemoveSession(request.params.id);
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
    stopAndRemoveSession(id);
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
          reply.code(404).send(fsSystemFailure(err));
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

  // Claude lifecycle hooks make submit, tool, permission, and stop transitions immediate. A native blocker is
  // latched until submit/post-tool/ordinary-tool/user input resumes it, so stale spinner chrome cannot hide an
  // unanswered question. The live-screen manifest remains the fallback for sessions without hooks; old hook
  // files that send no JSON body are deliberately ignored. Token-gated globally; body size is bounded here.
  app.post<{ Params: { id: string }; Querystring: { event?: string }; Body: unknown }>(
    "/sessions/:id/hook",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const sessionId = request.params.id;
      const meta = terminalManager.get(sessionId);
      if (!meta) {
        reply.code(404).send({ error: "session not found" });
        return;
      }
      const event = request.query.event;
      if (!event || !(CLAUDE_HOOK_EVENTS as readonly string[]).includes(event)) {
        reply.code(400).send({ error: "unknown event" });
        return;
      }
      const activity = claudeHookActivity(event as ClaudeHookEvent, request.body);
      const applied = activity ? terminalManager.reportProviderActivity(sessionId, "claude", activity) : false;
      reply.code(200).send({ ok: true, applied });
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

  // POST /push/test → send a harmless "notifications are working ✓" ping only to the endpoint held by the
  // browser that pressed the button. Older code fanned out to every stored row and reported success when any
  // device's push service accepted it, so a stale/desktop row could falsely certify an iPhone. Always 200;
  // the body's `ok` means the target push service accepted it, not that the OS displayed a banner.
  // Token-gated by the global preHandler (the whole /push/* namespace is in API_PATH_DENYLIST).
  app.post<{ Body?: { endpoint?: string; testId?: string } }>("/push/test", async (request, reply) => {
    const { pushDispatcher, pushStore } = deps;
    if (!pushDispatcher || !pushStore) {
      reply.code(200).send({ ok: false, reason: "push not configured" });
      return;
    }
    const endpoint = request.body?.endpoint;
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      reply.code(200).send({ ok: false, reason: "current device subscription is required; reopen the app and retry" });
      return;
    }
    const rawTestId = request.body?.testId;
    const testId = typeof rawTestId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(rawTestId) ? rawTestId : undefined;
    // Refreshing the current subscription immediately before this request happens client-side. Exact endpoint
    // targeting here then tests those current encryption keys rather than an unrelated or orphaned store row.
    const report = await pushDispatcher.dispatch({ kind: "test", ...(testId ? { testId } : {}) }, { endpoint });
    if (report.attempted === 0) {
      reply.code(200).send({ ok: false, attempted: 0, delivered: 0, reason: "this device is not registered for push" });
      return;
    }
    const rejection = report.failures[0];
    reply.code(200).send({
      ok: report.attempted === 1 && report.delivered === 1,
      attempted: report.attempted,
      delivered: report.delivered,
      ...(rejection
        ? {
            reason: rejection.statusCode
              ? `the push service rejected it (HTTP ${rejection.statusCode}${
                  rejection.reason ? `: ${rejection.reason}` : ""
                })`
              : `delivery failed (${rejection.message ?? "unknown error"})`,
          }
        : {}),
    });
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

  // GET /diag → authenticated host diagnostics (token-gated by the global preHandler; distinct from
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
    const revokedDevices = deviceStore.revokeAll();
    for (const actorId of [...remotePrincipalSockets.keys()]) closeRemotePrincipalSockets(actorId);
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
          availability = await provider.probe();
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

  const currentNodeOwner = () => ({ type: "person" as const, id: commandStore.getHost().id });
  const currentNode = () =>
    projectNodeRecord({
      host: commandStore.getHost(),
      owner: currentNodeOwner(),
      status: terminalAvailable ? "online" : "degraded",
      platform: `${process.platform}-${process.arch}`,
      lastSeenAt: Date.now(),
    });
  const currentProductContext = () => {
    const owner = currentNodeOwner();
    return { kind: "personal" as const, id: owner.id, name: "Personal" };
  };
  const sendNodeNotFound = (reply: FastifyReply): void => {
    reply.code(404).send({ code: "NODE_NOT_FOUND", error: "node not found" });
  };
  const isCurrentNode = (nodeId: string): boolean => nodeId === commandStore.getHost().id;
  const readAgentRuntimeAuthStates = async (): Promise<Record<string, AgentRuntimeAuthState>> => {
    const states: Record<string, AgentRuntimeAuthState> = {};
    if (deps.claudeAuth && providers.has("claude")) {
      try {
        states.claude = (await deps.claudeAuth.status()).loggedIn ? "ready" : "required";
      } catch {
        states.claude = "error";
      }
    }
    if (deps.codexMetadata && providers.has("codex")) {
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
      const provider = session.agent?.provider;
      if (session.status !== "running" || !provider) continue;
      activeSessionCountByProvider[provider] = (activeSessionCountByProvider[provider] ?? 0) + 1;
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
        claude: deps.claudeAuth ? ["authentication"] : [],
        codex: deps.codexMetadata ? ["authentication"] : [],
      },
      observedAt: Date.now(),
    });
  };
  const projectV2Session = (session: ReturnType<typeof sessionSnapshots>[number]) => {
    const { agentId, agentActivity, ...publicSession } = session;
    void agentId;
    void agentActivity;
    const runtimeProvider = session.agent?.provider ?? session.provider;
    return {
      ...publicSession,
      nodeId: commandStore.getHost().id,
      ...(runtimeProvider ? { agentRuntimeId: agentRuntimeId(commandStore.getHost().id, runtimeProvider) } : {}),
    };
  };
  const validObjectBody = (body: unknown): body is Record<string, unknown> =>
    typeof body === "object" && body !== null && !Array.isArray(body);
  const hasOnlyKeys = (body: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
    Object.keys(body).every((key) => allowed.has(key));
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
      if (!validObjectBody(body) || !hasOnlyKeys(body, new Set(["cwd"])) || typeof body.cwd !== "string") {
        reply.code(400).send({ code: "INVALID_NODE_SESSION", error: "invalid node session request" });
        return;
      }
      await launchShellSession(request, reply, { cwd: body.cwd }, { nodeId: request.params.nodeId });
    },
  );

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
        reply.code(400).send(fsSystemFailure(err));
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
        reply.code(400).send(fsSystemFailure(err));
      }
    }
  });

  // GET /fs/search?q=<substr>&base=<abs dir, default fsRoot> → { results: [{path,name}] }:
  // case-insensitive substring match on DIRECTORY names for the picker's deep-search flow.
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
        reply.code(400).send(fsSystemFailure(err));
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
        return reply.code(404).send(fsSystemFailure(err));
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
    clearInterval(sharedSweepTimer);
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
      idempotencyStore.close();
    } catch {
      /* continue closing */
    }
    try {
      presence.close();
    } catch {
      /* continue closing */
    }
    try {
      deps.pushStore?.close();
    } catch {
      /* every owned resource gets an independent teardown attempt */
    }
  });

  return {
    app,
    authGate,
    terminalManager,
    terminalAvailable,
    presence,
    issuePairing: () => deviceStore.issuePairing(),
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
