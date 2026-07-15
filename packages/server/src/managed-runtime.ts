import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { migrateServiceToLauncher, readServiceRecord, restartService } from "./service-install.js";

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LOCK_STALE_MS = 30 * 60_000;
const NPM_INSTALL_POLICY = `${JSON.stringify(
  {
    private: true,
    allowScripts: {
      "better-sqlite3@12.11.1": true,
      "node-pty@1.1.0": true,
    },
  },
  null,
  2,
)}\n`;

export interface ManagedPaths {
  root: string;
  releases: string;
  staging: string;
  current: string;
  previous: string;
  bin: string;
  launcher: string;
  lock: string;
}

export function resolveInstallRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.ROAMCODE_INSTALL_ROOT || join(home, ".local", "share", "roamcode");
}

export function managedPaths(root: string): ManagedPaths {
  return {
    root,
    releases: join(root, "releases"),
    staging: join(root, "staging"),
    current: join(root, "current"),
    previous: join(root, "previous"),
    bin: join(root, "bin"),
    launcher: join(root, "bin", "roamcode"),
    lock: join(root, "update.lock"),
  };
}

export function isStableVersion(value: string): boolean {
  return VERSION_RE.test(value);
}

export function compareVersions(a: string, b: string): number {
  if (!isStableVersion(a) || !isStableVersion(b)) throw new Error(`invalid stable version: ${a} / ${b}`);
  const av = a.split(".").map(Number);
  const bv = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (av[i]! !== bv[i]!) return av[i]! < bv[i]! ? -1 : 1;
  }
  return 0;
}

function atomicWrite(path: string, value: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, value, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

export function renderManagedLauncher(root: string, nodePath: string): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "set -eu",
    `ROOT=${q(root)}`,
    `NODE=${q(nodePath)}`,
    'if [ ! -x "$NODE" ]; then NODE="$(command -v node || true)"; fi',
    'if [ -z "$NODE" ]; then echo "Node.js >= 24 is required" >&2; exit 1; fi',
    'ENTRY="$ROOT/current/node_modules/roamcode/dist/index.js"',
    'if [ ! -f "$ENTRY" ]; then',
    '  echo "roamcode managed runtime is missing; run: npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest install" >&2',
    "  exit 1",
    "fi",
    'export ROAMCODE_INSTALL_ROOT="$ROOT"',
    'export ROAMCODE_MANAGED_EXEC="1"',
    'exec "$NODE" "$ENTRY" "$@"',
    "",
  ].join("\n");
}

export function writeManagedLauncher(root: string, nodePath = process.execPath): string {
  const paths = managedPaths(root);
  mkdirSync(paths.bin, { recursive: true, mode: 0o700 });
  atomicWrite(paths.launcher, renderManagedLauncher(root, nodePath), 0o700);
  return paths.launcher;
}

function versionFromReleaseDir(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as { version?: unknown };
    if (typeof manifest.version === "string" && isStableVersion(manifest.version)) return manifest.version;
  } catch {
    // Older managed installs may not have release.json; fall back to the npm package manifest.
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "node_modules", "roamcode", "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" && isStableVersion(pkg.version) ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function integrityFromReleaseDir(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as { integrity?: unknown };
    return typeof manifest.integrity === "string" ? manifest.integrity : undefined;
  } catch {
    return undefined;
  }
}

export function readActiveVersion(root: string): string | undefined {
  const current = managedPaths(root).current;
  try {
    return versionFromReleaseDir(realpathSync(current));
  } catch {
    return undefined;
  }
}

export function readPreviousVersion(root: string): string | undefined {
  try {
    return versionFromReleaseDir(realpathSync(managedPaths(root).previous));
  } catch {
    return undefined;
  }
}

export interface ManagedInstallStatus {
  operationId: string;
  state: "starting" | "downloading" | "installing" | "verifying" | "activating" | "restarting" | "done" | "failed";
  phase?: string;
  target?: string;
  fromVersion?: string;
  error?: string;
  log?: string;
  updatedAt: number;
}

export interface ManagedInstallOptions {
  version: string;
  installRoot: string;
  dataDir: string;
  operationId?: string;
  expectedIntegrity?: string;
  expectedIntegrities?: Record<string, string>;
  nodePath?: string;
  npmCommand?: string;
  restart?: boolean;
  rollback?: boolean;
  now?: () => number;
  onStatus?: (status: ManagedInstallStatus) => void;
}

export interface ManagedInstallResult {
  version: string;
  previousVersion?: string;
  releaseDir: string;
  launcherPath: string;
}

function acquireLock(path: string, now: number): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now }) + "\n");
    closeSync(fd);
  } catch {
    try {
      if (now - lstatSync(path).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(path);
        return acquireLock(path, now);
      }
    } catch {
      // The competing process may have removed it; the retry below will either acquire or report busy.
      try {
        return acquireLock(path, now);
      } catch {
        // handled by the stable error below
      }
    }
    throw new Error("an update is already in progress");
  }
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // best effort
    }
  };
}

