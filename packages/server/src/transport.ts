import { randomUUID } from "node:crypto";
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
import { registerStatic, isPublicForRequest, pathForGate } from "./static-routes.js";
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
import { createUpdater, RUNNING_BUILD } from "./updater.js";
import type { Updater } from "./updater.js";
import { createClaudeVersionProbe, defaultRunClaudeVersion } from "./diag.js";
import type { ClaudeVersionProbe } from "./diag.js";
import type { UsageService } from "./usage-service.js";
import type { ClaudeAuthService } from "./claude-auth-service.js";
import type { ClaudeLatestService } from "./claude-latest-service.js";
import { TerminalManager } from "./terminal-manager.js";
import { detectTerminalSupport } from "./terminal-capability.js";
import { listTmuxSessions } from "./tmux-list.js";
import { openSessionStore } from "./session-store.js";

/** Terminal WS guards. Input: cap a single frame so a client can't force a huge alloc / flood the pty (1MB
 *  still allows large pastes). Output: if the client buffers more than this undrained, close (it reconnects
 *  and tmux redraws) rather than grow Node's heap unbounded on a slow link. */
const MAX_TERMINAL_INPUT_BYTES = 1_000_000;
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
  cwd: string;
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

/** Permission modes the claude CLI actually accepts (POST /sessions validates against this). */
const VALID_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"]);
/** A model id must be a short, sane token. Defense-in-depth: it becomes claude argv (no shell, so not an
 *  injection vector), but an operator-supplied value shouldn't be unbounded/arbitrary. */
