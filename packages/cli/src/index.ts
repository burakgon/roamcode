#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ManagedInstallStatus } from "@roamcode.ai/server";
import { parseArgs, helpText, versionText } from "./args.js";

/** The slice of the started server `run` needs: a closable app, the URL, and the token state. */
interface StartedServer {
  app: { close: () => Promise<unknown> };
  url: string;
  token?: string;
  tokenGenerated: boolean;
  issuePairing?: () => { secret: string; expiresAt: number };
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
  onReady: (server: StartedServer) => void | Promise<void>;
  /** Refuse an accidental second default-port server when a managed install already exists. */
  guardManualServe?: (opts: { env: NodeJS.ProcessEnv; portWasExplicit: boolean }) => Promise<string | undefined>;
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
  /** Test seams for first-run activation. Production verifies health, then creates a one-use device link. */
  installPreflight?: () => { node: string; tmux: string };
  waitForInstalledService?: (env: NodeJS.ProcessEnv) => Promise<boolean>;
  pairInstalledService?: (opts: {
    dataDir: string;
    env: NodeJS.ProcessEnv;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
  }) => Promise<number>;
  /** Test seam for the destructive offline recovery command. */
  resetAccess?: (opts: {
    dataDir: string;
    env: NodeJS.ProcessEnv;
    publicUrl?: string;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
  }) => Promise<number>;
  apiCommand?: (opts: {
    options: ReturnType<typeof parseArgs>;
    env: NodeJS.ProcessEnv;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
  }) => Promise<number>;
}

function installPort(env: NodeJS.ProcessEnv): number {
  const candidate = Number(env.PORT);
  return Number.isInteger(candidate) && candidate >= 1 && candidate <= 65_535 ? candidate : 4280;
}

export function inspectInstallPrerequisites(): { node: string; tmux: string } {
  const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (tmux.error || tmux.status !== 0) {
    const hint =
      process.platform === "darwin"
        ? "Install it with `brew install tmux`, then run the installer again."
        : "Install it with your system package manager (for Ubuntu/Debian: `sudo apt-get install tmux`), then run the installer again.";
    throw new Error(`tmux is required for persistent Sessions. ${hint}`);
  }
  return {
    node: process.version,
    tmux: String(tmux.stdout || tmux.stderr).trim() || "tmux available",
  };
}

export async function waitForInstalledService(
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch = fetch,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<boolean> {
  const healthUrl = `http://127.0.0.1:${installPort(env)}/health`;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      const response = await fetchFn(healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      // launchd/systemd may still be activating the service; retry within the bounded budget.
    }
    await pause(250);
  }
  return false;
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
    onReady: async (server) => {
      // The workspace CLI may typecheck against the last built server declarations. Keep this tiny lazy
      // boundary structural so a clean source checkout does not require generated dist types first.
      const lifecycle = (await import("@roamcode.ai/server")) as unknown as {
        installProcessLifecycle(options: { close: () => Promise<unknown> }): unknown;
      };
      lifecycle.installProcessLifecycle({ close: () => server.app.close() });
    },
    guardManualServe: async ({ env, portWasExplicit }) => {
      if (env.ROAMCODE_MANAGED_EXEC === "1" || portWasExplicit) return undefined;
      const { readServiceRecord, resolveDataDir } = await import("@roamcode.ai/server");
      if (!readServiceRecord(resolveDataDir(env))) return undefined;
      return accidentalManagedPortMessage();
    },
  };
}

