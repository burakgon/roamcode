import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createServer } from "./transport.js";
import { loadServerConfig, assertConfigAllowsStart, isLoopbackAddress } from "./server-config.js";
import { ensureDataDir, resolveAccessToken } from "./data-dir.js";
import { openSessionStore } from "./session-store.js";
import { resolveVapidKeys } from "./vapid.js";
import { openPushStore } from "./push-store.js";
import { createWebPushSend } from "./web-push-send.js";
import { createPushDispatcher } from "./push-dispatch.js";
import type { PushDispatcher } from "./push-dispatch.js";
import { createUsageService } from "./usage-service.js";
import { createClaudeAuthService } from "./claude-auth-service.js";
import { createClaudeLatestService } from "./claude-latest-service.js";
import { createClaudeVersionProbe, defaultRunClaudeVersion } from "./diag.js";
import type { ClaudeAvailability, ClaudeVersionProbe } from "./diag.js";
import type { CreateServerResult } from "./transport.js";

/**
 * STARTUP PREFLIGHT (#7): format a prominent, actionable boot warning when `claude --version` couldn't
 * run. The server still boots (sessions just won't start until the operator fixes it) — this is purely
 * to surface WHY in the logs immediately, like the better-sqlite3 fallback warning. Returns `undefined`
 * when claude is available (no warning). PURE so it's unit-testable without spawning.
 */
export function claudePreflightWarning(availability: ClaudeAvailability): string | undefined {
  if (availability.available) return undefined;
  return (
    "\n⚠ `claude` CLI not found or not runnable — new sessions will FAIL until this is fixed.\n" +
    "  Install Claude Code and make sure `claude` is on this server's PATH, then authenticate by\n" +
    "  running `claude` once in a terminal on the host (there is no remote login).\n" +
    "  (If it IS installed, the service's PATH may not include it — see the README troubleshooting.)\n"
  );
}

/**
 * Run the startup preflight: best-effort probe `claude --version` and print {@link claudePreflightWarning}
 * if it's missing/failing. NEVER throws and NEVER blocks boot — a hung/slow claude can't stall startup
 * (the probe is short-timeout-guarded). Injectable probe + log sink so it's testable without a spawn.
 */