async function runLogged(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; log: (line: string) => void },
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => opts.log(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => opts.log(chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${basename(command)} exited ${code}`)),
    );
  });
}

function npmInvocation(npmCommand: string, args: string[], nodePath: string): { command: string; args: string[] } {
  if (npmCommand.endsWith(".js") || npmCommand.endsWith(".cjs"))
    return { command: nodePath, args: [npmCommand, ...args] };
  return { command: npmCommand, args };
}

function npmProjectEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.toLowerCase() === "npm_config_allow_scripts") delete clean[key];
  }
  return clean;
}

async function npmIntegrity(
  npmCommand: string,
  packageName: string,
  version: string,
  nodePath: string,
  log: (line: string) => void,
): Promise<string> {
  let output = "";
  const invocation = npmInvocation(
    npmCommand,
    ["view", `${packageName}@${version}`, "dist.integrity", "--json"],
    nodePath,
  );
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: npmProjectEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => log(chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`npm view exited ${code}`))));
  });
  const parsed = JSON.parse(output) as unknown;
  if (typeof parsed !== "string" || !parsed.startsWith("sha512-")) throw new Error("npm returned no package integrity");
  return parsed;
}

async function smokeServer(
  serverEntry: string,
  dataDir: string,
  nodePath: string,
  log: (line: string) => void,
): Promise<void> {
  const smokeDir = join(tmpdir(), `roamcode-smoke-${process.pid}-${randomUUID()}`);
  mkdirSync(smokeDir, { recursive: true, mode: 0o700 });
  let output = "";
  const child = spawn(nodePath, [serverEntry], {
    env: {
      ...process.env,
      PORT: "0",
      BIND_ADDRESS: "127.0.0.1",
      ACCESS_TOKEN: `rc-smoke-${randomUUID()}`,
      ROAMCODE_DATA_DIR: smokeDir,
      RC_TMUX_SOCKET: `rc-smoke-${process.pid}`,
      ROAMCODE_INSTALL_ROOT: "",
      // The boot smoke already owns this isolated child and health-checks it directly. Never let an
      // inherited managed-launcher marker create a second supervisor for the throwaway process.
      ROAMCODE_DISABLE_WATCHDOG: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    log(text);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      const deadline = setTimeout(() => reject(new Error("new release did not start within 25s")), 25_000);
      const poll = setInterval(() => {
        const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match?.[1]) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolveUrl(match[1]);
        }
      }, 100);
      child.once("exit", (code) => {
        clearInterval(poll);
        clearTimeout(deadline);
        reject(new Error(`new release exited before health check (${code})`));
      });
    });
    const healthy = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!healthy.ok) throw new Error(`new release health check returned ${healthy.status}`);
  } finally {
    child.kill("SIGTERM");
    rmSync(smokeDir, { recursive: true, force: true });
    // dataDir is intentionally part of the signature: callers cannot accidentally smoke with production data.
    void dataDir;
  }
}

function replaceSymlink(link: string, target: string): void {
  const temp = `${link}.${process.pid}.${randomUUID()}.new`;
  try {
    unlinkSync(temp);
  } catch {
    // absent
  }
  // Canonicalize both sides before computing a relative link. On macOS `/var` resolves to
  // `/private/var`; mixing one spelling from mkdtemp with the other from realpath creates a broken link.
  const parent = realpathSync(dirname(link));
  const canonicalTarget = realpathSync(target);
  symlinkSync(relative(parent, canonicalTarget), temp, "dir");
  renameSync(temp, link);
}

function trimLog(log: string): string {
  return log.split("\n").slice(-20).join("\n").slice(-8_000);
}

export async function installManagedRelease(opts: ManagedInstallOptions): Promise<ManagedInstallResult> {
  if (!isStableVersion(opts.version)) throw new Error(`invalid release version: ${opts.version}`);
  const now = opts.now ?? Date.now;
  const operationId = opts.operationId ?? randomUUID();
  const nodePath = opts.nodePath ?? process.execPath;
  const npmCommand = opts.npmCommand ?? process.env.npm_execpath ?? "npm";
  const expectedIntegrities =
    opts.expectedIntegrities ?? (opts.expectedIntegrity ? { roamcode: opts.expectedIntegrity } : {});
  const rootIntegrity = expectedIntegrities.roamcode;
  const paths = managedPaths(opts.installRoot);
  mkdirSync(paths.releases, { recursive: true, mode: 0o700 });
  mkdirSync(paths.staging, { recursive: true, mode: 0o700 });
  const release = join(paths.releases, opts.version);
  const stage = join(paths.staging, `${opts.version}-${process.pid}-${randomUUID()}`);
  let logText = "";
  const log = (line: string) => {
    logText += line.endsWith("\n") ? line : `${line}\n`;
    mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(opts.dataDir, "update.log"), line.endsWith("\n") ? line : `${line}\n`, { flag: "a" });
  };
  const fromVersion = readActiveVersion(opts.installRoot);
  const status = (state: ManagedInstallStatus["state"], phase: string, error?: string): void => {
    opts.onStatus?.({
      operationId,
      state,
      phase,
      target: opts.version,
      ...(fromVersion ? { fromVersion } : {}),
      ...(error ? { error } : {}),
      log: trimLog(logText),
      updatedAt: now(),
    });
  };
  const releaseLock = acquireLock(paths.lock, now());
  let activated = false;
  try {
    status("starting", "preparing");
    const reusableRelease =
      existsSync(release) &&
      versionFromReleaseDir(release) === opts.version &&
      (!rootIntegrity || integrityFromReleaseDir(release) === rootIntegrity);
    if (!reusableRelease) {
      if (Object.keys(expectedIntegrities).length > 0) {
        status("downloading", "checking package integrity");
        for (const [packageName, expected] of Object.entries(expectedIntegrities)) {
          const actual = await npmIntegrity(npmCommand, packageName, opts.version, nodePath, log);
          if (actual !== expected) throw new Error(`GitHub release and npm integrity do not match for ${packageName}`);
        }
      }
      status("installing", "installing package");
      mkdirSync(stage, { recursive: true, mode: 0o700 });
      atomicWrite(join(stage, "package.json"), NPM_INSTALL_POLICY);
      const invocation = npmInvocation(
        npmCommand,
        [
          "install",
          "--prefix",
          stage,
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          `roamcode@${opts.version}`,
        ],
        nodePath,
      );
      await runLogged(invocation.command, invocation.args, { env: npmProjectEnv(), log });
      const installed = versionFromReleaseDir(stage);
      if (installed !== opts.version)
        throw new Error(`installed roamcode ${installed ?? "unknown"}, expected ${opts.version}`);
      const serverEntry = join(stage, "node_modules", "@roamcode.ai", "server", "dist", "start.js");
      if (!existsSync(serverEntry)) throw new Error("published package is missing @roamcode.ai/server/dist/start.js");
      status("verifying", "boot smoke");
      await smokeServer(serverEntry, opts.dataDir, nodePath, log);
      atomicWrite(
        join(stage, "release.json"),
        JSON.stringify(
          {
            version: opts.version,
            installedAt: now(),
            package: `roamcode@${opts.version}`,
            ...(rootIntegrity ? { integrity: rootIntegrity } : {}),
          },
          null,
          2,
        ) + "\n",
      );
      if (existsSync(release)) rmSync(release, { recursive: true, force: true });
      renameSync(stage, release);
    } else {
      const serverEntry = join(release, "node_modules", "@roamcode.ai", "server", "dist", "start.js");
      if (!existsSync(serverEntry)) throw new Error(`managed release ${opts.version} is incomplete`);
      status("verifying", "verifying installed release");
      await smokeServer(serverEntry, opts.dataDir, nodePath, log);
    }

    status("activating", "activating release");
    let oldTarget: string | undefined;
    try {
      oldTarget = realpathSync(paths.current);
    } catch {
      oldTarget = undefined;
    }
    if (oldTarget && resolve(oldTarget) !== resolve(release)) replaceSymlink(paths.previous, oldTarget);
    replaceSymlink(paths.current, release);
    activated = true;
    const launcherPath = writeManagedLauncher(opts.installRoot, nodePath);
    const existingService = readServiceRecord(opts.dataDir);
    const record = existingService
      ? migrateServiceToLauncher({
          dataDir: opts.dataDir,
          installRoot: opts.installRoot,
          launcherPath,
          nodePath,
        })
      : undefined;

    if (opts.restart && record) {
      status("restarting", "restarting service");
      const restarted = restartService(record);
      if (!restarted.ok) throw new Error(restarted.error ?? "service restart failed");
    }
    status("done", "done");

    // Keep only the active release and its rollback target. A failed/staged release is cleaned in finally.
    const keep = new Set([opts.version, fromVersion].filter((value): value is string => !!value));
    for (const name of readdirSync(paths.releases)) {
      if (isStableVersion(name) && !keep.has(name))
        rmSync(join(paths.releases, name), { recursive: true, force: true });
    }
    return {
      version: opts.version,
      ...(fromVersion ? { previousVersion: fromVersion } : {}),
      releaseDir: release,
      launcherPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`FAILED: ${message}`);
    // If activation happened but restart failed, restore the previous pointer when available.
    if (activated) {
      try {
        const previous = realpathSync(paths.previous);
        replaceSymlink(paths.current, previous);
      } catch {
        // no previous managed release (first migration); the new release already passed boot-smoke
      }
    }
    status("failed", "failed", message);
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    releaseLock();
  }
}

export function writeManagedStatus(dataDir: string, status: ManagedInstallStatus): void {
  atomicWrite(join(dataDir, "update-status.json"), JSON.stringify(status, null, 2) + "\n", 0o600);
}

export function readManagedStatus(dataDir: string): ManagedInstallStatus | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, "update-status.json"), "utf8")) as ManagedInstallStatus;
    return parsed && typeof parsed.operationId === "string" && typeof parsed.state === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
