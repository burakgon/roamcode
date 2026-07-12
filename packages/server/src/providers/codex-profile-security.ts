import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const PROFILE_SUFFIX = ".config.toml";
const MAX_DIRECTORY_ENTRIES = 1_024;
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface CodexProfileFingerprint {
  readonly path: string;
  readonly realPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly digest: string;
}

export interface CodexLaunchConfigFingerprint {
  readonly homeDev: bigint;
  readonly homeIno: bigint;
  readonly homeSize: bigint;
  readonly homeMtimeNs: bigint;
  readonly base: CodexProfileFingerprint | null;
  readonly profile: CodexProfileFingerprint;
}

async function hasSymlinkComponent(path: string): Promise<boolean> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

export async function resolveSecureCodexHome(configured: string | undefined): Promise<string | undefined> {
  if (!configured || !isAbsolute(configured)) return undefined;
  try {
    if (await hasSymlinkComponent(configured)) return undefined;
    const stat = await lstat(configured, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    const canonical = await realpath(configured);
    const after = await lstat(configured, { bigint: true });
    return canonical === resolve(configured) &&
      after.isDirectory() &&
      !after.isSymbolicLink() &&
      stat.dev === after.dev &&
      stat.ino === after.ino
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}

export async function listSecureProfileNames(
  codexHome: string,
  validName: (name: string) => boolean,
): Promise<string[]> {
  if ((await resolveSecureCodexHome(codexHome)) !== codexHome) return [];
  const before = await lstat(codexHome, { bigint: true });
  const entries = await readdir(codexHome, { withFileTypes: true });
  const profiles: string[] = [];
  for (const entry of entries.slice(0, MAX_DIRECTORY_ENTRIES)) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(PROFILE_SUFFIX)) continue;
    const profile = entry.name.slice(0, -PROFILE_SUFFIX.length);
    if (!validName(profile)) continue;
    const fingerprint = await captureProfileFingerprint(codexHome, profile);
    if (fingerprint) profiles.push(profile);
  }
  const after = await lstat(codexHome, { bigint: true });
  if (
    (await resolveSecureCodexHome(codexHome)) !== codexHome ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    return [];
  }
  return [...new Set(profiles)].sort((left, right) => left.localeCompare(right));
}

export async function captureProfileFingerprint(
  codexHome: string,
  profile: string,
): Promise<CodexProfileFingerprint | undefined> {
  return captureConfigFileFingerprint(codexHome, join(codexHome, `${profile}${PROFILE_SUFFIX}`));
}

async function captureConfigFileFingerprint(
  codexHome: string,
  path: string,
): Promise<CodexProfileFingerprint | undefined> {
  try {
    if (relative(codexHome, path).startsWith("..")) return undefined;
    const stat = await lstat(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    if (stat.size > BigInt(MAX_CONFIG_BYTES)) return undefined;
    const realPath = await realpath(path);
    if (realPath !== path) return undefined;
    const contents = await readFile(path);
    const after = await lstat(path, { bigint: true });
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.size !== after.size ||
      stat.mtimeNs !== after.mtimeNs
    ) {
      return undefined;
    }
    return {
      path,
      realPath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      digest: createHash("sha256").update(contents).digest("hex"),
    };
  } catch {
    return undefined;
  }
}

export function sameProfileFingerprint(
  left: CodexProfileFingerprint,
  right: CodexProfileFingerprint | undefined,
): boolean {
  return Boolean(
    right &&
    left.path === right.path &&
    left.realPath === right.realPath &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.digest === right.digest,
  );
}

export async function captureLaunchConfigFingerprint(
  codexHome: string,
  profile: string,
): Promise<CodexLaunchConfigFingerprint | undefined> {
  try {
    if ((await resolveSecureCodexHome(codexHome)) !== codexHome) return undefined;
    const home = await lstat(codexHome, { bigint: true });
    const selected = await captureProfileFingerprint(codexHome, profile);
    if (!selected) return undefined;
    const basePath = join(codexHome, "config.toml");
    let base: CodexProfileFingerprint | null = null;
    try {
      const baseStat = await lstat(basePath);
      if (!baseStat.isFile() || baseStat.isSymbolicLink()) return undefined;
      const capturedBase = await captureConfigFileFingerprint(codexHome, basePath);
      if (!capturedBase) return undefined;
      base = capturedBase;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    return {
      homeDev: home.dev,
      homeIno: home.ino,
      homeSize: home.size,
      homeMtimeNs: home.mtimeNs,
      base,
      profile: selected,
    };
  } catch {
    return undefined;
  }
}

export function sameLaunchConfigFingerprint(
  left: CodexLaunchConfigFingerprint,
  right: CodexLaunchConfigFingerprint | undefined,
): boolean {
  return Boolean(
    right &&
    left.homeDev === right.homeDev &&
    left.homeIno === right.homeIno &&
    left.homeSize === right.homeSize &&
    left.homeMtimeNs === right.homeMtimeNs &&
    (left.base === null ? right.base === null : right.base !== null && sameProfileFingerprint(left.base, right.base)) &&
    sameProfileFingerprint(left.profile, right.profile),
  );
}
