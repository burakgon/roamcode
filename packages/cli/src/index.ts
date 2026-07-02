import { pathToFileURL } from "node:url";
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
}

function defaultDeps(): RunDeps {
  return {
    // Lazy import so merely importing this module (e.g. in a unit test that injects its own deps)
    // doesn't pull in the server's native/heavy dependency graph (better-sqlite3, fastify, web-push).
    startServer: async (env) => {
      const { startServer } = await import("@remote-coder/server");
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
    // Lazy imports so the serve path doesn't pull these in; `install.ts` only needs fs + os.
    const { installService } = await import("./install.js");
    const { resolveDataDir } = await import("@remote-coder/server");
    const cliPath = process.argv[1] ?? "";
    try {
      const { path, instructions } = installService({
        nodePath: process.execPath,
        cliPath,
        dataDir: resolveDataDir(deps.env),
      });
      deps.stdout(`Wrote service unit: ${path}\n\nTo start it:\n${instructions}\n`);
    } catch (err) {
      deps.stderr(`${(err as Error).message}\n`);
      return 1;
    }
    return 0;
  }
  if (opts.command === "uninstall") {
    deps.stdout(
      "macOS:  launchctl unload -w ~/Library/LaunchAgents/com.remote-coder.plist && rm ~/Library/LaunchAgents/com.remote-coder.plist\n" +
        "Linux:  systemctl --user disable --now remote-coder && rm ~/.config/systemd/user/remote-coder.service\n" +
        "\nYour data (token, push subscriptions, session index) stays in ~/.config/remote-coder.\n" +
        "To remove it too:  rm -rf ~/.config/remote-coder   # deletes your token + history\n",
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
    deps.stderr(`remote-coder failed to start: ${(err as Error).message}\n`);
    return 1;
  }

  const { url, token, tokenGenerated } = server;
  deps.stdout(`\nRemote Coder is running.\n  Open: ${url}\n`);
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

// Run when executed directly (the `remote-coder` bin), not when imported by a test.
// pathToFileURL handles spaces/Windows drive paths correctly (matches start.ts) — a hand-built
// `file://${process.argv[1]}` string would mismatch for any path needing percent-encoding.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void run(process.argv.slice(2)).then((code) => {
    // A non-zero code from a one-shot path (help/version always return 0) means a parse/start error;
    // a successful boot returns 0 and keeps the event loop alive via the open listener.
    if (code !== 0) process.exit(code);
  });
}
