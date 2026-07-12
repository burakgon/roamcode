export const CODEX_VERSION_UNAVAILABLE = "CODEX_VERSION_UNAVAILABLE" as const;
export const CODEX_VERSION_TIMEOUT_MS = 5_000;
export const CODEX_VERSION_MAX_OUTPUT_BYTES = 1_024;
export const CODEX_LATEST_MAX_RESPONSE_BYTES = 16_384;
export const DEFAULT_CODEX_VERSION_CACHE_TTL_MS = 5 * 60_000;

export type CodexInstallProvenance = "npm" | "chatgpt" | "homebrew" | "unknown";

export interface BoundedVersionRunOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface BoundedLatestFetchOptions {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export type RunCodexVersion = (
  args: readonly string[],
  options: BoundedVersionRunOptions,
) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

export type DetectCodexProvenance = () => CodexInstallProvenance | Promise<CodexInstallProvenance>;
export type FetchNpmLatest = (packageName: string, options: BoundedLatestFetchOptions) => Promise<string>;

export interface CodexLatestServiceOptions {
  readonly runVersion: RunCodexVersion;
  readonly detectProvenance: DetectCodexProvenance;
  readonly fetchNpmLatest: FetchNpmLatest;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

export interface CodexVersionInfo {
  readonly installed: string;
  readonly provenance: CodexInstallProvenance;
  readonly latest?: string;
  readonly updateAvailable?: boolean;
  readonly updateHint?: string;
}

export class CodexVersionUnavailableError extends Error {
  readonly code = CODEX_VERSION_UNAVAILABLE;

  constructor() {
    super("Codex version is unavailable");
    this.name = "CodexVersionUnavailableError";
  }
}

const SEMVER_SOURCE =
  "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const SEMVER_RE = new RegExp(`^${SEMVER_SOURCE}$`);
const CODEX_VERSION_RE = new RegExp(`^codex-cli (${SEMVER_SOURCE})\\r?\\n?$`);

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: readonly string[];
}

function unavailable(): CodexVersionUnavailableError {
  return new CodexVersionUnavailableError();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseSemver(value: string): ParsedSemver | undefined {
  const match = SEMVER_RE.exec(value);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const prerelease = match[4]?.split(".");
  if (
    prerelease?.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))
  ) {
    return undefined;
  }
  return { major, minor, patch, ...(prerelease ? { prerelease } : {}) };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return left.length - right.length;
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const compared = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function parseCodexVersion(stdout: string): string {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > CODEX_VERSION_MAX_OUTPUT_BYTES) throw unavailable();
  const match = CODEX_VERSION_RE.exec(stdout);
  if (!match || !parseSemver(match[1]!)) throw unavailable();
  return match[1]!;
}

function hintFor(provenance: Exclude<CodexInstallProvenance, "npm">): string {
  if (provenance === "chatgpt") return "Update Codex through the ChatGPT app.";
  if (provenance === "homebrew") return "Update Codex through Homebrew.";
  return "Update Codex through the installation source that provided it.";
}

export class CodexLatestService {
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private cache?: { at: number; info: CodexVersionInfo };
  private inFlight?: Promise<CodexVersionInfo>;

  constructor(private readonly options: CodexLatestServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.cacheTtlMs = positiveInteger(options.cacheTtlMs, DEFAULT_CODEX_VERSION_CACHE_TTL_MS);
  }

  async getVersion(force = false): Promise<CodexVersionInfo> {
    const now = this.now();
    if (!force && this.cache && now - this.cache.at < this.cacheTtlMs) return { ...this.cache.info };
    if (this.inFlight) return { ...(await this.inFlight) };
    const request = this.loadVersion();
    this.inFlight = request;
    try {
      const info = await request;
      this.cache = { at: this.now(), info: { ...info } };
      return { ...info };
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  private async loadVersion(): Promise<CodexVersionInfo> {
    let run: Awaited<ReturnType<RunCodexVersion>>;
    try {
      run = await this.options.runVersion(["--version"], {
        timeoutMs: CODEX_VERSION_TIMEOUT_MS,
        maxOutputBytes: CODEX_VERSION_MAX_OUTPUT_BYTES,
      });
    } catch {
      throw unavailable();
    }
    if (
      run.code !== 0 ||
      typeof run.stdout !== "string" ||
      typeof run.stderr !== "string" ||
      Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr) > CODEX_VERSION_MAX_OUTPUT_BYTES
    ) {
      throw unavailable();
    }
    const installed = parseCodexVersion(run.stdout);

    let provenance: CodexInstallProvenance;
    try {
      provenance = await this.options.detectProvenance();
    } catch {
      provenance = "unknown";
    }
    if (!(["npm", "chatgpt", "homebrew", "unknown"] as const).includes(provenance)) provenance = "unknown";
    if (provenance !== "npm") return { installed, provenance, updateHint: hintFor(provenance) };

    try {
      const latestRaw = await this.options.fetchNpmLatest("@openai/codex", {
        timeoutMs: CODEX_VERSION_TIMEOUT_MS,
        maxResponseBytes: CODEX_LATEST_MAX_RESPONSE_BYTES,
      });
      if (typeof latestRaw !== "string" || Buffer.byteLength(latestRaw) > 256) throw unavailable();
      const latest = latestRaw.trim();
      const installedSemver = parseSemver(installed);
      const latestSemver = parseSemver(latest);
      if (!installedSemver || !latestSemver) throw unavailable();
      return {
        installed,
        latest,
        updateAvailable: compareSemver(installedSemver, latestSemver) < 0,
        provenance,
      };
    } catch {
      return {
        installed,
        provenance,
        updateHint: "Latest npm version is temporarily unavailable.",
      };
    }
  }
}
