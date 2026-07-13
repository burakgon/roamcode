#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, helpText, versionText } from "./args.js";

/** The slice of the started server `run` needs: a closable app, the URL, and the token state. */
interface StartedServer {
  app: { close: () => Promise<unknown> };
  url: string;
  token?: string;
  tokenGenerated: boolean;
}

/**
 * Injectable seams so the boot path is unit-testable without binding a real port or writing to the
 * process streams. `onReady` is called AFTER the connect info is printed (the default installs the
 * SIGTERM/SIGINT graceful-shutdown handlers; tests pass a no-op so they don't touch `process`).
 */
export interface RunDeps {
  startServer: (env: NodeJS.ProcessEnv) => Promise<StartedServer>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: NodeJS.ProcessEnv;
  onReady: (server: StartedServer) => void;
  /** Test seams for the explicit persistent installer. Production lazily uses @roamcode.ai/server. */
  installManaged?: (opts: {
    version: string;
    installRoot: string;
    dataDir: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<{ launcherPath: string }>;
  enableInstalledService?: (record: { manager: "launchd" | "systemd"; label: string; path: string }) => {
    ok: boolean;
    error?: string;
  };
}

function defaultDeps(): RunDeps {
  return {
    // Lazy import so merely importing this module (e.g. in a unit test that injects its own deps)
    // doesn't pull in the server's native/heavy dependency graph (better-sqlite3, fastify, web-push).
    startServer: async (env) => {
      const { startServer } = await import("@roamcode.ai/server");
      return (await startServer(env)) as unknown as StartedServer;
    },
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    onReady: (server) => {
      // Graceful shutdown: app.close() fires the server's onClose hook, stopping every live session
      // (and its child `claude`), so Ctrl-C leaves no orphaned processes.
      const shutdown = (signal: NodeJS.Signals): void => {
        process.stderr.write(`received ${signal}, shutting down\n`);
        server.app
          .close()
          .then(() => process.exit(0))
          .catch(() => process.exit(0));
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
      // Keep the always-on server up on a stray unhandled rejection or a listener-less EventEmitter
      // `error` (e.g. a write-after-teardown on a dying claude child) — log instead of crashing.
      process.on("unhandledRejection", (reason) => {
        const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
        process.stderr.write(`unhandled rejection (kept serving): ${msg}\n`);
      });
      process.on("uncaughtException", (err) => {
        process.stderr.write(`uncaught exception (kept serving): ${err.stack ?? err.message}\n`);
      });
    },
  };
}

/**
 * Parse args and either print help/version or boot the server. Returns the process exit code.
 * Pure of `process.*` (everything goes through `deps`) so the boot wiring is testable without a
 * real listen.
 */
export async function run(argv: string[], deps: RunDeps = defaultDeps()): Promise<number> {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    deps.stderr(`${(err as Error).message}\n`);
    return 2;
  }

  if (opts.help) {
    deps.stdout(`${helpText()}\n`);
    return 0;
  }
  if (opts.version) {
    deps.stdout(`${versionText()}\n`);
    return 0;
  }

  if (opts.command === "install") {
    // The npx bootstrap and Homebrew CLI converge here: install the exact CLI
    // version into the managed runtime, then point the service at a stable launcher.
    const server = await import("@roamcode.ai/server");
    const dataDir = server.resolveDataDir(deps.env);
    const installRoot = server.resolveInstallRoot(deps.env);
    try {
      deps.stdout(`Installing RoamCode v${versionText()}…\n`);
      const managed = deps.installManaged
        ? await deps.installManaged({ version: versionText(), installRoot, dataDir, env: deps.env })
        : await server.installManagedRelease({
            version: versionText(),
            installRoot,
            dataDir,
            restart: false,
            onStatus: (status) => deps.stdout(`  ${status.phase ?? status.state}\n`),
          });
      const { path, record } = server.installService({
        nodePath: process.execPath,
        executablePath: managed.launcherPath,
        dataDir,
        installRoot,
      });
      if (deps.env.RC_NO_START === "1") {
        deps.stdout(`Installed RoamCode v${versionText()} without starting it.\nService unit: ${path}\n`);
      } else {
        const enabled = deps.enableInstalledService
          ? deps.enableInstalledService(record)
          : server.enableService(record);
        if (!enabled.ok) throw new Error(enabled.error ?? "could not start the installed service");
        deps.stdout(`Installed and started RoamCode v${versionText()}.\nService unit: ${path}\n`);
      }
    } catch (err) {
      deps.stderr(`${(err as Error).message}\n`);
      return 1;
    }
    return 0;
  }
  if (opts.command === "status") {
    // Lazy imports, same reason as install: keep the serve path lean. resolveDataDir is the same
    // resolution the server itself uses, so status reads the exact service.json/token install wrote.
    const { runStatus } = await import("./status.js");
    const { resolveDataDir } = await import("@roamcode.ai/server");
    return runStatus({ dataDir: resolveDataDir(deps.env), env: deps.env, stdout: deps.stdout });
  }
  if (opts.command === "uninstall") {
    deps.stdout(
      "macOS:  launchctl unload -w ~/Library/LaunchAgents/com.roamcode.plist && rm ~/Library/LaunchAgents/com.roamcode.plist\n" +
        "Linux:  systemctl --user disable --now roamcode && rm ~/.config/systemd/user/roamcode.service\n" +
        "(Installed before the RoamCode rename? Your service is com.remote-coder.plist / remote-coder.service instead.)\n" +
        "\nManaged program versions stay in ~/.local/share/roamcode. To remove them:  rm -rf ~/.local/share/roamcode\n" +
        "\nYour data (token, push subscriptions, session index) stays in ~/.config/roamcode (~/.config/remote-coder on pre-rename installs).\n" +
        "To remove it too:  rm -rf ~/.config/roamcode ~/.config/remote-coder   # deletes your token + history\n",
    );
    return 0;
  }

  // Map flags onto the env vars startServer reads (it owns config resolution, stores, VAPID, and
  // serving packages/web/dist when present).
  const env: NodeJS.ProcessEnv = { ...deps.env };
  if (opts.port !== undefined) env.PORT = opts.port;
  if (opts.bind !== undefined) env.BIND_ADDRESS = opts.bind;
  if (opts.noToken) env.NO_TOKEN = "1";

  let server: StartedServer;
  try {
    server = await deps.startServer(env);
  } catch (err) {
    deps.stderr(`roamcode failed to start: ${(err as Error).message}\n`);
    return 1;
  }

  const { url, token, tokenGenerated } = server;
  deps.stdout(`\nRoamCode is running.\n  Open: ${url}\n`);
  if (token) {
    if (tokenGenerated) {
      // The token is printed exactly ONCE — embedded in the ready-to-use direct link (the only place
      // it appears on screen) — and is persisted in the data dir for next time. It is never logged
      // elsewhere; re-running the command takes the non-generated branch below.
      deps.stdout(
        `  Access token generated and stored in the data dir. Open this link to connect:\n    ${url}/?token=${token}\n`,
      );
    } else {
      deps.stdout(`  (using the existing access token from the data dir / ACCESS_TOKEN)\n`);
    }
  } else {
    deps.stdout(`  (NO_TOKEN loopback dev mode — no access token required)\n`);
  }
  deps.stdout(`\n  For remote access put this behind an HTTPS tunnel (see the README).\n\n`);

  deps.onReady(server);
  return 0;
}

/** Resolve npm/Homebrew bin symlinks before deciding whether this module is the process entrypoint. */
export function isDirectExecution(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    // Keep a URL-safe fallback for synthetic/nonexistent paths used by embedders and tests.
    return moduleUrl === pathToFileURL(argv1).href;
  }
}

// Run when executed directly (including through the `node_modules/.bin/roamcode` symlink), not when imported.
if (isDirectExecution(import.meta.url, process.argv[1])) {
  void run(process.argv.slice(2)).then((code) => {
    // A non-zero code from a one-shot path (help/version always return 0) means a parse/start error;
    // a successful boot returns 0 and keeps the event loop alive via the open listener.
    if (code !== 0) process.exit(code);
  });
}
