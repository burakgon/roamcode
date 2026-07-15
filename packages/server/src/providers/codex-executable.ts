import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, chmod, copyFile, link, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { parseCodexVersion, type CodexInstallProvenance } from "./codex-latest-service.js";

export const CODEX_EXECUTABLE_PROBE_TIMEOUT_MS = 5_000;
export const OPENAI_CODE_SIGNING_TEAM_ID = "2DC432GLL2";

const MAX_CODEX_BYTES = 1024 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024;
const LEGACY_MANAGED_DIRECTORY = "provider-bin";
const LEGACY_MANAGED_EXECUTABLE = "codex-macos";
const LEGACY_MANAGED_STATE = "codex-macos-source.json";

export type CodexExecutableProbe = { state: "ready"; version: string } | { state: "timeout" } | { state: "failed" };

export interface CodexExecutableResolution {
  /** Stable user-selected command used by Codex terminals and auxiliary services. */
  executable: string;
  /** Resolved source installation inspected during boot. */
  sourceExecutable: string;
  provenance: CodexInstallProvenance;
  /** True only when a blocked OpenAI-signed Homebrew executable was atomically repaired in place. */
  recovered: boolean;
}

export interface CodexExecutableDeps {
  platform: NodeJS.Platform;
  resolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  probe(executable: string, env: NodeJS.ProcessEnv): Promise<CodexExecutableProbe>;
  verifyOfficialSignature(executable: string): Promise<boolean>;
  clearExtendedAttributes(executable: string): Promise<boolean>;
}

export interface ResolveCodexExecutableOptions {
  codexBin: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<CodexExecutableDeps>;
}

