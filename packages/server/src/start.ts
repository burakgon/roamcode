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
import { classifierVersionWarning } from "./pane-status.js";
import type { CreateServerResult } from "./transport.js";
import type { ProviderAvailability } from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createClaudeProvider } from "./providers/claude-provider.js";
import { createCodexProvider } from "./providers/codex-provider.js";
import { CodexAppServerClient } from "./providers/codex-app-server-client.js";
import { CodexMetadataService } from "./providers/codex-metadata-service.js";
import { ClaudeMetadataService, createClaudeMetadataRunner } from "./providers/claude-metadata-service.js";
import { createCodexProfileClientLifecycle } from "./providers/codex-profile-client.js";
import { createCodexThreadInventory, CodexThreadResolver } from "./providers/codex-thread-resolver.js";
import { CodexLatestService } from "./providers/codex-latest-service.js";
import { execFile } from "node:child_process";
import { createUpdater } from "./updater.js";

export function providerPreflightWarning(name: string, availability: ProviderAvailability): string | undefined {
  if (availability.terminalAvailable) return undefined;
  return (
    `\n⚠ ${name} CLI not found or not runnable — new ${name} sessions will FAIL until this is fixed.\n` +
    `  Install ${name} and make sure its executable is on this server's PATH, then authenticate it on the host.\n`
  );
}

