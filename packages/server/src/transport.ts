import { randomUUID } from "node:crypto";
import { basename as pathBasename } from "node:path";
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
import type { SessionStore, StoreMode } from "./session-store.js";
import {
  TERMINAL_FILE_TTL_MS,
  TERMINAL_SWEEP_INTERVAL_MS,
  terminalSharedBase,
  terminalSharedDir,
} from "./terminal-shared.js";
import type { PushStore } from "./push-store.js";
import type { PushDispatcher, PushEvent } from "./push-dispatch.js";
import { createUpdater, RUNNING_BUILD } from "./updater.js";
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
import { parseProviderOptions, ProviderOptionsError } from "./providers/options.js";
import { ProviderError, type ProviderAvailability, type ProviderId } from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createClaudeProvider } from "./providers/claude-provider.js";
import { createCodexProvider } from "./providers/codex-provider.js";
import type { CodexMetadataService } from "./providers/codex-metadata-service.js";
import type { ClaudeMetadataService } from "./providers/claude-metadata-service.js";
import type { CodexLatestService } from "./providers/codex-latest-service.js";
import type { CodexThreadResolver } from "./providers/codex-thread-resolver.js";
import { normalizeSessionDefaults, SessionDefaultsConflictError } from "./session-defaults.js";

/** Terminal WS guards. Input: cap a single frame so a client can't force a huge alloc / flood the pty (1MB
 *  still allows large pastes). Output: if the client buffers more than this undrained, close (it reconnects
 *  and tmux redraws) rather than grow Node's heap unbounded on a slow link. */
const MAX_TERMINAL_INPUT_BYTES = 1_000_000;
const MAX_PENDING_TERMINAL_INPUT_FRAMES = 64;
const MAX_PENDING_TERMINAL_INPUT_BYTES = 1_000_000;
const MAX_TERMINAL_WS_BUFFER = 16_000_000;
/** Server→client WS ping cadence. An idle terminal (no output, no keystrokes) carries zero WS traffic, so
 *  a fronting proxy (e.g. Cloudflare Tunnel's ~100s idle cap) would drop the connection and force the client
 *  to flap through a reconnect. A periodic ping keeps the link warm (the browser auto-pongs). Well under any
 *  common proxy idle timeout. */
const TERMINAL_WS_PING_MS = 25_000;

export interface CreateServerDeps {
  store?: SessionStore;
  /** Absolute path to the built PWA (packages/web/dist). When set, the server also serves the UI. */
  webDir?: string;
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
   * In-app OTA self-update (GET /version, POST /update, GET /update/status). Injected here so tests can
   * pass a fake Updater (FIXTURE git output) without touching real git. When omitted a real Updater is
   * built from `config.dataDir` — and if the server isn't running from a git checkout, /version simply
   * reports `updatable:false` (the feature is off).
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
}