export function accidentalManagedPortMessage(): string {
  return (
    "An installed RoamCode service already owns the default port. " +
    "For development use `roamcode --port 0`; to intentionally use 4280, stop the service and pass `--port 4280`."
  );
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
      const preflight = deps.installPreflight ? deps.installPreflight() : inspectInstallPrerequisites();
      deps.stdout(
        `RoamCode installer · v${versionText()}\n` +
          `  ✓ Node ${preflight.node}\n` +
          `  ✓ ${preflight.tmux}\n\n` +
          "Installing the managed runtime…\n",
      );
      const managed = deps.installManaged
        ? await deps.installManaged({ version: versionText(), installRoot, dataDir, env: deps.env })
        : await server.installManagedRelease({
            version: versionText(),
            installRoot,
            dataDir,
            restart: false,
            onStatus: (status: ManagedInstallStatus) => deps.stdout(`  ${status.phase ?? status.state}\n`),
          });
      const { path, record } = server.installService({
        nodePath: process.execPath,
        executablePath: managed.launcherPath,
        dataDir,
        installRoot,
      });
      if (deps.env.RC_NO_START === "1") {
        deps.stdout(
          `\n✓ Installed RoamCode v${versionText()} without starting it.\n` +
            `  Service unit: ${path}\n\n` +
            "Next: start the service, then run `roamcode pair`.\n",
        );
      } else {
        const enabled = deps.enableInstalledService
          ? deps.enableInstalledService(record)
          : server.enableService(record);
        if (!enabled.ok) throw new Error(enabled.error ?? "could not start the installed service");
        const healthy = deps.waitForInstalledService
          ? await deps.waitForInstalledService(deps.env)
          : await waitForInstalledService(deps.env);
        if (!healthy) {
          throw new Error(
            `RoamCode was installed, but the service did not become healthy at http://127.0.0.1:${installPort(deps.env)}. Run \`roamcode status\`, then check the troubleshooting guide.`,
          );
        }
        deps.stdout(
          `\n✓ Installed RoamCode v${versionText()}\n` +
            `✓ Service is running at http://127.0.0.1:${installPort(deps.env)}\n` +
            `  Service unit: ${path}\n\n`,
        );
        const pair =
          deps.pairInstalledService ??
          (async (pairOptions) => {
            const { runPairCommand } = await import("./pair.js");
            return runPairCommand(pairOptions);
          });
        const pairCode = await pair({
          dataDir,
          env: deps.env,
          stdout: deps.stdout,
          stderr: deps.stderr,
        });
        if (pairCode !== 0) {
          throw new Error(
            "RoamCode is running, but the first pairing link could not be created. Run `roamcode pair` to retry.",
          );
        }
        deps.stdout("\nNext: open the one-use link above, choose an Agent, and start your first Session.\n");
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
  if (opts.command === "pair") {
    const [{ runPairCommand }, { resolveDataDir }] = await Promise.all([
      import("./pair.js"),
      import("@roamcode.ai/server"),
    ]);
    return runPairCommand({
      dataDir: resolveDataDir(deps.env),
      env: deps.env,
      publicUrl: opts.publicUrl,
      stdout: deps.stdout,
      stderr: deps.stderr,
    });
  }
  if (opts.command === "reset-access") {
    if (!opts.confirm) {
      deps.stderr("reset-access revokes every paired device; rerun with --confirm to continue\n");
      return 2;
    }
    const { resolveDataDir } = await import("@roamcode.ai/server");
    const reset = deps.resetAccess ?? (await import("./access-reset.js")).runAccessReset;
    return reset({
      dataDir: resolveDataDir(deps.env),
      env: deps.env,
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
      stdout: deps.stdout,
      stderr: deps.stderr,
    });
  }
  if (opts.command === "api") {
    const apiCommand = deps.apiCommand ?? (await import("./api-command.js")).runApiCommand;
    return apiCommand({ options: opts, env: deps.env, stdout: deps.stdout, stderr: deps.stderr });
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
  const configuredPort = deps.env.PORT === undefined ? Number.NaN : Number.parseInt(deps.env.PORT, 10);
  const portWasExplicit = opts.port !== undefined || !Number.isNaN(configuredPort);
  if (opts.port !== undefined) env.PORT = opts.port;
  if (opts.bind !== undefined) env.BIND_ADDRESS = opts.bind;
  if (opts.noToken) env.NO_TOKEN = "1";

  const guardMessage = await deps.guardManualServe?.({ env, portWasExplicit });
  if (guardMessage) {
    deps.stderr(`${guardMessage}\n`);
    return 1;
  }

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
      // First run now exposes only a short-lived, single-use pairing capability. The durable host token
      // remains on disk and never enters browser history, proxy logs, or the terminal transcript.
      if (server.issuePairing) {
        const { buildPairingUrl, pairingBaseUrl } = await import("./pair.js");
        const pairing = server.issuePairing();
        const advertisedOrigin = deps.env.ROAMCODE_PUBLIC_URL ?? deps.env.REMOTE_CODER_PUBLIC_URL ?? server.url;
        const pairUrl = buildPairingUrl(pairingBaseUrl(advertisedOrigin, deps.env), pairing.secret);
        deps.stdout(`  Open this one-time link within 5 minutes to pair this device:\n    ${pairUrl}\n`);
      } else {
        deps.stdout("  Access initialized. Run `roamcode pair` to connect a device.\n");
      }
    } else {
      deps.stdout("  Run `roamcode pair` whenever you want to connect another device.\n");
    }
  } else {
    deps.stdout(`  (NO_TOKEN loopback dev mode — no access token required)\n`);
  }
  deps.stdout(`\n  For remote access put this behind an HTTPS tunnel (see the README).\n\n`);

  await deps.onReady(server);
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