export async function runProviderPreflight(
  providers: ReadonlyArray<{ name: string; probe(): Promise<ProviderAvailability> }>,
  warn: (msg: string) => void = (message) => console.warn(message),
): Promise<void> {
  await Promise.all(
    providers.map(async (provider) => {
      let availability: ProviderAvailability;
      try {
        availability = await provider.probe();
      } catch {
        availability = { terminalAvailable: false, metadataAvailable: false };
      }
      const message = providerPreflightWarning(provider.name, availability);
      if (message) warn(message);
    }),
  );
}

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
  // The provider-labelled dual preflight is launched after both adapters are constructed below. This cached
  // Claude probe is still shared with diagnostics and the classifier guard, so no duplicate spawn occurs.
  // CLASSIFIER VERSION GUARD: the pane-status markers driving the rail's working/blocked/idle are tied to
  // Claude Code's ENGLISH TUI strings (see pane-status.ts CLASSIFIER_TESTED_UP_TO). If the installed claude
  // is NEWER than the version they were verified against, log ONE warning so a reworded TUI degrading every
  // status to "idle" isn't a silent mystery. Shares the cached probe above (no extra spawn); never throws.
  void claudeVersionProbe
    .get()
    .then((availability) => {
      const warning = classifierVersionWarning(availability.version);
      if (warning) console.warn(`[roamcode] ⚠ ${warning}`);
    })
    .catch(() => {
      /* the probe never rejects; defensive so the guard can never affect boot */
    });

  // Web Push (spec §1): VAPID keypair (persisted) + subscription store.
  const vapid = resolveVapidKeys({ dataDir: config.dataDir });
  const pushStore = openPushStore({ dbPath: join(config.dataDir, "push.db") });
  // Away-from-desk dispatcher: fans "claude needs you / finished / sent a file / has a question" pushes out
  // to every matching subscription (pruning dead ones on 404/410). The VAPID subject is a mailto:/https: URL
  // the push service can contact (web-push REQUIRES it) — from ROAMCODE_VAPID_SUBJECT, else a sane
  // default. Wrapped so a misconfigured subject (or a web-push init throw) DISABLES push rather than killing
  // boot — an always-on server should keep serving even if the nice-to-have notifications can't send.
  const vapidSubject =
    (env.ROAMCODE_VAPID_SUBJECT ?? env.REMOTE_CODER_VAPID_SUBJECT)?.trim() || "mailto:roamcode@localhost";
  let pushDispatcher: PushDispatcher | undefined;
  try {
    pushDispatcher = createPushDispatcher({
      pushStore,
      send: createWebPushSend({ vapid, subject: vapidSubject }),
      log: (m) => console.warn(`[roamcode] ${m}`),
    });
  } catch (err) {
    console.warn(`[roamcode] ⚠ web push disabled (${(err as Error).message}) — set a valid ROAMCODE_VAPID_SUBJECT`);
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

  // Auxiliary model discovery is lazy: construction does not spawn Claude, and failures only degrade
  // metadata routes or add a compatibility warning to session creation.
  const claudeMetadata = new ClaudeMetadataService(
    createClaudeMetadataRunner({
      claudeBin: config.claude.claudeBin,
      cwd: config.fsRoot,
      env,
    }),
  );

  // Stable-only auxiliary app-server. The lazy RPC wrapper starts it only when a metadata route or exact
  // thread-inventory probe is used; terminal construction never depends on successful initialization.
  const codexClient = new CodexAppServerClient({ codexBin: config.codexBin, env });
  const codexRpc = {
    request: async <T>(method: string, params: unknown, schema: import("zod").ZodType<T>): Promise<T> => {
      await codexClient.start();
      return codexClient.request(method, params, schema);
    },
    onNotification: (listener: (notification: { method: string; params?: unknown }) => void) =>
      codexClient.onNotification(listener),
  };
  const profileClient = createCodexProfileClientLifecycle({ codexBin: config.codexBin, env });
  const codexMetadata = new CodexMetadataService(codexRpc, {
    ...(env.CODEX_HOME ? { codexHome: env.CODEX_HOME } : {}),
    profileClient,
  });
  const codexCapabilityInventory = createCodexThreadInventory(codexRpc, { cwd: config.fsRoot });
  const codexCapabilityProbe = {
    get: () => codexMetadata.probeCapabilities(config.fsRoot, codexCapabilityInventory),
  };
  const codexLatest = new CodexLatestService({
    runVersion: (args, options) =>
      new Promise((resolve, reject) => {
        execFile(
          config.codexBin,
          [...args],
          { env, timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes, windowsHide: true },
          (error, stdout, stderr) => {
            if (error && (error as NodeJS.ErrnoException & { code?: string | number }).code === "ENOENT") {
              reject(error);
              return;
            }
            const errorCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
            resolve({
              code: errorCode,
              stdout: String(stdout),
              stderr: String(stderr),
            });
          },
        );
      }),
    detectProvenance: () => "unknown",
    fetchNpmLatest: async (_packageName, options) => {
      const response = await fetch("https://registry.npmjs.org/@openai%2Fcodex/latest", {
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const text = await response.text();
      if (!response.ok || Buffer.byteLength(text) > options.maxResponseBytes) throw new Error("unavailable");
      const parsed = JSON.parse(text) as { version?: unknown };
      if (typeof parsed.version !== "string") throw new Error("unavailable");
      return parsed.version;
    },
  });
  const providers = new ProviderRegistry([
    createClaudeProvider({
      claudeBin: config.claude.claudeBin,
      env,
      probe: async () => {
        const availability = await claudeVersionProbe.get();
        return {
          terminalAvailable: availability.available,
          metadataAvailable: availability.available,
          ...(availability.version ? { version: availability.version } : {}),
        };
      },
    }),
    createCodexProvider({
      codexBin: config.codexBin,
      env,
      validateProfile: codexMetadata.validateProfile,
      probe: async () => {
        try {
          const version = await codexLatest.getVersion();
          return { terminalAvailable: true, metadataAvailable: false, version: version.installed };
        } catch {
          return { terminalAvailable: false, metadataAvailable: false };
        }
      },
    }),
  ]);
  void runProviderPreflight(
    providers.list().map((provider) => ({ name: provider.displayName, probe: () => provider.probe() })),
  );

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
    providers,
    claudeMetadata,
    codexMetadata,
    codexCapabilityProbe,
    codexLatest,
    updater: createUpdater({ dataDir: config.dataDir, env }),
    codexThreadResolver: (cwd) => new CodexThreadResolver({ inventory: createCodexThreadInventory(codexRpc, { cwd }) }),
    disposeProviders: () => codexClient.stop(),
  });
  // LOUD boot warning when terminal mode is off (tmux/node-pty unavailable) — the server still serves, but
  // EVERY session fails to start, and the cause is otherwise silent. Mirrors the claude/sqlite warnings.
  if (!result.terminalAvailable) {
    console.warn(
      "[roamcode] ⚠ terminal sessions are DISABLED — tmux and/or node-pty is unavailable. Install tmux " +
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

  // LIVE STATUS MONITOR — re-derive every running session's working-vs-awaiting flag from its rendered tmux
  // pane every ~2.5s (universal + hook-free; see TerminalManager.refreshActivity). This is what makes the
  // session rail's statuses actually track reality, for OLD sessions too. capture-pane is READ-ONLY so it can
  // never disturb a live session; a re-entrancy guard stops a slow sweep from stacking tmux spawns; unref'd so
  // it never holds the process open.
  let activityBusy = false;
  const activityTimer = setInterval(() => {
    if (activityBusy) return;
    activityBusy = true;
    void result.terminalManager
      .refreshActivity()
      .catch(() => {
        /* the monitor is best-effort — a sweep failure must never crash the server */
      })
      .finally(() => {
        activityBusy = false;
      });
  }, 2500);
  if (typeof activityTimer.unref === "function") activityTimer.unref();

  return { ...result, url, token, tokenGenerated: generated };
}

/** Default PWA location relative to @roamcode.ai/server/dist. This resolves to sibling @roamcode.ai/web/dist
 * in both the workspace and npm's scoped node_modules layout. */
function defaultWebDir(): string | undefined {
  // Keep this path math in sync with tsup's outDir; the release boot smoke catches packaging drift.
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
    console.error(`[roamcode] unhandled rejection (kept serving): ${msg}`);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[roamcode] uncaught exception (kept serving): ${err.stack ?? err.message}`);
  });
}

// Run when executed directly (node dist/start.js), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer()
    .then(({ app, url, token, tokenGenerated }) => {
      console.log(`roamcode server listening on ${url}`);
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
      console.error(`roamcode server failed to start: ${(err as Error).message}`);
      process.exit(1);
    });
}