export interface CreateServerResult {
  app: FastifyInstance;
  authGate: AuthGate;
  /** Exposed so startServer can late-bind the MCP attach config (after listen() resolves the port) —
   *  this is what gives the terminal's claude send_image/send_file. */
  terminalManager: TerminalManager;
  /** False when tmux/node-pty is unavailable → terminal sessions are disabled (startServer warns loudly). */
  terminalAvailable: boolean;
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
  const store = deps.store ?? openSessionStore({ dbPath: ":memory:" });
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
      onFinished: (id, wasAttached) => {
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
  const authGate = deps.authGate ?? new AuthGate({ token: config.accessToken });
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
  const fsService = new FsService({ root: config.fsRoot });
  // Terminal uploads live under the app data dir (outside any project repo — see terminal-shared.ts), one
  // folder per session. Bound their lifetime: prune files past the TTL across EVERY session folder under the
  // shared base — once at boot (catches files that aged out while the server was down, and orphaned folders
  // whose session is gone) and on a periodic timer. (Also pruned on each upload.) unref() so the timer never
  // keeps the process alive.
  const terminalSharedRoot = terminalSharedBase({ dataDir: config.dataDir, fsRoot: config.fsRoot });
  const sweepSharedFiles = (): void => {
    void fsService.pruneChildDirsOlderThan(terminalSharedRoot, TERMINAL_FILE_TTL_MS).catch(() => 0);
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
  // OTA self-update. A real Updater reads/writes its status file in the data dir and runs git there;
  // tests inject a fake with FIXTURE git output (no real git mutation). The real Updater reads the
  // ROAMCODE_SERVICE_LABEL/_MANAGER overrides from process.env (its default) when resolving how to
  // restart the service after a successful build.
  const updater = deps.updater ?? createUpdater({ dataDir: config.dataDir });
  const storeMode: StoreMode = deps.storeMode ?? "sqlite";
  // Single-use WS tickets (POST /ws-ticket) — the preferred terminal-WS credential; see ws-ticket.ts.
  const wsTickets = deps.wsTickets ?? new WsTicketStore();

  // trustProxy makes request.ip honour X-Forwarded-For behind a reverse proxy, so the
  // per-client auth lockout keys on the real client IP (see Task 4's proxy caveat).
  const app = Fastify({ logger: false, trustProxy: config.trustProxy ?? false });

  // Multipart uploads, capped at the configured size.
  app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });

