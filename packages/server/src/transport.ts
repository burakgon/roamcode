import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { FsService, FsError } from "./fs-service.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { WebSocket } from "ws";
import { SessionHub } from "./session-hub.js";
import { AuthGate, extractBearerToken } from "./auth.js";
import { isOriginAllowed } from "./origin-check.js";
import { RateLimiter } from "./rate-limit.js";
import { generateAccessToken, persistAccessToken } from "./data-dir.js";
import { registerStatic, isPublicForRequest, pathForGate } from "./static-routes.js";
import { buildImageBlock } from "@remote-coder/protocol";
import type { ContentBlock, HookPermissionDecision, QuestionSpec } from "@remote-coder/protocol";
import {
  defaultProjectsDir,
  findTranscriptFile,
  listResumable,
  parseTranscript,
  transcriptToFrames,
} from "./transcript.js";
import { readFile, stat } from "node:fs/promises";
import type { SessionManager } from "./session-manager.js";
import type { ServerRuntimeConfig } from "./server-config.js";
import type { SessionStore, StoreMode } from "./session-store.js";
import type { HistoryService } from "./history-service.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { FrameSpool } from "./frame-spool.js";
import { createSendDedup } from "./send-dedup.js";
import type { SendDedup } from "./send-dedup.js";
import type { SessionMeta, Subscription } from "./session-hub.js";
import type { PushStore } from "./push-store.js";
import type { ServerFrame } from "./replay-buffer.js";
import { createUpdater, RUNNING_BUILD } from "./updater.js";
import type { Updater } from "./updater.js";
import { createClaudeVersionProbe, defaultRunClaudeVersion } from "./diag.js";
import type { ClaudeVersionProbe } from "./diag.js";
import { ClaudeStartError, looksLikeAuthError } from "./claude-process.js";
import type { UsageService } from "./usage-service.js";
import type { ClaudeAuthService } from "./claude-auth-service.js";
import type { ClaudeLatestService } from "./claude-latest-service.js";
import { ImageStore } from "./image-store.js";
import type { ModelsService } from "./models-service.js";
import { TerminalManager } from "./terminal-manager.js";
import { detectTerminalSupport } from "./terminal-capability.js";
import { listTmuxSessions } from "./tmux-list.js";
import { openSessionStore } from "./session-store.js";

/** Default reopen window: how many of the most-recent transcript turns GET /sessions/:id returns when
 * `?full=1` is absent. Keeps opening a large session fast; "load earlier" re-requests with `?full=1`. */
const HISTORY_WINDOW = 200;

/** Terminal WS guards. Input: cap a single frame so a client can't force a huge alloc / flood the pty (1MB
 *  still allows large pastes). Output: if the client buffers more than this undrained, close (it reconnects
 *  and tmux redraws) rather than grow Node's heap unbounded on a slow link. */
const MAX_TERMINAL_INPUT_BYTES = 1_000_000;
const MAX_TERMINAL_WS_BUFFER = 16_000_000;

/**
 * Map a spawn/start failure from createSession/resumeSession into an ACTIONABLE HTTP response, so the
 * #1 onboarding failure (a missing/unauthenticated `claude`) is self-explanatory instead of a bare 500.
 *
 *  - {@link ClaudeStartError} `CLAUDE_NOT_FOUND` (ENOENT / spawn error) → 503: the CLI isn't installed
 *    or isn't on the server's PATH.
 *  - {@link ClaudeStartError} `CLAUDE_START_FAILED` (exited before the handshake / auth-looking stderr /
 *    init timeout) → 502: `claude` is installed but didn't start — almost always not authenticated.
 *  - anything else → 500 (a genuinely-unexpected error).
 *
 * Returns `{ status, body }` with a `hint` the UI can show verbatim. The `detail` (a bounded stderr tail)
 * is surfaced only for the start-failed case so the operator can see WHY, and it is NOT a secret — it's
 * the CLI's own stderr, which never contains the access token (that lives in a 0600 file / header).
 */
export function mapSpawnError(err: unknown): {
  status: number;
  body: { error: string; code?: string; hint: string; detail?: string };
} {
  if (err instanceof ClaudeStartError) {
    if (err.code === "CLAUDE_NOT_FOUND") {
      return {
        status: 503,
        body: {
          error: err.message,
          code: err.code,
          hint: "Claude Code CLI not found on PATH. Install it and ensure `claude` is on the server's PATH.",
        },
      };
    }
    // CLAUDE_START_FAILED: spawned but never initialized — usually an auth/login wall.
    const detail = err.detail;
    const authish = detail !== undefined && looksLikeAuthError(detail);
    return {
      status: 502,
      body: {
        error: err.message,
        code: err.code,
        hint: authish
          ? "`claude` is installed but not authenticated. Run `claude` once in a terminal on the host to log in, then retry."
          : "`claude` is installed but failed to start (it may not be authenticated). Run `claude` once in a terminal on the host to log in, then retry.",
        ...(detail ? { detail } : {}),
      },
    };
  }
  // Genuinely-unexpected error: keep a generic 500 (no actionable hint to invent).
  return {
    status: 500,
    body: {
      error: (err as Error).message ?? "failed to create session",
      hint: "Unexpected error starting the session. Check the server logs (GET /diag for diagnostics).",
    },
  };
}