export async function runClaudePreflight(
  probe: ClaudeVersionProbe,
  warn: (msg: string) => void = (m) => console.warn(m),
): Promise<void> {
  let availability: ClaudeAvailability;
  try {
    availability = await probe.get();
  } catch {
    availability = { available: false }; // a thrown probe is treated as unavailable (defensive; probe never throws)
  }
  const message = claudePreflightWarning(availability);
  if (message) warn(message);
}

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
  // LOUD store-fallback warning: the store silently falls back to a non-durable in-memory Map when the
  // native better-sqlite3 module can't load. That means sessions are LOST on every restart (incl. the OTA
  // restart) — a silent data-durability footgun. Warn prominently + actionably so an operator notices and
  // rebuilds the native module. `storeMode` is threaded to /diag for fleet observability.
  const storeMode = store.mode;
  if (storeMode === "memory-fallback") {
    console.warn(
      "\n⚠ better-sqlite3 failed to load — sessions are NOT persisted across restarts (every restart, " +
        "including an OTA update, starts empty).\n" +
        "  Rebuild the native module:  pnpm -C packages/server rebuild better-sqlite3\n" +
        "  (or reinstall with native builds allowed:  pnpm install && pnpm approve-builds better-sqlite3)\n",
    );
  }
  // STARTUP PREFLIGHT (#7): one cached `claude --version` probe SHARED by the boot preflight below and the
  // authed GET /diag (injected into createServer), so we spawn at most once. The probe is short-timeout-
  // guarded and never throws.
  const claudeVersionProbe = createClaudeVersionProbe({
    run: defaultRunClaudeVersion(config.claude.claudeBin, env),
  });
  // Best-effort, NON-BLOCKING: fire-and-forget so a slow/hung claude can't stall boot. The warning prints
  // when the probe resolves (within its short timeout). Crash guards in installCrashGuards keep a probe
  // rejection from taking the process down.
  void runClaudePreflight(claudeVersionProbe);

  // Web Push (spec §1): VAPID keypair (persisted) + subscription store.
  const vapid = resolveVapidKeys({ dataDir: config.dataDir });
  const pushStore = openPushStore({ dbPath: join(config.dataDir, "push.db") });
  // Away-from-desk dispatcher: fans "claude needs you / finished / sent a file / has a question" pushes out
  // to every matching subscription (pruning dead ones on 404/410). The VAPID subject is a mailto:/https: URL
  // the push service can contact (web-push REQUIRES it) — from REMOTE_CODER_VAPID_SUBJECT, else a sane
  // default. Wrapped so a misconfigured subject (or a web-push init throw) DISABLES push rather than killing
  // boot — an always-on server should keep serving even if the nice-to-have notifications can't send.
  const vapidSubject = env.REMOTE_CODER_VAPID_SUBJECT?.trim() || "mailto:remote-coder@localhost";
  let pushDispatcher: PushDispatcher | undefined;
  try {
    pushDispatcher = createPushDispatcher({
      pushStore,
      send: createWebPushSend({ vapid, subject: vapidSubject }),
      log: (m) => console.warn(`[remote-coder] ${m}`),
    });
  } catch (err) {
    console.warn(
      `[remote-coder] ⚠ web push disabled (${(err as Error).message}) — set a valid REMOTE_CODER_VAPID_SUBJECT`,
    );
  }

  // The PWA is served from packages/web/dist when it exists (one-origin deploy). Guard the path:
  // @fastify/static throws at register if `root` is missing (e.g. a dev tree with no `vite build` yet).
  const candidateWebDir = env.WEB_DIR ?? defaultWebDir();
  const webDir = candidateWebDir && existsSync(candidateWebDir) ? candidateWebDir : undefined;

  // Claude usage bars (GET /usage): spawn `claude /usage` with the SAME claude bin the chat uses and
  // the server's env (login session → subscription auth resolves). The service TTL-caches the parsed
  // result so the rail's poll is cheap; a spawn/parse failure degrades to null (the UI hides the bars).
  const usage = createUsageService({ claudeBin: config.claude.claudeBin, env });

  // In-app Claude re-authentication (GET/POST /auth/*): wraps `claude auth login` so an expired server-side
  // Claude login can be fixed from the app instead of SSHing in. Same claude bin + env as the terminal spawns.
  const claudeAuth = createClaudeAuthService({ claudeBin: config.claude.claudeBin, env });

  // Update awareness (GET /claude/version): the newest published claude version (npm dist-tag), TTL-cached,
  // compared client-side against each session's spawn-time version to show a subtle "update available" hint.
  const claudeLatest = createClaudeLatestService();

  const result = createServer(config, {
    store,
    pushStore,
    pushDispatcher,
    webDir,
    vapidPublicKey: vapid.publicKey,
    usage,
    claudeAuth,
    claudeLatest,
    storeMode,
    // Share the boot-preflight probe with /diag so claude is spawned at most once for both.
    claudeVersionProbe,
  });
  // LOUD boot warning when terminal mode is off (tmux/node-pty unavailable) — the server still serves, but
  // EVERY session fails to start, and the cause is otherwise silent. Mirrors the claude/sqlite warnings.
  if (!result.terminalAvailable) {
    console.warn(
      "[remote-coder] ⚠ terminal sessions are DISABLED — tmux and/or node-pty is unavailable. Install tmux " +
        "(macOS: brew install tmux; Debian/Ubuntu: apt install tmux) and ensure node-pty built, then restart.",
    );
  }
  const url = await result.app.listen({ port: config.port, host: config.bindAddress });

  // mcp-send wiring: now that listen() resolved the real port, give the terminal manager the LOOPBACK base
  // URL (the spawned mcp-send.js POSTs back to 127.0.0.1, never the public bind), this deploy's token, and
  // the resolved path to dist/mcp-send.js. Every terminal spawn then loads the send server so claude can
  // deliver files/images to the terminal. The script path is resolved relative to THIS module so it works
  // wherever the server is installed.
  const { port: listenPort } = result.app.server.address() as { port: number };
  const attachConfig = {
    baseUrl: `http://127.0.0.1:${listenPort}`,
    token: token ?? "",
    mcpScriptPath: fileURLToPath(new URL("./mcp-send.js", import.meta.url)),
    // Per-session 0600 mcp-config-<id>.json files are written into the data dir (mode 0700), keeping
    // the access token out of every process's argv.
    dataDir: config.dataDir,
  };
  // Terminal sessions → the terminal's claude gets send_image/send_file too.
  result.terminalManager.setAttachConfig(attachConfig);
  // Now that rehydrate (adopt survivors) + setAttachConfig (dataDir) have both run, delete leaked
  // per-session mcp-config-<id>.json files (they carry the token) whose session no longer exists.
  const swept = result.terminalManager.sweepStaleMcpConfigs();
  if (swept > 0) console.log(`swept ${swept} stale mcp-config file(s)`);

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
