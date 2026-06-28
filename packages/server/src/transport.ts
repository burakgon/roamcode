import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { FsService, FsError } from "./fs-service.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { WebSocket } from "ws";
import { SessionHub } from "./session-hub.js";
import { AuthGate, extractBearerToken } from "./auth.js";
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
import { readFile } from "node:fs/promises";
import type { SessionManager } from "./session-manager.js";
import type { ServerRuntimeConfig } from "./server-config.js";
import type { SessionStore, StoreMode } from "./session-store.js";
import type { HistoryService } from "./history-service.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { SessionMeta } from "./session-hub.js";
import type { PushStore } from "./push-store.js";
import type { ServerFrame } from "./replay-buffer.js";
import { createUpdater, RUNNING_BUILD } from "./updater.js";
import type { Updater } from "./updater.js";
import { createClaudeVersionProbe, defaultRunClaudeVersion } from "./diag.js";
import type { ClaudeVersionProbe } from "./diag.js";
import type { UsageService } from "./usage-service.js";
import { ImageStore } from "./image-store.js";
import type { ModelsService } from "./models-service.js";

/** Default reopen window: how many of the most-recent transcript turns GET /sessions/:id returns when
 * `?full=1` is absent. Keeps opening a large session fast; "load earlier" re-requests with `?full=1`. */
const HISTORY_WINDOW = 200;

export interface CreateServerDeps {
  store?: SessionStore;
  history?: HistoryService;
  idempotency?: IdempotencyStore;
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
}

export interface CreateServerResult {
  app: FastifyInstance;
  hub: SessionHub;
  authGate: AuthGate;
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
  const hub = new SessionHub(sessionManager, {
    store: deps.store,
    history: deps.history,
    imageStore,
    onFrame: deps.onFrame,
  });
  hub.loadFromStore();
  const projectsDir = deps.projectsDir ?? defaultProjectsDir();
  // Per-idempotency-key in-flight lock: two simultaneous same-key POSTs must yield ONE session.
  const inFlight = new Map<string, Promise<SessionMeta>>();
  const authGate = new AuthGate({ token: config.accessToken });
  const fsService = new FsService({ root: config.fsRoot });
  // OTA self-update. A real Updater reads/writes its status file in the data dir and runs git there;
  // tests inject a fake with FIXTURE git output (no real git mutation). The real Updater reads the
  // REMOTE_CODER_SERVICE_LABEL/_MANAGER overrides from process.env (its default) when resolving how to
  // restart the service after a successful build.
  const updater = deps.updater ?? createUpdater({ dataDir: config.dataDir });
  // Authed GET /diag's claude probe: cached best-effort `claude --version`. Injected in tests; a real
  // probe over the configured claude bin + process env otherwise.
  const claudeVersionProbe =
    deps.claudeVersionProbe ??
    createClaudeVersionProbe({ run: defaultRunClaudeVersion(config.claude.claudeBin, process.env) });
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
    const queryTokenAllowed = path.endsWith("/ws") || path.startsWith("/images/") || path === "/fs/download";
    const token = extractBearerToken(request.headers.authorization) ?? (queryTokenAllowed ? queryToken : undefined);
    const result = authGate.check(token, request.ip);
    if (!result.ok) {
      reply.code(401).send({ error: "unauthorized" });
      return;
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
        let subscription: { unsubscribe(): void } | undefined = undefined;
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
          handleClientFrame(hub, id, msg, imageStore);
        });

        socket.on("close", () => subscription.unsubscribe());
        socket.on("error", () => subscription.unsubscribe());
      },
    );
  });

  app.post<{ Body: CreateSessionBody }>("/sessions", async (request, reply) => {
    const body = request.body;
    if (!body || (typeof body.cwd !== "string" && typeof body.resumeSessionId !== "string")) {
      reply.code(400).send({ error: "cwd is required" });
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
      const session = await hub.resumeFromTranscript({
        sessionId: resumeId,
        cwd,
        model: body.model,
        effort: body.effort,
        dangerouslySkip: body.dangerouslySkip,
        addDirs: body.addDirs,
        frames: transcriptToFrames(parsed),
      });
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
        const session = await pending;
        reply.code(200).send({ session });
        return;
      }
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
    return { sessions: hub.listSessions() };
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
    hub.deleteSession(request.params.id);
    reply.code(204).send();
  });

  // Legacy stop endpoint — kept working, but now CONVERGES on full removal (stop + delete), so the
  // chat disappears whether the client hit ✕ (DELETE) or Settings "Stop session" (this). 404 only
  // when the session is already gone, preserving the old "stop a known session" contract.
  app.post<{ Params: { id: string } }>("/sessions/:id/stop", async (request, reply) => {
    const meta = hub.getSession(request.params.id);
    if (!meta) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    hub.deleteSession(request.params.id);
    return { ok: true };
  });

  // Claude sends a file/image to the chat: the mcp-send stdio server (spawned as claude's subprocess)
  // POSTs here on a send_image/send_file tool call. The path is fsRoot+realpath-validated (no traversal,
  // no symlink escape — same defense as /fs/download); on success an `attachment` frame is pushed to the
  // session over the existing WS (live + buffered for reconnect). Token-gated by the global preHandler.
  app.post<{ Params: { id: string }; Body: { path?: string; caption?: string; kind?: "image" | "file" } }>(
    "/sessions/:id/attach",
    async (request, reply) => {
      const meta = hub.getSession(request.params.id);
      if (!meta) {
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
      hub.pushAttachment(request.params.id, {
        id,
        path: body.path,
        name: described.name,
        caption,
        isImage,
      });
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
      return await updater.getVersion(force);
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
  });

  return { app, hub, authGate };
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

function handleClientFrame(hub: SessionHub, id: string, msg: Record<string, unknown>, imageStore: ImageStore): void {
  // The hub methods are async (a dormant session may resume first). They are fire-and-forget here:
  // a rejected resume must never throw into the WS message handler, so each is `.catch`-guarded.
  if (msg.type === "user") {
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