export interface CreateServerDeps {
  store?: SessionStore;
  history?: HistoryService;
  idempotency?: IdempotencyStore;
  /**
   * Append-only per-session critical-frame spool (durability). Threaded into the hub so an in-flight
   * turn the transcript hadn't fsynced before a crash/OTA-restart can be recovered on reopen. When
   * omitted the hub doesn't spool (current behavior). start.ts opens a file-backed one under the data dir.
   */
  spool?: FrameSpool;
  /** Absolute path to the built PWA (packages/web/dist). When set, the server also serves the UI. */
  webDir?: string;
  pushStore?: PushStore;
  /** VAPID public key exposed at GET /push/vapid for the browser subscription. */
  vapidPublicKey?: string;
  /**
   * Observe every emitted hub frame (push-trigger seam). Forwarded to SessionHubOptions.onFrame so a
   * push dispatcher fires on result/permission/question frames without coupling to the WS layer.
   */
  onFrame?: (sessionId: string, frame: ServerFrame) => void;
  /**
   * Root of Claude's per-project transcript store (`~/.claude/projects` by default). Used by
   * GET /resumable and the resume-create flow to browse + load past sessions. Overridable for tests.
   */
  projectsDir?: string;
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
   * Selectable models for the model dropdown (GET /models → {models}). Injected so tests can pass a
   * fake (no real spawn). When omitted the route returns {models: []} (the UI falls back to free-text). A real
   * ModelsService is wired by start.ts from the configured claude bin + server env.
   */
  models?: ModelsService;
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
   * How the session/idempotency stores are actually backed — "sqlite" (durable) or "memory-fallback"
   * (better-sqlite3 failed to load; NOT durable across restarts). Surfaced by the authed GET /diag for
   * fleet observability. Threaded from start.ts (it opens the stores). Defaults to "sqlite" when omitted.
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
  hub: SessionHub;
  authGate: AuthGate;
  /** Exposed so startServer can late-bind the MCP attach config (after listen() resolves the port), same
   *  as the chat SessionManager — this is what gives the terminal's claude send_image/send_file. */
  terminalManager: TerminalManager;
}

interface CreateSessionBody {
  cwd: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  dangerouslySkip?: boolean;
  /** Starting permission mode (default | acceptEdits | plan). bypassPermissions is expressed via
   *  dangerouslySkip; buildClaudeArgs emits `--permission-mode` for the allowlisted non-default modes. */
  permissionMode?: string;
  /**
   * Resume a PAST claude session. When set, the new session reuses THIS id (claude --resume <id>), its
   * cwd is taken from the transcript (falling back to body.cwd), and its prior conversation is pre-loaded
   * into the replay buffer. The transcript file must exist (else 404).
   */
  resumeSessionId?: string;
  /** Session mode: "chat" (default) for a JSON-protocol Claude chat, "terminal" for a pty-backed tmux
   *  terminal session. */
  mode?: "chat" | "terminal";
}