function runBounded(
  executable: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
): Promise<{ error?: Error & { killed?: boolean; signal?: NodeJS.Signals | null }; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        ...(options.env ? { env: options.env } : {}),
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        resolve({
          ...(error ? { error: error as Error & { killed?: boolean; signal?: NodeJS.Signals | null } } : {}),
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

export async function defaultProbeCodexExecutable(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<CodexExecutableProbe> {
  const result = await runBounded(executable, ["--version"], {
    env,
    timeoutMs: CODEX_EXECUTABLE_PROBE_TIMEOUT_MS,
    maxOutputBytes: 1_024,
  });
  if (result.error) {
    if (result.error.killed || result.error.signal === "SIGTERM" || result.error.signal === "SIGKILL") {
      return { state: "timeout" };
    }
    return { state: "failed" };
  }
  try {
    return { state: "ready", version: parseCodexVersion(result.stdout) };
  } catch {
    return { state: "failed" };
  }
}

async function defaultResolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates =
    isAbsolute(command) || command.includes(sep)
      ? [command]
      : (env.PATH ?? process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // A PATH entry that is absent, unreadable, or a broken symlink is not executable.
    }
  }
  return undefined;
}

async function defaultVerifyOfficialSignature(executable: string): Promise<boolean> {
  const verified = await runBounded("/usr/bin/codesign", ["--verify", "--strict", executable], {
    timeoutMs: 5_000,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (verified.error) return false;
  const details = await runBounded("/usr/bin/codesign", ["-d", "--verbose=4", executable], {
    timeoutMs: 5_000,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (details.error) return false;
  return (
    new RegExp(`^TeamIdentifier=${OPENAI_CODE_SIGNING_TEAM_ID}$`, "m").test(details.stderr) &&
    /^Identifier=codex$/m.test(details.stderr)
  );
}

async function defaultClearExtendedAttributes(executable: string): Promise<boolean> {
  const result = await runBounded("/usr/bin/xattr", ["-c", executable], {
    timeoutMs: 5_000,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
  });
  return !result.error;
}

const defaultDeps: CodexExecutableDeps = {
  platform: process.platform,
  resolveExecutable: defaultResolveExecutable,
  probe: defaultProbeCodexExecutable,
  verifyOfficialSignature: defaultVerifyOfficialSignature,
  clearExtendedAttributes: defaultClearExtendedAttributes,
};

function provenanceFor(executable: string): CodexInstallProvenance {
  const normalized = executable.replaceAll("\\", "/");
  if (/\/Caskroom\/codex\//i.test(normalized)) return "homebrew";
  if (/\/Applications\/Codex\.app\//i.test(normalized)) return "chatgpt";
  if (/\/node_modules\/(?:@openai\/codex|@openai\/codex-[^/]+)\//i.test(normalized)) return "npm";
  return "unknown";
}

function validSource(sourceStat: Stats): boolean {
  return sourceStat.isFile() && sourceStat.size > 0 && sourceStat.size <= MAX_CODEX_BYTES;
}

function sameSource(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function removeLegacyManagedCopy(dataDir: string): Promise<void> {
  const directory = join(dataDir, LEGACY_MANAGED_DIRECTORY);
  await Promise.all([
    rm(join(directory, LEGACY_MANAGED_EXECUTABLE), { force: true }).catch(() => undefined),
    rm(join(directory, LEGACY_MANAGED_STATE), { force: true }).catch(() => undefined),
  ]);
  await rmdir(directory).catch(() => undefined);
}

/**
 * macOS can keep an otherwise valid Homebrew Codex Mach-O blocked in `_dyld_start` for the lifetime of its inode.
 * Build and verify a byte-identical replacement next to it, then atomically swap that new inode into the original
 * Homebrew path. A hard-linked backup makes every post-swap failure roll back without retaining a private copy.
 */
async function repairHomebrewExecutable(
  source: string,
  sourceStat: Stats,
  env: NodeJS.ProcessEnv,
  deps: CodexExecutableDeps,
): Promise<boolean> {
  if (!(await deps.verifyOfficialSignature(source))) return false;

  const nonce = randomUUID();
  const directory = dirname(source);
  const name = basename(source);
  const temporary = join(directory, `.${name}.roamcode-repair-${nonce}`);
  const backup = join(directory, `.${name}.roamcode-backup-${nonce}`);
  let backupCreated = false;
  let sourceReplaced = false;
  let committed = false;
  let preserveBackup = false;

  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, sourceStat.mode & 0o777);
    if (!(await deps.clearExtendedAttributes(temporary))) return false;
    if (!(await deps.verifyOfficialSignature(temporary))) return false;
    if ((await deps.probe(temporary, env)).state !== "ready") return false;

    const currentStat = await stat(source);
    if (!sameSource(sourceStat, currentStat)) return false;

    await link(source, backup);
    backupCreated = true;
    await rename(temporary, source);
    sourceReplaced = true;
    if (!(await deps.verifyOfficialSignature(source))) return false;
    if ((await deps.probe(source, env)).state !== "ready") return false;
    committed = true;
    return true;
  } catch {
    return false;
  } finally {
    if (sourceReplaced && !committed && backupCreated) {
      try {
        await rename(backup, source);
        backupCreated = false;
      } catch {
        // Preserve the verified backup if the atomic rollback itself fails.
        preserveBackup = true;
      }
    }
    await rm(temporary, { force: true }).catch(() => undefined);
    if (!preserveBackup) await rm(backup, { force: true }).catch(() => undefined);
  }
}

/**
 * Probe the configured Codex CLI once at boot. Only a timed-out, officially signed Homebrew installation is
 * repaired, and the configured command remains the stable launch path so future Homebrew upgrades are not pinned
 * to an old Caskroom version.
 */
export async function resolveCodexExecutable(
  options: ResolveCodexExecutableOptions,
): Promise<CodexExecutableResolution> {
  const env = options.env ?? process.env;
  const deps: CodexExecutableDeps = { ...defaultDeps, ...options.deps };
  const unresolved: CodexExecutableResolution = {
    executable: options.codexBin,
    sourceExecutable: options.codexBin,
    provenance: "unknown",
    recovered: false,
  };
  if (deps.platform !== "darwin") return unresolved;

  const source = await deps.resolveExecutable(options.codexBin, env);
  if (!source) return unresolved;
  const provenance = provenanceFor(source);
  const ordinary: CodexExecutableResolution = {
    executable: options.codexBin,
    sourceExecutable: source,
    provenance,
    recovered: false,
  };

  let sourceStat: Stats;
  try {
    sourceStat = await stat(source);
  } catch {
    return ordinary;
  }
  if (!validSource(sourceStat)) return ordinary;

  const sourceProbe = await deps.probe(source, env);
  if (sourceProbe.state === "ready") {
    await removeLegacyManagedCopy(options.dataDir);
    return ordinary;
  }
  if (sourceProbe.state !== "timeout" || provenance !== "homebrew") return ordinary;
  if (!(await repairHomebrewExecutable(source, sourceStat, env, deps))) return ordinary;
  await removeLegacyManagedCopy(options.dataDir);
  return { ...ordinary, recovered: true };
}
