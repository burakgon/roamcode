import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { SessionManager } from "./session-manager.js";
import { createServer } from "./transport.js";
import { loadServerConfig, assertConfigAllowsStart, isLoopbackAddress } from "./server-config.js";
import { ensureDataDir, resolveAccessToken } from "./data-dir.js";
import { openSessionStore } from "./session-store.js";
import { openIdempotencyStore } from "./idempotency.js";
import { HistoryService } from "./history-service.js";
import { resolveVapidKeys } from "./vapid.js";
import { openPushStore } from "./push-store.js";
import { PushDispatcher } from "./push-dispatcher.js";
import { createWebPushSend } from "./web-push-send.js";
import { createUsageService } from "./usage-service.js";
import { createModelsService } from "./models-service.js";
import type { CreateServerResult } from "./transport.js";

export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CreateServerResult & { url: string; token?: string; tokenGenerated: boolean }> {
  const config = loadServerConfig(env);

  // First-run token (spec §9): use ACCESS_TOKEN if set, else the persisted token, else generate.
  // EXPLICIT OPT-OUT: NO_TOKEN=1 keeps the Plan-3 tokenless dev path (no token generated/stored/
  // required) and only RUNS on a loopback bind (assertConfigAllowsStart enforces that below).
  // SECURITY: a token is auto-generated only when the bind is loopback OR a token is already
  // configured/persisted. A FIRST non-loopback bind with no token is left tokenless so
  // assertConfigAllowsStart refuses to start — we never silently mint a secret for a public bind.
  ensureDataDir(config.dataDir);
  const loopback = isLoopbackAddress(config.bindAddress);
  let token: string | undefined;
  let generated = false;
  const tokenless = env.NO_TOKEN === "1";
  const mayResolveToken = !tokenless && (loopback || config.accessToken !== undefined);
  if (mayResolveToken) {
    const resolved = resolveAccessToken({ configured: config.accessToken, dataDir: config.dataDir });
    token = resolved.token;
    generated = resolved.generated;
    config.accessToken = token;
  }

  assertConfigAllowsStart(config); // refuses a non-loopback bind that still has no token

  const store = openSessionStore({ dbPath: join(config.dataDir, "sessions.db") });
  const idempotency = openIdempotencyStore({ dbPath: join(config.dataDir, "idempotency.db") });
  const history = new HistoryService();

  const manager = new SessionManager(config.claude);

  // Web Push (spec §1): VAPID keypair (persisted), subscription store, dispatcher with the real sender.
  const vapid = resolveVapidKeys({ dataDir: config.dataDir });
  const pushStore = openPushStore({ dbPath: join(config.dataDir, "push.db") });
  const dispatcher = new PushDispatcher({
    store: pushStore,
    send: createWebPushSend({ vapid, subject: env.VAPID_SUBJECT ?? "mailto:remote-coder@localhost" }),
    // baseUrl is set via setBaseUrl AFTER listen() resolves the real origin (port 0 → OS-chosen port).
  });

  // The PWA is served from packages/web/dist when it exists (one-origin deploy). Guard the path:
  // @fastify/static throws at register if `root` is missing (e.g. a dev tree with no `vite build` yet).
  const candidateWebDir = env.WEB_DIR ?? defaultWebDir();
  const webDir = candidateWebDir && existsSync(candidateWebDir) ? candidateWebDir : undefined;

  // Claude usage bars (GET /usage): spawn `claude /usage` with the SAME claude bin the chat uses and
  // the server's env (login session → subscription auth resolves). The service TTL-caches the parsed
  // result so the rail's poll is cheap; a spawn/parse failure degrades to null (the UI hides the bars).
  const usage = createUsageService({ claudeBin: config.claude.claudeBin, env });

  // Model dropdown (GET /models): probe the SAME claude bin for the account's selectable model list.
  // TTL-cached; a failed probe yields [] (the UI falls back to free-text). Never 500s.
  const models = createModelsService({ claudeBin: config.claude.claudeBin, env });

  const result = createServer(config, manager, {
    store,
    history,
    idempotency,
    pushStore,
    webDir,
    vapidPublicKey: vapid.publicKey,
    onFrame: (id, frame) => dispatcher.handleFrame(id, frame),
    usage,
    models,
  });
  const url = await result.app.listen({ port: config.port, host: config.bindAddress });
  // The deep-link origin in pushes (the notification's click URL) defaults to the listen URL, but that's
  // the BIND address (e.g. 127.0.0.1 / 0.0.0.0 / a LAN IP) — a different origin than the one a remote
  // device installed the PWA under, so the tap would open an unreachable/cross-origin page and not focus
  // the existing app. REMOTE_CODER_PUBLIC_URL overrides it with the user-facing origin (e.g. the tunnel).
  const publicUrl = (process.env.REMOTE_CODER_PUBLIC_URL ?? "").trim();
  dispatcher.setBaseUrl(publicUrl || url);

  // mcp-send wiring: now that listen() resolved the real port, give the manager the LOOPBACK base URL
  // (the spawned mcp-send.js POSTs back to 127.0.0.1, never the public bind), this deploy's token, and
  // the resolved path to dist/mcp-send.js. Every create/resume spawn then loads the send server so
  // claude can deliver files/images to the chat. The script path is resolved relative to THIS module
  // so it works wherever the server is installed.
  const { port: listenPort } = result.app.server.address() as { port: number };
  manager.setAttachConfig({
    baseUrl: `http://127.0.0.1:${listenPort}`,
    token: token ?? "",
    mcpScriptPath: fileURLToPath(new URL("./mcp-send.js", import.meta.url)),
    // Per-session 0600 mcp-config-<id>.json files are written into the data dir (mode 0700), keeping
    // the access token out of every process's argv.
    dataDir: config.dataDir,
  });

  return { ...result, url, token, tokenGenerated: generated };
}

