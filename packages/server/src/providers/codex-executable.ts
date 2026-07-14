import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { parseCodexVersion, type CodexInstallProvenance } from "./codex-latest-service.js";

export const CODEX_EXECUTABLE_PROBE_TIMEOUT_MS = 5_000;
export const OPENAI_CODE_SIGNING_TEAM_ID = "2DC432GLL2";

const STATE_SCHEMA_VERSION = 1;
const MAX_MANAGED_CODEX_BYTES = 1024 * 1024 * 1024;
const MANAGED_DIRECTORY = "provider-bin";
const MANAGED_EXECUTABLE = "codex-macos";
const STATE_FILE = "codex-macos-source.json";
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024;

export type CodexExecutableProbe = { state: "ready"; version: string } | { state: "timeout" } | { state: "failed" };

export interface CodexExecutableResolution {
  /** Executable used by every Codex terminal and auxiliary service for this server process. */
  executable: string;
  /** User-selected executable before a managed macOS recovery copy is considered. */
  sourceExecutable: string;
  provenance: CodexInstallProvenance;
  /** True only when the verified private copy is active. The source installation is never modified. */
  recovered: boolean;
}

interface SourceIdentity {
  sourcePath: string;
  device: string;
  inode: string;
  size: number;
  modifiedAtMs: number;
}

interface ManagedState extends SourceIdentity {
  schemaVersion: 1;
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

function identityFor(sourcePath: string, sourceStat: Stats): SourceIdentity {
  return {
    sourcePath,
    device: String(sourceStat.dev),
    inode: String(sourceStat.ino),
    size: sourceStat.size,
    modifiedAtMs: sourceStat.mtimeMs,
  };
}

function parseManagedState(raw: string): ManagedState | undefined {
  try {
    const value = JSON.parse(raw) as Partial<ManagedState>;
    if (
      value.schemaVersion !== STATE_SCHEMA_VERSION ||
      typeof value.sourcePath !== "string" ||
      typeof value.device !== "string" ||
      typeof value.inode !== "string" ||
      typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      typeof value.modifiedAtMs !== "number" ||
      !Number.isFinite(value.modifiedAtMs)
    ) {
      return undefined;
    }
    return value as ManagedState;
  } catch {
    return undefined;
  }
}

function stateMatches(state: ManagedState, identity: SourceIdentity): boolean {
  return (
    state.sourcePath === identity.sourcePath &&
    state.device === identity.device &&
    state.inode === identity.inode &&
    state.size === identity.size &&
    state.modifiedAtMs === identity.modifiedAtMs
  );
}

async function usableManagedExecutable(
  target: string,
  env: NodeJS.ProcessEnv,
  deps: CodexExecutableDeps,
): Promise<boolean> {
  try {
    const targetStat = await lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return false;
    if (!(await deps.verifyOfficialSignature(target))) return false;
    return (await deps.probe(target, env)).state === "ready";
  } catch {
    return false;
  }
}

/**
 * macOS 26 can indefinitely block a valid OpenAI-signed Codex Homebrew Cask binary in `_dyld_start`.
 * A byte-identical executable at a fresh, non-quarantined path starts normally. On an observed timeout,
 * this resolver creates that private copy only after checking the embedded official OpenAI signature.
 * It never modifies the user's Codex installation and never applies the workaround to an unsigned binary.
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
    executable: source,
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
  if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > MAX_MANAGED_CODEX_BYTES) return ordinary;

  const identity = identityFor(source, sourceStat);
  const managedDir = join(options.dataDir, MANAGED_DIRECTORY);
  const target = join(managedDir, MANAGED_EXECUTABLE);
  const statePath = join(managedDir, STATE_FILE);
  try {
    const state = parseManagedState(await readFile(statePath, "utf8"));
    if (state && stateMatches(state, identity) && (await usableManagedExecutable(target, env, deps))) {
      return { executable: target, sourceExecutable: source, provenance, recovered: true };
    }
  } catch {
    // No matching cache is the normal first-run/update path.
  }

  const sourceProbe = await deps.probe(source, env);
  if (sourceProbe.state !== "timeout") return ordinary;
  if (!(await deps.verifyOfficialSignature(source))) return ordinary;

  const nonce = randomUUID();
  const temporaryExecutable = join(managedDir, `.codex-${nonce}.tmp`);
  const temporaryState = join(managedDir, `.codex-state-${nonce}.tmp`);
  try {
    await mkdir(managedDir, { recursive: true, mode: 0o700 });
    await chmod(managedDir, 0o700);
    await copyFile(source, temporaryExecutable, constants.COPYFILE_EXCL);
    await chmod(temporaryExecutable, 0o700);
    if (!(await deps.clearExtendedAttributes(temporaryExecutable))) return ordinary;
    if (!(await deps.verifyOfficialSignature(temporaryExecutable))) return ordinary;
    if ((await deps.probe(temporaryExecutable, env)).state !== "ready") return ordinary;
    await rename(temporaryExecutable, target);
    if (!(await usableManagedExecutable(target, env, deps))) return ordinary;
    const state: ManagedState = { schemaVersion: STATE_SCHEMA_VERSION, ...identity };
    await writeFile(temporaryState, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryState, statePath);
    return { executable: target, sourceExecutable: source, provenance, recovered: true };
  } catch {
    return ordinary;
  } finally {
    await Promise.all([
      rm(temporaryExecutable, { force: true }).catch(() => undefined),
      rm(temporaryState, { force: true }).catch(() => undefined),
    ]);
  }
}