  // Global token gate — applies to BOTH REST routes AND the WebSocket upgrade request
  // (a Fastify global preHandler runs for the WS route's GET upgrade and a 401 there
  // aborts the upgrade — verified). The token for a WS upgrade may arrive in the
  // Authorization header, a single-use `?ticket=`, or the (deprecated) `?token=` query param.
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // DEFAULT-DENY: every route is token-gated unless EXPLICITLY allowlisted here. Only two things are
    // public: (1) the static PWA shell/assets (the login screen must render before a token exists), and
    // (2) /health (below). CRITICAL: gate on the DECODED path (and reject encoded separators) so this
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
    // /health is an unauthenticated liveness probe (a launchd/cloudflared/uptime check can't present a
    // token). It returns only { ok: true } — no sensitive data — so it's safe to leave open.
    if (path === "/health") return;
    // No token configured (loopback dev): allow. Non-loopback w/o token is blocked at startup.
    if (!config.accessToken) return;
    // `?token=a&token=b` parses to an array — only a single string is a usable token.
    // Anything else (array, missing) becomes undefined so the auth path can't be fed a non-string.
    const q = request.query as { token?: unknown; ticket?: unknown };
    const queryToken = typeof q?.token === "string" ? q.token : undefined;
    const queryTicket = typeof q?.ticket === "string" ? q.ticket : undefined;
    const isWsUpgradePath = path.endsWith("/ws") || path.endsWith("/terminal");
    // PREFERRED WS auth: a single-use short-TTL ticket from POST /ws-ticket. Consuming it here means a
    // WS URL that lands in a proxy/access log carries an already-spent, ~30s credential instead of the
    // long-lived token. Origin + rate-limit checks below still apply to a ticket-authed upgrade.
    const ticketOk = isWsUpgradePath && queryTicket !== undefined && wsTickets.consume(queryTicket);
    if (!ticketOk) {
      // Accept the token from `?token=` ONLY on routes a browser genuinely can't send an Authorization
      // header on: the WS upgrade (`/sessions/:id/ws|/terminal` — DEPRECATED, kept so bundles from before
      // the ticket flow keep reconnecting; new clients use ?ticket=), <img> media GETs (`/images/*`), and
      // file downloads (`/fs/download`). Every other route uses the header — so the access token isn't
      // written into proxy / access logs (query strings are routinely logged), which would otherwise leak
      // a full-access credential.
      const queryTokenAllowed = isWsUpgradePath || path.startsWith("/images/") || path === "/fs/download";
      const token = extractBearerToken(request.headers.authorization) ?? (queryTokenAllowed ? queryToken : undefined);
      const result = authGate.check(token, request.ip);
      if (!result.ok) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
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
        const dispatchInput = (raw: Buffer) => {
          if (raw.length > MAX_TERMINAL_INPUT_BYTES) return;
          let msg: { t?: string; d?: string; c?: number; r?: number };
          try {
            msg = JSON.parse(raw.toString()) as typeof msg;
          } catch {
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
          .catch(() => {
            if (!closed && socket.readyState === socket.OPEN) closeSafely(4404, "terminal attach failed");
          });
      },
    );
  });

  app.post<{ Body: CreateSessionBody }>("/sessions", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.cwd !== "string") {
      reply.code(400).send({ error: "cwd is required" });
      return;
    }
    const requestedProvider = body.provider === undefined ? "claude" : body.provider;
    if (requestedProvider !== "claude" && requestedProvider !== "codex") {
      reply.code(400).send({ code: "INVALID_PROVIDER", error: "Invalid provider" });
      return;
    }
    const provider: ProviderId = requestedProvider;
    // Terminal is the only mode: spawn a pty-backed tmux session.
    if (!terminalAvailable) {
      reply
        .code(400)
        .send({ error: "terminal mode unavailable", hint: "install tmux on the host (and ensure node-pty loads)" });
      return;
    }
    try {
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
    if (config.maxSessions > 0 && liveTerminals >= config.maxSessions) {
      reply.code(429).send({ error: sessionCapMessage });
      return;
    }
    // Validate the cwd up-front (it's a real directory) so a bad path fails the CREATE with a clear error
    // instead of silently failing later when the pty lazily spawns on first attach.
    try {
      const s = await stat(body.cwd);
      if (!s.isDirectory()) {
        reply.code(400).send({ error: `cwd is not a directory: ${body.cwd}` });
        return;
      }
    } catch {
      reply.code(400).send({ error: `cwd does not exist: ${body.cwd}` });
      return;
    }
    const id = randomUUID();
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
      options = parseProviderOptions(provider, rawOptions);
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
      config.maxSessions > 0 &&
      terminalManager.list().filter((t) => t.status === "running").length >= config.maxSessions
    ) {
      reply.code(429).send({ error: sessionCapMessage });
      return;
    }
    let meta: ReturnType<TerminalManager["create"]>;
    try {
      meta =
        options.provider === "claude"
          ? terminalManager.create({ id, cwd: body.cwd, provider: "claude", options })
          : terminalManager.create({ id, cwd: body.cwd, provider: "codex", options });
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
    // Return `{ session }` (not a flat body). The web client does `return (await res.json()).session`.
    // Shape the session like a SessionMeta (mode:"terminal" so the client routes to TerminalView). Echo the
    // derived dangerouslySkip so the rail badges an RCE-skip session from the moment it's created.
    reply.code(201).send({
      session: {
        id: meta.id,
        provider: meta.provider,
        cwd: meta.cwd,
        mode: "terminal" as const,
        status: meta.status,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        dangerouslySkip: meta.dangerouslySkip,
        // Echo the runtime flags so the chat header shows what's actually running from the first render.
        model: meta.model,
        effort: meta.effort,
        permissionMode: meta.permissionMode,
        sandbox: meta.sandbox,
        approvalPolicy: meta.approvalPolicy,
        identityState: meta.identityState,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  });

  // Unauthenticated liveness probe (the preHandler lets /health through). Returns only { ok: true }.
  app.get("/health", async () => ({ ok: true }));

  const unsetSessionDefaults = { defaults: null, revision: 0 } as const;
  const sessionDefaultsEnvelope = (stored: ReturnType<SessionStore["getSessionDefaults"]>) =>
    stored
      ? {
          defaults: normalizeSessionDefaults(stored.defaults),
          revision: stored.revision,
          updatedAt: stored.updatedAt,
        }
      : unsetSessionDefaults;

  // One authoritative defaults document shared by every browser connected to this server. These routes
  // are authenticated by the global default-deny preHandler. PUT is compare-and-swap so a stale browser
  // never silently overwrites a newer save from another device.
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

  app.get("/sessions", async () => {
    const sessions = terminalManager.list().map((t) => ({
      id: t.id,
      provider: t.provider,
      cwd: t.cwd,
      mode: "terminal" as const,
      status: t.status,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      // Live activity from the capture-pane monitor (working | blocked | idle) — the rail's per-session status.
      activity: t.activity,
      // Loud "needs you" flag = activity==="blocked" (claude waiting on YOUR decision). The SessionList badge +
      // count + away push key off this; a merely-idle or still-working session is NOT awaiting.
      awaiting: t.awaiting,
      // Whether this session runs with --dangerously-skip-permissions, so the rail can badge the RCE-skip risk.
      dangerouslySkip: t.dangerouslySkip,
      // Runtime flags the session spawned with, so the chat header shows what's REALLY running (and survives a
      // reload / a server restart, since both derive from the persisted claudeArgs). Absent = claude's default.
      model: t.model,
      effort: t.effort,
      permissionMode: t.permissionMode,
      sandbox: t.sandbox,
      approvalPolicy: t.approvalPolicy,
      // User-set display name (PATCH /sessions/:id). `undefined` serializes to ABSENT, so the field only
      // appears when a name is actually set — clients `?? cwd` for the label.
      name: t.name,
      identityState: t.identityState,
      providerSessionId: t.providerSessionId,
    }));
    return { sessions };
  });

  // Rename a session (server-side, so the name shows on EVERY device and survives restarts). Contract:
  // {name: string} trims + sets; an empty/whitespace-only string, null, or an absent field CLEARS back to
  // unnamed. 204 on success, 404 for an unknown id, 400 for a non-string/oversized name. Token-gated by
  // the global default-deny preHandler.
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/sessions/:id", async (request, reply) => {
    const { id } = request.params;
    if (!terminalManager.get(id)) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    const raw = request.body?.name;
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      reply.code(400).send({ error: "name must be a string or null" });
      return;
    }
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    // A UI label, not a document — cap it so a runaway client can't bloat every GET /sessions response.
    if (trimmed.length > 120) {
      reply.code(400).send({ error: "name too long (max 120 characters)" });
      return;
    }
    terminalManager.setName(id, trimmed.length > 0 ? trimmed : undefined);
    reply.code(204).send();
  });

  // Close a session: stop its live process AND remove it from the list + store. Idempotent — deleting an
  // unknown id is a 204 no-op, not a 404 — so a double-close / a stale client both succeed.
  app.delete<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const { id } = request.params;
    if (terminalManager.get(id)) terminalManager.stop(id);
    reply.code(204).send();
  });

  // Legacy stop endpoint — kept working, converges on full removal (stop + delete). 404 only when the
  // session is already gone, preserving the old "stop a known session" contract.
  app.post<{ Params: { id: string } }>("/sessions/:id/stop", async (request, reply) => {
    const { id } = request.params;
    if (!terminalManager.get(id)) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    terminalManager.stop(id);
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
      try {
        described = await fsService.describeForAttachment(body.path);
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
      // Push a control frame over the terminal WS (the client renders it in the Files panel). The manager
      // also BUFFERS this frame so a client that (re)connects later still sees the file (replay on attach).
      terminalManager.pushControl(sessionId, {
        t: "attach",
        id,
        path: body.path,
        name: described.name,
        caption,
        isImage,
      });
      // Away-from-desk: ping the phone that a file arrived. Fire-and-forget (dispatch never throws/blocks).
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
      deps.pushStore.upsert({
        endpoint: b.endpoint,
        p256dh: b.keys.p256dh,
        auth: b.keys.auth,
        sessionId: typeof b.sessionId === "string" ? b.sessionId : undefined,
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
      // `?force=1` (the in-app "Check for updates") bypasses the cached git check for a fresh fetch.
      const force = (request.query as { force?: string } | undefined)?.force === "1";
      const version = await updater.getVersion(force);
      return { ...version, terminalAvailable };
    } catch (err) {
      // A git/spawn failure must not 500 the open-on-load probe — report a non-updatable version. The
      // running build sha is still reported (a property of the bundle, not the checkout); with no HEAD to
      // compare against, buildDrift is false.
      reply.code(200).send({
        current: "—",
        latest: "—",
        behind: 0,
        updatable: false,
        updateAvailable: false,
        changelog: [],
        runningBuild: RUNNING_BUILD,
        buildDrift: false,
        terminalAvailable,
        error: (err as Error).message,
      });
    }
  });

  // POST /update {confirm:true} → spawn the detached pull+build+restart updater, return 202. The
  // confirm flag is a deliberate double-gate (alongside the token + the remote-URL guard) for an
  // action that is RCE-by-design (it rebuilds + restarts this server from our own repo).
  app.post<{ Body: { confirm?: boolean } }>("/update", async (request, reply) => {
    if (request.body?.confirm !== true) {
      reply.code(400).send({ error: "confirm:true is required to apply an update" });
      return;
    }
    let result;
    try {
      result = await updater.startUpdate();
    } catch (err) {
      reply.code(409).send({ error: (err as Error).message });
      return;
    }
    if (!result.started) {
      reply.code(409).send({ error: result.reason ?? "update not available" });
      return;
    }
    reply.code(202).send({ ok: true, state: "starting" });
  });

  // GET /update/status → the detached updater's status file {state,phase,error?,target?,log?}.
  app.get("/update/status", async () => {
    return updater.readStatus();
  });

  // POST /update/rollback {confirm:true} → like /update, but targets the RECORDED pre-update sha
  // (<dataDir>/last-good-sha, written by every startUpdate before it moves the checkout): the same
  // detached pipeline (dirty-tree guard → reset → install → build → boot-smoke → restart) in target-sha
  // mode. GET /update/status reports progress exactly like a normal update. 400 without the confirm
  // double-gate; 409 when there is no recorded sha or an update is already running.
  app.post<{ Body: { confirm?: boolean } }>("/update/rollback", async (request, reply) => {
    if (request.body?.confirm !== true) {
      reply.code(400).send({ error: "confirm:true is required to roll back" });
      return;
    }
    const targetSha = updater.readLastGoodSha();
    if (!targetSha) {
      reply.code(409).send({ error: "no last-good sha recorded (no update has run from this data dir yet)" });
      return;
    }
    let result;
    try {
      result = await updater.startUpdate({ targetSha });
    } catch (err) {
      reply.code(409).send({ error: (err as Error).message });
      return;
    }
    if (!result.started) {
      reply.code(409).send({ error: result.reason ?? "rollback not available" });
      return;
    }
    reply.code(202).send({ ok: true, state: "starting", target: targetSha });
  });

  // GET /diag → authed fleet-observability snapshot (token-gated by the global preHandler; distinct from
  // the minimal unauthenticated /health). Reports: the running BUILD sha + buildDrift (build-vs-checkout),
  // storeMode (sqlite vs the non-durable memory fallback), best-effort claude availability+version
  // (cached; never blocks long), node version, and the last update state. Never 500s — each field degrades
  // independently so one failing probe can't take down the whole diagnostic.
  app.get("/diag", async () => {
    let buildDrift = false;
    let current = "—";
    try {
      const v = await updater.getVersion();
      buildDrift = v.buildDrift;
      current = v.current;
    } catch {
      // a git/spawn failure must not 500 /diag — leave the defaults
    }
    let claude: { available: boolean; version?: string };
    try {
      claude = await claudeVersionProbe.get();
    } catch {
      claude = { available: false };
    }
    return {
      current,
      runningBuild: RUNNING_BUILD,
      buildDrift,
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
      persistAccessToken(config.dataDir, next);
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

  // POST /ws-ticket → { ticket, expiresInMs }: a single-use, ~30s credential for the terminal WS URL
  // (`?ticket=<t>`), so the LONG-LIVED token never has to ride in a WS query string (query strings are
  // routinely written into proxy/access logs). Token-gated by the global default-deny preHandler — only
  // a client that already holds the real token can mint tickets. Consumed (and thus dead) by the very
  // upgrade that presents it; see the preHandler + ws-ticket.ts.
  app.post("/ws-ticket", async () => wsTickets.issue());

  const providerFrom = (raw: string): ProviderId | undefined => (raw === "claude" || raw === "codex" ? raw : undefined);
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

  const readProviderAvailability = async (): Promise<Partial<Record<ProviderId, ProviderAvailability>>> => {
    const capabilityByProvider: Partial<Record<ProviderId, ProviderAvailability>> = {};
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
        if (provider.id === "codex") {
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
      reply.code(400).send({ error: "path is required" });
      return;
    }
    try {
      const file = await fsService.readFileForDownload(request.query.path);
      reply
        .header("content-disposition", contentDisposition(file.filename))
        .header("content-type", "application/octet-stream")
        .send(file.data);
    } catch (err) {
      if (err instanceof FsError) {
        reply.code(err.code === "forbidden" ? 403 : 404).send({ error: err.message });
      } else {
        reply.code(404).send({ error: (err as Error).message });
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
  // Terminal upload (user → claude): save the file under the session's shared-files folder in the app DATA
  // dir (NOT the project tree — a file there would dirty the git checkout and block the OTA updater; see
  // terminal-shared.ts), prune anything past the 7-day TTL, and return the absolute path (the client hands
  // it to the terminal so claude can read it). Server owns the location so the client can't target an
  // arbitrary dir. Token-gated by the global preHandler.
  app.post<{ Params: { id: string } }>("/sessions/:id/upload", async (request, reply) => {
    const meta = terminalManager.get(request.params.id);
    if (!meta) {
      reply.code(404).send({ error: "terminal session not found" });
      return;
    }
    let dir: string;
    try {
      dir = await fsService.ensureDirWithinRoot(
        terminalSharedDir({ dataDir: config.dataDir, fsRoot: config.fsRoot, sessionId: meta.id }),
      );
    } catch (err) {
      const code = err instanceof FsError && err.code === "forbidden" ? 403 : 400;
      reply.code(code).send({ error: (err as Error).message });
      return;
    }
    await fsService.pruneOlderThan(dir, TERMINAL_FILE_TTL_MS).catch(() => 0); // best-effort, before saving
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
      reply.code(413).send({ error: (err as Error).message });
      return;
    }
    if (data.file.truncated) {
      reply.code(413).send({ error: "file exceeds the upload size limit" });
      return;
    }
    try {
      const written = await fsService.writeUploadedFile(dir, data.filename, buffer);
      reply.code(201).send({ path: written.path });
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
  });

  // shadows the API/WS routes above (the SPA fallback is scoped by isPublicPath).
  if (deps.webDir) registerStatic(app, { webDir: deps.webDir });

  // Graceful shutdown: app.close() stops the file-sweep timer and closes the SQLite-backed stores opened
  // by startServer (session, push) so their DB handles are released — they're opened once at boot and never
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
      deps.pushStore?.close();
    } catch {
      /* every owned resource gets an independent teardown attempt */
    }
  });

  return { app, authGate, terminalManager, terminalAvailable };
}

/**
 * Build a safe `Content-Disposition` value for a download. A filename containing `"`, `\`, or a
 * CR/LF could break out of the header (header injection) or corrupt the quoted-string. We strip
 * control chars for the ASCII `filename=` fallback (quotes/backslashes escaped) and carry the full
 * UTF-8 name via RFC 5987 `filename*=` (percent-encoded), which modern clients prefer.
 */
function contentDisposition(filename: string): string {
  // Drop control chars (incl. CR/LF) from the ASCII fallback, then escape `\` and `"`.
  const ascii = filename.replace(/[\x00-\x1f\x7f"\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