/** Default location of the built PWA, relative to the compiled server (dist/) → ../../web/dist. */
function defaultWebDir(): string | undefined {
  // PATH MATH (keep in sync if tsup's outDir changes): tsup bundles src/start.ts → dist/start.js, so
  // at runtime `fileURLToPath(new URL(".", import.meta.url))` resolves to packages/server/dist. Going
  // up two levels (../../) reaches packages/, and web/dist is the Vite build output. If a future tsup
  // outDir change moves start.js, this `../../web/dist` math breaks — Task 13 Step 5's smoke run (the
  // shell must load from `/`) catches it, and WEB_DIR can override it explicitly.
  const here = fileURLToPath(new URL(".", import.meta.url));
  return join(here, "..", "..", "web", "dist");
}

/** Install process-wide crash guards so a stray unhandled rejection or a listener-less EventEmitter
 *  `error` (e.g. a write-after-teardown on a dying claude child, or a detached updater spawn failure)
 *  LOGS instead of taking the whole server down — for an always-on self-hosted server, staying up beats
 *  crashing. Install ONCE at a process entry (never in startServer, which tests call repeatedly). */
export function installCrashGuards(): void {
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`[remote-coder] unhandled rejection (kept serving): ${msg}`);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[remote-coder] uncaught exception (kept serving): ${err.stack ?? err.message}`);
  });
}

// Run when executed directly (node dist/start.js), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer()
    .then(({ app, url, token, tokenGenerated }) => {
      console.log(`remote-coder server listening on ${url}`);
      if (tokenGenerated && token) {
        console.log(
          `\n  Access token (generated, stored in the data dir):\n    ${token}\n  Open: ${url}/?token=${token}\n`,
        );
      } else if (!token) {
        console.log(`  (NO_TOKEN tokenless loopback dev mode — no access token required)`);
      }
      // Graceful shutdown: app.close() fires the onClose hook, which stops every live session
      // (and its child `claude`), so a deployment leaves no orphaned processes.
      const shutdown = (signal: NodeJS.Signals) => {
        console.log(`received ${signal}, shutting down`);
        app
          .close()
          .then(() => process.exit(0))
          .catch(() => process.exit(0));
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
      installCrashGuards();
    })
    .catch((err: unknown) => {
      console.error(`remote-coder server failed to start: ${(err as Error).message}`);
      process.exit(1);
    });
}