const isValidModel = (m: string): boolean => m.length > 0 && m.length <= 64 && /^[\w./:@-]+$/.test(m);

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
  const terminalManager =
    deps.terminalManager ??
    new TerminalManager({
      store: deps.store ?? openSessionStore({ dbPath: ":memory:" }),
      claudeBin: config.claude.claudeBin,
      now: () => Date.now(),
    });
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
  const sessionCapMessage = `live session cap reached (${config.maxSessions}); close a session or raise REMOTE_CODER_MAX_SESSIONS`;
  // OTA self-update. A real Updater reads/writes its status file in the data dir and runs git there;
  // tests inject a fake with FIXTURE git output (no real git mutation). The real Updater reads the
  // REMOTE_CODER_SERVICE_LABEL/_MANAGER overrides from process.env (its default) when resolving how to
  // restart the service after a successful build.
  const updater = deps.updater ?? createUpdater({ dataDir: config.dataDir });
  const storeMode: StoreMode = deps.storeMode ?? "sqlite";
  // trustProxy makes request.ip honour X-Forwarded-For behind a reverse proxy, so the
  // per-client auth lockout keys on the real client IP (see Task 4's proxy caveat).
  const app = Fastify({ logger: false, trustProxy: config.trustProxy ?? false });

  // Multipart uploads, capped at the configured size.
  app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });

  // Global token gate — applies to BOTH REST routes AND the WebSocket upgrade request
  // (a Fastify global preHandler runs for the WS route's GET upgrade and a 401 there
  // aborts the upgrade — verified). The token for a WS upgrade may arrive in the
  // Authorization header or the `?token=` query param, so accept either here.
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // Public static shell (HTML/JS/CSS/icons/manifest/sw + SPA navigations) loads WITHOUT a token
    // so the login screen can render and THEN authenticate. API/WS/health/push stay gated below.
    // CRITICAL: gate on the DECODED path (and reject encoded separators) so this matches the path
    // Fastify's router actually routes — otherwise `GET /%73essions` (=/sessions) would look public
    // here yet reach the protected handler, bypassing the token check. See isPublicForRequest.
    if (isPublicForRequest(request.url)) return;
    const path = pathForGate(request.url);
    // /health is an unauthenticated liveness probe (a launchd/cloudflared/uptime check can't present a
    // token). It returns only { ok: true } — no sensitive data — so it's safe to leave open.
    if (path === "/health") return;
    // No token configured (loopback dev): allow. Non-loopback w/o token is blocked at startup.
    if (!config.accessToken) return;
    // `?token=a&token=b` parses to an array — only a single string is a usable token.
    // Anything else (array, missing) becomes undefined so the auth path can't be fed a non-string.
    const q = request.query as { token?: unknown };
    const queryToken = typeof q?.token === "string" ? q.token : undefined;
    // Accept the token from `?token=` ONLY on routes a browser genuinely can't send an Authorization
    // header on: the WS upgrade (`/sessions/:id/ws`), <img> media GETs (`/images/*`), and file downloads
    // (`/fs/download`). Every other route uses the header — so the access token isn't written into proxy /
    // access logs (query strings are routinely logged), which would otherwise leak a full-access credential.
    const queryTokenAllowed =
      path.endsWith("/ws") || path.endsWith("/terminal") || path.startsWith("/images/") || path === "/fs/download";
    const token = extractBearerToken(request.headers.authorization) ?? (queryTokenAllowed ? queryToken : undefined);
    const result = authGate.check(token, request.ip);
    if (!result.ok) {
      reply.code(401).send({ error: "unauthorized" });
      return;
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
    wsScope.get<{ Params: { id: string }; Querystring: { cols?: string; rows?: string } }>(
      "/sessions/:id/terminal",
      { websocket: true },
      (
        socket: WebSocket,
        request: FastifyRequest<{ Params: { id: string }; Querystring: { cols?: string; rows?: string } }>,
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
        const sub = terminalManager.attach(
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
        );
        if (!sub) {
          socket.close(4404, "terminal session not found");
          return;
        }
        // KEEPALIVE: ping the (possibly idle) client so a fronting proxy doesn't drop the connection out
        // from under a live terminal. .unref() so the timer never keeps the process alive; cleared below.
        const pingTimer = setInterval(() => {
          if (socket.readyState === socket.OPEN) {
            try {
              socket.ping();
            } catch {
              /* socket dying — the close handler cleans up */
            }
          }
        }, TERMINAL_WS_PING_MS);
        pingTimer.unref?.();
        socket.on("message", (raw: Buffer) => {
          // Cap the frame size BEFORE toString()/parse so a client can't force a huge allocation or flood
          // the pty. A generous cap still allows large pastes.
          if (raw.length > MAX_TERMINAL_INPUT_BYTES) return;
          let msg: { t?: string; d?: string; c?: number; r?: number };
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (msg.t === "i" && typeof msg.d === "string") terminalManager.write(id, msg.d);
          else if (msg.t === "r" && typeof msg.c === "number" && typeof msg.r === "number")
            terminalManager.resize(id, msg.c, msg.r);
        });
        socket.on("close", () => {
          clearInterval(pingTimer);
          sub.unsubscribe();
        });
        socket.on("error", () => {
          clearInterval(pingTimer);
          sub.unsubscribe();
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
    // Terminal is the only mode: spawn a pty-backed tmux session.
    if (!terminalAvailable) {
      reply
        .code(400)
        .send({ error: "terminal mode unavailable", hint: "install tmux on the host (and ensure node-pty loads)" });
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
    const claudeArgs: string[] = [];
    if (typeof body.model === "string") {
      if (!isValidModel(body.model)) {
        reply.code(400).send({ error: "invalid model" });
        return;
      }
      claudeArgs.push("--model", body.model);
    }
    // --dangerously-skip-permissions and --permission-mode are mutually exclusive (the CLI rejects both
    // together); the danger flag wins and suppresses the permission mode.
    if (body.dangerouslySkip) {
      claudeArgs.push("--dangerously-skip-permissions");
    } else if (typeof body.permissionMode === "string") {
      if (!VALID_PERMISSION_MODES.has(body.permissionMode)) {
        reply.code(400).send({ error: "invalid permissionMode" });
        return;
      }
      claudeArgs.push("--permission-mode", body.permissionMode);
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
    const meta = terminalManager.create({ id, cwd: body.cwd, claudeArgs });
    // Return `{ session }` (not a flat body). The web client does `return (await res.json()).session`.
    // Shape the session like a SessionMeta (mode:"terminal" so the client routes to TerminalView;
    // dangerouslySkip is the shared list/meta field, never used here).
    reply.code(201).send({
      session: {
        id: meta.id,
        cwd: meta.cwd,
        mode: "terminal" as const,
        status: meta.status,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        dangerouslySkip: false,
      },
    });
  });

  // Unauthenticated liveness probe (the preHandler lets /health through). Returns only { ok: true }.
  app.get("/health", async () => ({ ok: true }));

  app.get("/sessions", async () => {
    const sessions = terminalManager.list().map((t) => ({
      id: t.id,
      cwd: t.cwd,
      mode: "terminal" as const,
      status: t.status,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
    }));
    return { sessions };
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
      // Push a control frame over the terminal WS (the client renders it in the Files panel).
      terminalManager.pushControl(sessionId, {
        t: "attach",
        id,
        path: body.path,
        name: described.name,
        caption,
        isImage,
      });
      reply.code(200).send({ ok: true, id });
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

  // GET /usage → the Claude usage bars {usage: UsageInfo | null} (token-gated by the global preHandler).
  // The UsageService caches with a TTL so this poll is cheap; a spawn/parse failure degrades to
  // `usage:null` (the UI hides the bars) and never 500s. Absent dep (tests / no claude) → null.
  app.get("/usage", async () => {
    const usage = deps.usage ? await deps.usage.getUsage() : null;
    return { usage };
  });

  // In-app Claude re-authentication (token-gated by the global preHandler). Lets a user whose server-side
  // Claude login expired sign in again from the app: start → returns the authorize URL; the user authorizes
  // in any browser + pastes the code back; code → finishes the exchange (fresh creds, no restart needed).
  // GET /auth/status → which account is signed in (or {available:false} when the feature is off).
  app.get("/auth/status", async () => {
    if (!deps.claudeAuth) return { available: false as const };
    const status = await deps.claudeAuth.status();
    return { available: true as const, ...status };
  });
  // POST /auth/login/start → { loginId, url } (503 if the feature is off / the URL never appears).
  app.post("/auth/login/start", async (_request, reply) => {
    if (!deps.claudeAuth) {
      reply.code(503).send({ error: "Claude sign-in is not available on this server." });
      return;
    }
    try {
      return await deps.claudeAuth.startLogin();
    } catch (err) {
      reply.code(502).send({ error: err instanceof Error ? err.message : "couldn't start sign-in" });
      return;
    }
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
    deps.claudeAuth?.cancel();
    return { ok: true as const };
  });

  // GET /claude/version → { installed, latest } (token-gated). `installed` is the server's `claude --version`;
  // `latest` is the newest published version (null when unknown). The UI compares a session's claudeVersion
  // against `latest` to show a subtle "update available" hint. Never 500s — both degrade to null.
  app.get("/claude/version", async () => {
    const [installed, latest] = await Promise.all([
      claudeVersionProbe
        .get()
        .then((v) => v.version ?? null)
        .catch(() => null),
      deps.claudeLatest ? deps.claudeLatest.getLatest().then((v) => v ?? null) : Promise.resolve(null),
    ]);
    return { installed, latest };
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
    deps.store?.close();
    deps.pushStore?.close();
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