export function createServer(
  config: ServerRuntimeConfig,
  sessionManager: SessionManager,
  deps: CreateServerDeps = {},
): CreateServerResult {
  // Content-addressed image store under the data dir. Images uploaded from the PWA live here as files,
  // referenced by a ref everywhere we control (WS send, chat render, reopen) so base64 never travels on
  // our wire or sits in our payloads — only Claude's own transcript keeps base64 (vision needs the bytes).
  const imageStore = new ImageStore({ dataDir: config.dataDir });
  // Cached best-effort `claude --version`. Used by the authed GET /diag, by GET /claude/version (the
  // update-awareness signal), AND by the hub to stamp each session with the claude version it spawned with.
  // Injected in tests; a real probe over the configured claude bin + process env otherwise.
  const claudeVersionProbe =
    deps.claudeVersionProbe ??
    createClaudeVersionProbe({ run: defaultRunClaudeVersion(config.claude.claudeBin, process.env) });
  const hub = new SessionHub(sessionManager, {
    store: deps.store,
    history: deps.history,
    imageStore,
    spool: deps.spool,
    onFrame: deps.onFrame,
    claudeVersionProbe,
  });
  hub.loadFromStore();
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
    const liveTmuxNames = listTmuxSessions();
    if (liveTmuxNames) terminalManager.rehydrate({ liveTmuxNames });
  }
  const projectsDir = deps.projectsDir ?? defaultProjectsDir();
  // Per-idempotency-key in-flight lock: two simultaneous same-key POSTs must yield ONE session.
  const inFlight = new Map<string, Promise<SessionMeta>>();
  // SEND IDEMPOTENCY (#9): a per-session recent-msgId set so a re-delivered WS `user` frame (the client's
  // reconnect queue can re-send a buffered message carrying the SAME msgId) reaches Claude at most once —
  // a duplicate "force push"/"delete" prompt running twice is dangerous. Frames with no msgId (older
  // clients) are never deduped (current behavior preserved).
  const sendDedup = createSendDedup();
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
  // CONCURRENCY CAP: refuse a new spawn once `config.maxSessions` live sessions exist (0 disables it).
  // `liveSessionCount` counts only sessions with a running host process, so dormant/errored records don't
  // count and reopening within the cap is unaffected. The message names the env var so an operator can lift it.
  const sessionCapMessage = `live session cap reached (${config.maxSessions}); close a session or raise REMOTE_CODER_MAX_SESSIONS`;
  const atSessionCap = (): boolean => config.maxSessions > 0 && hub.liveSessionCount() >= config.maxSessions;
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
    const queryTokenAllowed = path.endsWith("/ws") || path.endsWith("/terminal") || path.startsWith("/images/") || path === "/fs/download";
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
    wsScope.get<{ Params: { id: string }; Querystring: { since?: string } }>(
      "/sessions/:id/ws",
      { websocket: true },
      (socket: WebSocket, request: FastifyRequest<{ Params: { id: string }; Querystring: { since?: string } }>) => {
        const id = request.params.id;

        if (!hub.getSession(id)) {
          socket.close(4404, "session not found");
          return;
        }

        // Optional delta replay: `?since=<seq>` replays only frames AFTER that seq (reconnect
        // without re-receiving the whole buffer). Ignore an absent/invalid value (full replay).
        const sinceRaw = request.query.since;
        const sinceParsed = sinceRaw === undefined ? NaN : Number(sinceRaw);
        const sinceSeq = Number.isInteger(sinceParsed) && sinceParsed >= 0 ? sinceParsed : undefined;

        // SessionHub fan-out is SYNCHRONOUS: a throw from socket.send() (e.g. the socket is
        // closing) would unwind the hub's listener loop straight into the ClaudeProcess emit.
        // Guard the send and, on ANY failure, unsubscribe + close so the throw never escapes
        // the hub callback.
        // hub.subscribe replays buffered frames SYNCHRONOUSLY, so the listener can fire before this
        // assignment completes; a send-throw during that replay must not touch `subscription` in its TDZ.
        // Use a `let` + a deferred-unsubscribe flag for the synchronous case.
        let subscription: Subscription | undefined = undefined;
        let unsubscribeWhenReady = false;
        subscription = hub.subscribe(
          id,
          (frame) => {
            if (socket.readyState !== socket.OPEN) return;
            try {
              socket.send(JSON.stringify(frame));
            } catch {
              if (subscription) subscription.unsubscribe();
              else unsubscribeWhenReady = true; // fired during the synchronous replay — clean up right after
              try {
                socket.close();
              } catch {
                // socket already torn down — nothing more to do
              }
            }
          },
          sinceSeq,
        );
        if (unsubscribeWhenReady) subscription.unsubscribe();

        socket.on("message", (raw: Buffer) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return; // ignore malformed client frames
          }
          // FOREGROUND-GATING: a `visibility` frame reports whether THIS connection's PWA tab is visible
          // (the client sends it on document.visibilitychange + right after connect). It flips THIS
          // subscription's foreground flag, which `hub.hasForegroundSubscriber` reads to suppress a push
          // for a session the user is actively looking at. Handled here (not in handleClientFrame) because
          // the subscription handle is in scope only here. A subscription fired during the synchronous
          // replay before assignment is impossible by this point (the open message arrives in a later tick).
          if (msg.type === "visibility") {
            if (msg.state === "foreground" || msg.state === "background") {
              subscription?.setForeground(msg.state === "foreground");
            }
            return;
          }
          handleClientFrame(hub, id, msg, imageStore, sendDedup);
        });

        socket.on("close", () => subscription.unsubscribe());
        socket.on("error", () => subscription.unsubscribe());
      },
    );

    wsScope.get<{ Params: { id: string }; Querystring: { cols?: string; rows?: string } }>(
      "/sessions/:id/terminal",
      { websocket: true },
      (socket: WebSocket, request: FastifyRequest<{ Params: { id: string }; Querystring: { cols?: string; rows?: string } }>) => {
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
                try { socket.close(4400, "terminal backpressure"); } catch { /* already gone */ }
                return;
              }
              try {
                socket.send(Buffer.from(chunk, "utf8")); // binary frame
              } catch {
                sub?.unsubscribe();
                try { socket.close(); } catch { /* already gone */ }
              }
            },
            // claude exited (the manager ended the session) → tell the client so it shows Restart/Close
            // instead of a frozen screen. 4410 = "ended" (do NOT auto-reconnect on this code).
            onExit: () => {
              try { socket.close(4410, "session ended"); } catch { /* already gone */ }
            },
            // Out-of-band control (file/image attachments claude sent) → a TEXT frame, so the client can
            // split it from the BINARY pty stream. Skipped under backpressure like the data path.
            onControl: (json) => {
              if (socket.readyState !== socket.OPEN || socket.bufferedAmount > MAX_TERMINAL_WS_BUFFER) return;
              try { socket.send(json); } catch { /* already gone */ }
            },
          },
          size,
        );
        if (!sub) {
          socket.close(4404, "terminal session not found");
          return;
        }
        socket.on("message", (raw: Buffer) => {
          // Cap the frame size BEFORE toString()/parse so a client can't force a huge allocation or flood
          // the pty. A generous cap still allows large pastes.
          if (raw.length > MAX_TERMINAL_INPUT_BYTES) return;
          let msg: { t?: string; d?: string; c?: number; r?: number };
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          if (msg.t === "i" && typeof msg.d === "string") terminalManager.write(id, msg.d);
          else if (msg.t === "r" && typeof msg.c === "number" && typeof msg.r === "number") terminalManager.resize(id, msg.c, msg.r);
        });
        socket.on("close", () => sub.unsubscribe());
        socket.on("error", () => sub.unsubscribe());
      },
    );
  });

  app.post<{ Body: CreateSessionBody }>("/sessions", async (request, reply) => {
    const body = request.body;
    if (!body || (typeof body.cwd !== "string" && typeof body.resumeSessionId !== "string" && body.mode !== "terminal")) {
      reply.code(400).send({ error: "cwd is required" });
      return;
    }

    // Terminal mode: spawn a pty-backed tmux session (bypasses the chat/resume paths entirely).
    if (body.mode === "terminal") {
      if (!terminalAvailable) {
        reply
          .code(400)
          .send({ error: "terminal mode unavailable", hint: "install tmux on the host (and ensure node-pty loads)" });
        return;
      }
      if (typeof body.cwd !== "string") {
        reply.code(400).send({ error: "cwd is required" });
        return;
      }
      // Terminal sessions count toward the SAME live-session cap as chat (a tmux+claude pty is just as
      // heavy) — otherwise terminal creates were an uncapped host-DoS hole.
      const liveTerminals = terminalManager.list().filter((t) => t.status === "running").length;
      if (config.maxSessions > 0 && hub.liveSessionCount() + liveTerminals >= config.maxSessions) {
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
      if (typeof body.model === "string") claudeArgs.push("--model", body.model);
      if (typeof body.permissionMode === "string") claudeArgs.push("--permission-mode", body.permissionMode);
      const meta = terminalManager.create({ id, cwd: body.cwd, claudeArgs });
      // Mirror the chat-create contract EXACTLY — `{ session }`, not a flat body. The web client does
      // `return (await res.json()).session`, so a flat payload made a terminal session come back undefined
      // and the wizard couldn't open it. Shape the session like a SessionMeta (mode:"terminal" so the
      // client routes to TerminalView; dangerouslySkip is the shared list/meta field, never used here).
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
      return;
    }

    // Resume a past session: validate the transcript exists, then create a live session under THAT id
    // with its prior conversation pre-loaded into the replay buffer. Idempotent — resuming an already
    // live id returns it. (Bypasses the idempotency-key path below; the session id IS the dedup key.)
    if (typeof body.resumeSessionId === "string") {
      const resumeId = body.resumeSessionId;
      const live = hub.getSession(resumeId);
      if (live && live.status === "running") {
        reply.code(200).send({ session: live });
        return;
      }
      // CONCURRENCY CAP: a resume that would SPAWN a fresh `claude` (the session isn't already live) counts
      // against the live cap. Reopening within the cap is unaffected; at the cap we refuse rather than burn
      // host resources/quota on another process. (Resuming an ALREADY-live id returned above, uncapped.)
      if (atSessionCap()) {
        reply.code(429).send({ error: sessionCapMessage });
        return;
      }
      const file = await findTranscriptFile(projectsDir, resumeId);
      if (!file) {
        reply.code(404).send({ error: "transcript not found for the requested session" });
        return;
      }
      let parsed;
      try {
        parsed = parseTranscript(await readFile(file, "utf8"));
      } catch (err) {
        reply.code(400).send({ error: `failed to read transcript: ${(err as Error).message}` });
        return;
      }
      const cwd = parsed.cwd ?? (typeof body.cwd === "string" ? body.cwd : undefined);
      if (!cwd) {
        reply.code(400).send({ error: "transcript has no cwd and none was provided" });
        return;
      }
      let session: SessionMeta;
      try {
        session = await hub.resumeFromTranscript({
          sessionId: resumeId,
          cwd,
          model: body.model,
          effort: body.effort,
          dangerouslySkip: body.dangerouslySkip,
          addDirs: body.addDirs,
          frames: transcriptToFrames(parsed),
        });
      } catch (err) {
        // SAME actionable mapping as the create path: a resume that SPAWNS a fresh `claude` hits the same
        // missing/unauthenticated-CLI failures, so surface the same clear hint (not a bare 500).
        const { status, body: errBody } = mapSpawnError(err);
        reply.code(status).send(errBody);
        return;
      }
      reply.code(201).send({ session });
      return;
    }

    const idemKey = request.headers["idempotency-key"];
    const key = typeof idemKey === "string" ? idemKey : undefined;

    if (key && deps.idempotency) {
      // Committed hit: a previous create with this key already produced a (still-known) session.
      const existingId = deps.idempotency.lookup(key, Date.now());
      if (existingId) {
        const existing = hub.getSession(existingId);
        if (existing) {
          reply.code(200).send({ session: existing });
          return;
        }
      }
      // In-flight hit: a concurrent same-key create is mid-spawn — await IT instead of spawning
      // a second process, so two simultaneous same-key requests collapse to ONE session.
      const pending = inFlight.get(key);
      if (pending) {
        let session: SessionMeta;
        try {
          session = await pending;
        } catch (err) {
          // The collapsed-onto create failed — give the SAME actionable mapping (not a bare 500) so a
          // second same-key client sees the same clear hint as the request that did the spawn.
          const { status, body: errBody } = mapSpawnError(err);
          reply.code(status).send(errBody);
          return;
        }
        reply.code(200).send({ session });
        return;
      }
    }

    // CONCURRENCY CAP (host DoS + quota burn): bound the number of LIVE `claude` processes. Checked AFTER
    // the idempotency hits above (returning an existing session is never capped) and right before the real
    // spawn. At the cap we refuse with 429; existing sessions + reopening within the cap are unaffected.
    if (atSessionCap()) {
      reply.code(429).send({ error: sessionCapMessage });
      return;
    }

    const createPromise = hub.createSession({
      cwd: body.cwd,
      model: body.model,
      effort: body.effort,
      addDirs: body.addDirs,
      dangerouslySkip: body.dangerouslySkip,
      permissionMode: body.permissionMode,
    });
    if (key && deps.idempotency) inFlight.set(key, createPromise);
    let session: SessionMeta;
    try {
      session = await createPromise;
    } catch (err) {
      // ACTIONABLE FIRST-RUN ERRORS: a missing/unauthenticated `claude` is the top onboarding failure.
      // Map the spawn/init failure to a CLEAR 4xx/5xx with a hint instead of a bare 500 (see mapSpawnError).
      const { status, body: errBody } = mapSpawnError(err);
      reply.code(status).send(errBody);
      return;
    } finally {
      if (key && deps.idempotency) inFlight.delete(key);
    }
    if (key && deps.idempotency) deps.idempotency.remember(key, session.id, Date.now());
    reply.code(201).send({ session });
  });

  // Unauthenticated liveness probe (the preHandler lets /health through). Returns only { ok: true }.
  app.get("/health", async () => ({ ok: true }));

  app.get("/sessions", async () => {
    // Self-heal the rail every poll: drop sessions that died on the host (process gone + no resumable
    // transcript) so a dead chat never lingers — no restart required.
    hub.pruneDeadSessions();
    const chatSessions = hub.listSessions().map((s) => ({ ...s, mode: "chat" as const }));
    const terminalSessions = terminalManager.list().map((t) => ({
      id: t.id,
      cwd: t.cwd,
      mode: "terminal" as const,
      status: t.status,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
    }));
    return { sessions: [...chatSessions, ...terminalSessions] };
  });

  // Browse past claude conversations to resume (the `claude --resume` picker). Read-only; token-gated
  // by the global preHandler. `?cwd=` filters to one working directory. Recent-first.
  app.get<{ Querystring: { cwd?: string } }>("/resumable", async (request) => {
    const cwd = typeof request.query.cwd === "string" ? request.query.cwd : undefined;
    const sessions = await listResumable(projectsDir, cwd ? { cwd } : {});
    return { sessions };
  });

  app.get<{ Params: { id: string }; Querystring: { full?: string } }>("/sessions/:id", async (request, reply) => {
    const meta = hub.getSession(request.params.id);
    if (!meta) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    // By DEFAULT return only the last HISTORY_WINDOW turns so a big session opens fast (`truncated` tells
    // the client older turns exist); `?full=1` returns the entire transcript (the explicit "load earlier"
    // path). `sinceSeq` is the replay buffer's max seq — the client resumes the WS from it for new frames.
    const limit = request.query.full === "1" ? undefined : HISTORY_WINDOW;
    const { history, sinceSeq, truncated, total, live } = await hub.getHistory(request.params.id, limit);
    // `live` (turn-in-flight + last usage) lets a switched-to chat seed its wire state + context meter
    // from the server's authoritative live tail instead of resetting to a wrong "idle" / a blank meter.
    return { session: meta, history, sinceSeq, truncated, total, live };
  });

  // POST /images — upload an image (multipart, BINARY, no base64) into the content-addressed store and
  // return its `{ ref }`. The PWA composer calls this on attach so the phone never uplinks base64; the
  // WS `user` send then carries the ref. Token-gated by the global preHandler (/images is in the denylist).
  app.post("/images", async (request, reply) => {
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
    if (!/^image\//.test(data.mimetype)) {
      reply.code(400).send({ error: "only image/* uploads are allowed" });
      return;
    }
    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch (err) {
      reply.code(413).send({ error: (err as Error).message }); // @fastify/multipart throws past the limit
      return;
    }
    if (data.file.truncated) {
      reply.code(413).send({ error: "image exceeds the upload size limit" });
      return;
    }
    const ref = await imageStore.save(buffer, data.mimetype);
    reply.code(201).send({ ref });
  });

  // GET /images/:ref — serve a stored image by its content ref (file-served, immutable). This is what
  // renders in the chat live AND on reopen (the slim history ships `/images/<ref>` instead of base64), so
  // the MB of base64 never travels on our wire. Token-gated by the global preHandler; the <img> carries
  // the token via `?token=`. A bad/missing ref 404s. Hardened against SVG script execution on direct
  // navigation with `nosniff` + a `default-src 'none'` CSP (images in <img> never run scripts anyway).
  app.get<{ Params: { ref: string } }>("/images/:ref", async (request, reply) => {
    const image = await imageStore.read(request.params.ref);
    if (!image) {
      reply.code(404).send({ error: "image not found" });
      return;
    }
    reply
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .type(image.mediaType)
      .send(image.data);
  });

  // Close a session: stop its live process AND remove it from the list + store (transcript untouched,
  // so it stays resumable via /resume + GET /resumable). Idempotent — deleting an unknown id is a
  // 204 no-op, not a 404 — so a double-close / a stale client both succeed.
  app.delete<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const { id } = request.params;
    if (terminalManager.get(id)) {
      terminalManager.stop(id);
    } else {
      hub.deleteSession(id);
      sendDedup.forget(id); // reclaim the closed session's recent-msgId memory
    }
    reply.code(204).send();
  });

  // Legacy stop endpoint — kept working, but now CONVERGES on full removal (stop + delete), so the
  // chat disappears whether the client hit ✕ (DELETE) or Settings "Stop session" (this). 404 only
  // when the session is already gone, preserving the old "stop a known session" contract.
  app.post<{ Params: { id: string } }>("/sessions/:id/stop", async (request, reply) => {
    const { id } = request.params;
    if (terminalManager.get(id)) {
      terminalManager.stop(id);
      return { ok: true };
    }
    const meta = hub.getSession(id);
    if (!meta) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    hub.deleteSession(id);
    sendDedup.forget(id); // reclaim the closed session's recent-msgId memory
    return { ok: true };
  });

  // Claude sends a file/image to the chat: the mcp-send stdio server (spawned as claude's subprocess)
  // POSTs here on a send_image/send_file tool call. The path is fsRoot+realpath-validated (no traversal,
  // no symlink escape — same defense as /fs/download); on success an `attachment` frame is pushed to the
  // session over the existing WS (live + buffered for reconnect). Token-gated by the global preHandler.
  app.post<{ Params: { id: string }; Body: { path?: string; caption?: string; kind?: "image" | "file" } }>(
    "/sessions/:id/attach",
    async (request, reply) => {
      const sessionId = request.params.id;
      // A session id is EITHER a chat (hub) session OR a terminal session — the MCP send_image/send_file
      // tool POSTs here for both. Resolve which so a terminal's attachment isn't 404'd against the chat hub.
      const isChat = !!hub.getSession(sessionId);
      const isTerminal = !isChat && !!terminalManager.get(sessionId);
      if (!isChat && !isTerminal) {
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
      if (isTerminal) {
        // Terminal: push a control frame over the terminal WS (the client renders it in the Files panel).
        terminalManager.pushControl(sessionId, {
          t: "attach",
          id,
          path: body.path,
          name: described.name,
          caption,
          isImage,
        });
      } else {
        hub.pushAttachment(sessionId, { id, path: body.path, name: described.name, caption, isImage });
      }
      reply.code(200).send({ ok: true, id });
    },
  );

  // Claude asks the user a multiple-choice question: the mcp-send stdio server POSTs the questions here
  // on an `ask_user` tool call and this request is HELD OPEN (long-poll) until the user answers in the
  // web UI, the prompt is dismissed, or it times out (~10 min). The hub emits a `question` frame (with
  // an askId) so the existing web QuestionPrompt renders it; a matching WS `answer` resolves this promise.
  // Token-gated by the global preHandler.
  app.post<{ Params: { id: string }; Body: { questions?: unknown } }>("/sessions/:id/ask", async (request, reply) => {
    if (!hub.getSession(request.params.id)) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    const questions = parseAskQuestions(request.body?.questions);
    if (!questions) {
      reply.code(400).send({ error: "questions must be a non-empty array, each with 1+ options" });
      return;
    }
    // Block until the user answers / the ask is cancelled (timeout, session stop, or the long-poll
    // client disconnecting — wired via request.raw "close" so a dropped fetch doesn't leak the pending
    // ask + its prompt). askUser never rejects, so this always resolves to { answers } or { cancelled }.
    const ac = new AbortController();
    request.raw.on("close", () => ac.abort());
    const result = await hub.askUser(request.params.id, questions, ac.signal);
    reply.code(200).send(result);
  });

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

  // GET /models → the selectable model list {models: ModelInfo[]} (token-gated by the global preHandler).
  // Absent dep (tests / no claude) or a failed probe → []. Never 500s.
  app.get("/models", async () => {
    const models = deps.models ? await deps.models.getModels() : [];
    return { models };
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
  // shadows the API/WS routes above (the SPA fallback is scoped by isPublicPath).
  if (deps.webDir) registerStatic(app, { webDir: deps.webDir });

  // Graceful shutdown: app.close() must tear down every live session's child `claude`
  // process, or they leak as orphans (SIGTERM/SIGINT in start.ts close the app). It also closes the
  // SQLite-backed stores opened by startServer (session, idempotency, push) so their DB handles are
  // released — they're opened once at boot and never reopened, so closing them on shutdown is safe.
  app.addHook("onClose", async () => {
    hub.stopAll();
    deps.store?.close();
    deps.idempotency?.close();
    deps.pushStore?.close();
    deps.spool?.close();
  });

  return { app, hub, authGate, terminalManager };
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

function handleClientFrame(
  hub: SessionHub,
  id: string,
  msg: Record<string, unknown>,
  imageStore: ImageStore,
  sendDedup: SendDedup,
): void {
  // The hub methods are async (a dormant session may resume first). They are fire-and-forget here:
  // a rejected resume must never throw into the WS message handler, so each is `.catch`-guarded.
  if (msg.type === "user") {
    // SEND IDEMPOTENCY (#9): a client mints one `msgId` per distinct user action and REUSES it on a
    // reconnect-queue re-send, so a requeued frame carries the same id. Dedup by it: the SAME msgId within
    // the TTL is ACKNOWLEDGED but NOT re-sent to the CLI (a duplicate "force push"/"delete" running twice
    // is dangerous). A blank/absent msgId (older clients) is never deduped — firstSeen returns true.
    const msgId = typeof msg.msgId === "string" && msg.msgId.length > 0 ? msg.msgId : undefined;
    if (!sendDedup.firstSeen(id, msgId)) return; // known duplicate → drop (already delivered once)
    // Resolving image refs reads files from the store (async), so build the blocks then send — still
    // fire-and-forget + `.catch`-guarded so nothing throws into the WS handler.
    void buildUserBlocks(msg, imageStore)
      .then((blocks) => (blocks.length > 0 ? hub.sendMessage(id, blocks) : undefined))
      .catch(() => {});
    return;
  }
  if (msg.type === "permission") {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    const decision =
      msg.decision === "allow" || msg.decision === "deny" ? (msg.decision as HookPermissionDecision) : undefined;
    if (requestId && decision) {
      const reason = typeof msg.reason === "string" ? msg.reason : undefined;
      void hub.answerPermission(id, requestId, decision, reason).catch(() => {});
    }
    return;
  }
  if (msg.type === "answer") {
    const answers = isAnswerMap(msg.answers) ? msg.answers : undefined;
    if (!answers) return;
    // ask_user path (our MCP tool): an answer carrying an `askId` resolves the matching pending POST
    // /ask long-poll. answerAsk returns false for an unknown/stale askId — fall through to the legacy
    // built-in-question path in that case so a tampered/duplicate askId can't swallow the answer.
    const askId = typeof msg.askId === "string" ? msg.askId : undefined;
    if (askId && hub.answerAsk(id, askId, answers)) return;
    // Legacy built-in AskUserQuestion path: routed by requestId back into the CLI.
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    // NOTE: msg.toolInput is IGNORED by the hub (it replays the server-remembered tool_input).
    if (requestId) void hub.answerQuestion(id, requestId, msg.toolInput, answers).catch(() => {});
    return;
  }
  if (msg.type === "interrupt") {
    // STOP the current turn without killing the process. Synchronous + safe (a no-op for a non-live
    // session); guarded so an unknown-id throw can't escape the WS message handler.
    try {
      hub.interrupt(id);
    } catch {
      // unknown/torn-down session — ignore (the WS would already be closing for an unknown id)
    }
    return;
  }
  if (msg.type === "rewind") {
    // REWIND / CHECKPOINT: go back to a turn's checkpoint, optionally reverting code and/or the
    // conversation. `checkpointId` is the turn's user-message uuid (from --replay-user-messages); `mode`
    // is code | conversation | both. The hub emits a `rewound` frame and never throws into here; the
    // promise is fire-and-forget + `.catch`-guarded (a respawn rejection must not escape this handler).
    const checkpointId = typeof msg.checkpointId === "string" ? msg.checkpointId : undefined;
    const mode =
      msg.mode === "code" || msg.mode === "conversation" || msg.mode === "both"
        ? (msg.mode as "code" | "conversation" | "both")
        : undefined;
    if (checkpointId && mode) void hub.rewind(id, checkpointId, mode).catch(() => {});
    return;
  }
  if (msg.type === "settings") {
    const settings: {
      model?: string;
      maxThinkingTokens?: number;
      effort?: string;
      permissionMode?: string;
      dangerouslySkip?: boolean;
    } = {};
    if (typeof msg.model === "string") settings.model = msg.model;
    // Validate the thinking budget before forwarding to the CLI's stdin: a non-integer / negative /
    // absurd value is dropped (the UI only ever sends a sane budget from EFFORT_THINKING_TOKENS).
    if (
      typeof msg.maxThinkingTokens === "number" &&
      Number.isInteger(msg.maxThinkingTokens) &&
      msg.maxThinkingTokens >= 0 &&
      msg.maxThinkingTokens <= 200000
    ) {
      settings.maxThinkingTokens = msg.maxThinkingTokens;
    }
    if (typeof msg.effort === "string") settings.effort = msg.effort;
    if (typeof msg.permissionMode === "string") settings.permissionMode = msg.permissionMode;
    if (typeof msg.dangerouslySkip === "boolean") settings.dangerouslySkip = msg.dangerouslySkip;
    void hub.applySettings(id, settings).catch(() => {});
    return;
  }
  // unknown frame types are ignored
}

/** Accept only a flat record of question -> string | string[]. */
function isAnswerMap(v: unknown): v is Record<string, string | string[]> {
  if (typeof v !== "object" || v === null) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    const ok = typeof val === "string" || (Array.isArray(val) && val.every((x) => typeof x === "string"));
    if (!ok) return false;
  }
  return true;
}

/**
 * Validate + normalize the `ask_user` body (POST /sessions/:id/ask) into QuestionSpec[]. Requires a
 * non-empty array of questions, each a non-empty `question` string with 1+ options that each have a
 * non-empty `label`. Returns null for any malformed shape (the route answers 400). Coerces missing
 * `multiSelect` to false and drops unknown fields so only well-formed specs reach the hub/web.
 */
function parseAskQuestions(v: unknown): QuestionSpec[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: QuestionSpec[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) return null;
    const q = raw as Record<string, unknown>;
    if (typeof q.question !== "string" || q.question.length === 0) return null;
    if (!Array.isArray(q.options) || q.options.length === 0) return null;
    const options: QuestionSpec["options"] = [];
    for (const o of q.options) {
      if (typeof o !== "object" || o === null) return null;
      const opt = o as Record<string, unknown>;
      if (typeof opt.label !== "string" || opt.label.length === 0) return null;
      options.push({
        label: opt.label,
        ...(typeof opt.description === "string" ? { description: opt.description } : {}),
        ...(typeof opt.preview === "string" ? { preview: opt.preview } : {}),
      });
    }
    out.push({
      question: q.question,
      ...(typeof q.header === "string" ? { header: q.header } : {}),
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out;
}

/** A content block is only forwarded if it is a well-formed text or image block. */
function isValidContentBlock(b: unknown): b is ContentBlock {
  if (typeof b !== "object" || b === null) return false;
  const block = b as Record<string, unknown>;
  if (block.type === "text") return typeof block.text === "string";
  if (block.type === "image") {
    const src = block.source as Record<string, unknown> | undefined;
    return (
      typeof src === "object" &&
      src !== null &&
      src.type === "base64" &&
      typeof src.media_type === "string" &&
      typeof src.data === "string"
    );
  }
  return false;
}

/**
 * Build a content-block array from a flexible inbound `user` frame. Never forwards arbitrary JSON.
 * Async because the preferred image path is a `imageRefs` array: the composer uploaded each image to the
 * content-addressed store (binary, no base64 uplink) and sends only its ref; we read the bytes HERE and
 * build the base64 image block solely for Claude's stdin (the model needs the bytes for vision). A ref
 * that doesn't resolve is skipped. Back-compat: an older client may still inline `images` as base64.
 */
async function buildUserBlocks(msg: Record<string, unknown>, imageStore: ImageStore): Promise<ContentBlock[]> {
  // Explicit `blocks` array: keep only well-formed text/image blocks (don't cast raw client JSON
  // straight into serializeUserMessage -> claude stdin).
  if (Array.isArray(msg.blocks)) return msg.blocks.filter(isValidContentBlock);
  const blocks: ContentBlock[] = [];
  const text = typeof msg.content === "string" ? msg.content : typeof msg.text === "string" ? msg.text : undefined;
  if (text) blocks.push({ type: "text", text });
  if (Array.isArray(msg.imageRefs)) {
    for (const ref of msg.imageRefs) {
      if (typeof ref !== "string") continue;
      const image = await imageStore.read(ref);
      if (image) blocks.push(buildImageBlock(image.mediaType, image.data.toString("base64")));
    }
  }
  if (Array.isArray(msg.images)) {
    for (const img of msg.images as { mediaType?: string; dataBase64?: string }[]) {
      if (img && typeof img.mediaType === "string" && typeof img.dataBase64 === "string") {
        blocks.push(buildImageBlock(img.mediaType, img.dataBase64));
      }
    }
  }
  return blocks;
}
