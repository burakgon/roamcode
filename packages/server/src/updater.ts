import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync as nodeChmodSync,
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  isStableVersion,
  readActiveVersion,
  readPreviousVersion,
  resolveInstallRoot,
  type ManagedInstallStatus,
} from "./managed-runtime.js";

declare global {
  /** Stable package version injected by tsup. Source/test builds fall back to package.json. */
  const __SERVER_VERSION__: string | undefined;
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(nodeReadFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "dev";
  } catch {
    return "dev";
  }
}

export const RUNNING_VERSION =
  typeof __SERVER_VERSION__ === "string" && __SERVER_VERSION__
    ? __SERVER_VERSION__.replace(/^v/, "")
    : packageVersion();
/** One-release compatibility export for diagnostics/tests that used the old SHA name. */
export const RUNNING_BUILD = RUNNING_VERSION;

export const RELEASES_API = "https://api.github.com/repos/burakgon/roamcode/releases?per_page=100";
export const RELEASE_MANIFEST_ASSET = "roamcode-release.json";
export const CHECK_CACHE_MS = 15 * 60_000;
export const FAILED_CHECK_TTL_MS = 30_000;
export const FETCH_TIMEOUT_MS = 20_000;
export const UPDATE_STALE_MS = 30 * 60_000;
export interface UpdaterFs {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, data: string, mode?: number) => void;
  mkdirSync: (path: string) => void;
  chmodSync: (path: string, mode: number) => void;
  renameSync?: (from: string, to: string) => void;
}

export const defaultUpdaterFs: UpdaterFs = {
  existsSync: nodeExistsSync,
  readFileSync: (path) => nodeReadFileSync(path, "utf8"),
  writeFileSync: (path, data, mode) => nodeWriteFileSync(path, data, mode === undefined ? undefined : { mode }),
  mkdirSync: (path) => nodeMkdirSync(path, { recursive: true, mode: 0o700 }),
  chmodSync: nodeChmodSync,
  renameSync: nodeRenameSync,
};

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string;
  body?: string;
  published_at?: string;
  draft: boolean;
  prerelease: boolean;
  assets?: GitHubReleaseAsset[];
}

export interface ReleaseRecord {
  version: string;
  tag: string;
  name: string;
  body: string;
  publishedAt: string;
  manifestUrl?: string;
}

export interface ReleaseFetchResult {
  releases?: GitHubRelease[];
  etag?: string;
  notModified?: boolean;
}

export type FetchReleases = (etag?: string) => Promise<ReleaseFetchResult>;
export type FetchManifest = (url: string) => Promise<unknown>;

export interface ChangelogEntry {
  id: string;
  version: string;
  subject: string;
  group: "new" | "fixes" | "improvements" | "other";
  when: string;
  date: string;
}

export type UpdateAction = "none" | "migrate" | "update" | "restart";
export type InstallationKind = "managed" | "legacy-git" | "unmanaged";

export interface VersionInfo {
  current: string;
  latest: string;
  /** Compatibility alias: number of stable releases behind, never commit count. */
  behind: number;
  releaseCount: number;
  updatable: boolean;
  updateAvailable: boolean;
  updateAction: UpdateAction;
  installation: InstallationKind;
  rollbackAvailable: boolean;
  changelog: ChangelogEntry[];
  runningVersion: string;
  activeVersion?: string;
  installDrift: boolean;
  checkStatus: "fresh" | "stale" | "error";
  checkedAt?: number;
  error?: string;
  /** Deprecated aliases retained until old precached clients have crossed the v1 bridge. */
  runningBuild: string;
  buildDrift: boolean;
}

export type UpdateState = ManagedInstallStatus["state"] | "idle";
export interface UpdateStatus {
  operationId?: string;
  state: UpdateState;
  phase?: string;
  target?: string;
  fromVersion?: string;
  error?: string;
  log?: string;
  updatedAt?: number;
}

export interface UpdaterDeps {
  fs?: UpdaterFs;
  spawn?: typeof nodeSpawn;
  now?: () => number;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  helperPath?: string;
  fetchReleases?: FetchReleases;
  fetchManifest?: FetchManifest;
  runningVersion?: string;
}

export function normalizeRelease(raw: GitHubRelease): ReleaseRecord | undefined {
  if (raw.draft || raw.prerelease) return undefined;
  const version = raw.tag_name.trim().replace(/^v/, "");
  if (!isStableVersion(version)) return undefined;
  const manifestUrl = raw.assets?.find((asset) => asset.name === RELEASE_MANIFEST_ASSET)?.browser_download_url;
  return {
    version,
    tag: `v${version}`,
    name: raw.name?.trim() || `v${version}`,
    body: raw.body ?? "",
    publishedAt: raw.published_at ?? "",
    ...(manifestUrl ? { manifestUrl } : {}),
  };
}

export function stableReleases(raw: GitHubRelease[]): ReleaseRecord[] {
  return raw
    .map(normalizeRelease)
    .filter((release): release is ReleaseRecord => release !== undefined)
    .sort((a, b) => compareVersions(b.version, a.version));
}

export function relativeWhen(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const days = Math.max(0, Math.floor((now - then) / 86_400_000));
  if (days === 0) return "now";
  if (days < 7) return `${days}d`;
  if (days < 35) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function groupForHeading(heading: string): ChangelogEntry["group"] {
  const normalized = heading.toLowerCase();
  if (/new|added|feature/.test(normalized)) return "new";
  if (/fix|security/.test(normalized)) return "fixes";
  if (/improvement|changed|performance/.test(normalized)) return "improvements";
  return "other";
}

export function parseReleaseNotes(release: ReleaseRecord, now: number): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let group: ChangelogEntry["group"] = "improvements";
  for (const rawLine of release.body.split("\n")) {
    const heading = /^#{2,4}\s+(.+)$/.exec(rawLine.trim());
    if (heading?.[1]) {
      group = groupForHeading(heading[1]);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(rawLine.trim());
    if (!bullet?.[1]) continue;
    const subject = bullet[1].replace(/\s+by\s+@\S+\s+in\s+https?:\/\/\S+$/i, "").trim();
    if (!subject) continue;
    entries.push({
      id: `${release.version}:${entries.length}`,
      version: release.version,
      subject,
      group,
      when: relativeWhen(release.publishedAt, now),
      date: release.publishedAt,
    });
  }
  return entries;
}

export function computeInstallDrift(runningVersion: string, activeVersion: string | undefined): boolean {
  if (!activeVersion || !isStableVersion(runningVersion)) return false;
  return runningVersion !== activeVersion;
}
/** Deprecated name retained as a version comparison alias. */
export const computeBuildDrift = (running: string, active: string): boolean => computeInstallDrift(running, active);

export async function defaultFetchReleases(etag?: string): Promise<ReleaseFetchResult> {
  const response = await fetch(RELEASES_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "roamcode-updater",
      ...(etag ? { "if-none-match": etag } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 304) return { notModified: true, etag };
  if (!response.ok) throw new Error(`GitHub Releases returned ${response.status}`);
  const releases = (await response.json()) as GitHubRelease[];
  return { releases, etag: response.headers.get("etag") ?? undefined };
}

export async function defaultFetchManifest(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/octet-stream", "user-agent": "roamcode-updater" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`release manifest returned ${response.status}`);
  return response.json();
}

function manifestIntegrities(value: unknown, version: string): Record<string, string> {
  if (!value || typeof value !== "object") throw new Error("release manifest is invalid");
  const manifest = value as { version?: unknown; packages?: Record<string, { integrity?: unknown }> };
  if (manifest.version !== version) throw new Error("release manifest version does not match its tag");
  const integrities: Record<string, string> = {};
  for (const packageName of ["roamcode", "@roamcode/server", "@roamcode/web"]) {
    const integrity = manifest.packages?.[packageName]?.integrity;
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      throw new Error(`release manifest has no ${packageName} npm integrity`);
    }
    integrities[packageName] = integrity;
  }
  return integrities;
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export class Updater {
  private readonly fs: UpdaterFs;
  private readonly spawn: typeof nodeSpawn;
  private readonly now: () => number;
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly repoRoot: string;
  private readonly helperPath: string;
  private readonly fetchReleases: FetchReleases;
  private readonly fetchManifest: FetchManifest;
  private readonly runningVersion: string;
  private cache?: { at: number; releases: ReleaseRecord[]; etag?: string; failed?: boolean; error?: string };
  private inFlight = false;

  constructor(deps: UpdaterDeps) {
    this.fs = deps.fs ?? defaultUpdaterFs;
    this.spawn = deps.spawn ?? nodeSpawn;
    this.now = deps.now ?? Date.now;
    this.dataDir = deps.dataDir;
    this.env = deps.env ?? process.env;
    this.repoRoot = deps.repoRoot ?? join(moduleDir(), "..", "..", "..");
    this.helperPath = deps.helperPath ?? join(moduleDir(), "managed-update-helper.js");
    this.fetchReleases = deps.fetchReleases ?? defaultFetchReleases;
    this.fetchManifest = deps.fetchManifest ?? defaultFetchManifest;
    this.runningVersion = (deps.runningVersion ?? RUNNING_VERSION).replace(/^v/, "");
    this.loadPersistedReleaseCache();
    this.finalizeRestartIfHealthy();
  }

  private installRoot(): string {
    return resolveInstallRoot(this.env);
  }

  private installation(activeVersion: string | undefined): InstallationKind {
    if (activeVersion) return "managed";
    return this.fs.existsSync(join(this.repoRoot, ".git")) ? "legacy-git" : "unmanaged";
  }

  private hasRestartableService(): boolean {
    try {
      const value = JSON.parse(this.fs.readFileSync(join(this.dataDir, "service.json"))) as {
        manager?: unknown;
        label?: unknown;
      };
      return (
        (value.manager === "launchd" || value.manager === "systemd") &&
        typeof value.label === "string" &&
        value.label.length > 0
      );
    } catch {
      return false;
    }
  }

  private cachePath(): string {
    return join(this.dataDir, "release-cache.json");
  }

  private loadPersistedReleaseCache(): void {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.cachePath())) as {
        at?: unknown;
        releases?: ReleaseRecord[];
        etag?: unknown;
      };
      if (typeof parsed.at === "number" && Array.isArray(parsed.releases)) {
        this.cache = {
          at: parsed.at,
          releases: parsed.releases.filter((release) => isStableVersion(release.version)),
          ...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}),
        };
      }
    } catch {
      // no last-known release feed yet
    }
  }

  private persistReleaseCache(): void {
    if (!this.cache || this.cache.failed) return;
    this.fs.mkdirSync(this.dataDir);
    this.fs.writeFileSync(
      this.cachePath(),
      JSON.stringify({ at: this.cache.at, etag: this.cache.etag, releases: this.cache.releases }, null, 2) + "\n",
      0o600,
    );
  }

  private async refresh(force: boolean): Promise<void> {
    const ttl = this.cache?.failed ? FAILED_CHECK_TTL_MS : CHECK_CACHE_MS;
    if (!force && this.cache && this.now() - this.cache.at < ttl) return;
    try {
      const result = await this.fetchReleases(this.cache?.etag);
      if (result.notModified && this.cache) {
        this.cache = { ...this.cache, at: this.now(), failed: false, error: undefined };
      } else {
        this.cache = {
          at: this.now(),
          releases: stableReleases(result.releases ?? []),
          ...(result.etag ? { etag: result.etag } : {}),
        };
      }
      this.persistReleaseCache();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.cache?.releases.length) this.cache = { ...this.cache, failed: true, error: message };
      else this.cache = { at: this.now(), releases: [], failed: true, error: message };
    }
  }

  async getVersion(force = false): Promise<VersionInfo> {
    await this.refresh(force);
    const activeVersion = readActiveVersion(this.installRoot());
    const installation = this.installation(activeVersion);
    const currentVersion = isStableVersion(this.runningVersion) ? this.runningVersion : activeVersion;
    const latestRelease = this.cache?.releases[0];
    const latestVersion = latestRelease?.version ?? currentVersion ?? "dev";
    const newer =
      currentVersion && isStableVersion(currentVersion) && isStableVersion(latestVersion)
        ? (this.cache?.releases ?? []).filter((release) => compareVersions(release.version, currentVersion) > 0)
        : latestRelease
          ? [latestRelease]
          : [];
    const installDrift = computeInstallDrift(this.runningVersion, activeVersion);
    let updateAction: UpdateAction = "none";
    if (installDrift) updateAction = "restart";
    else if (newer.length > 0) updateAction = "update";
    else if (installation === "legacy-git" && latestRelease && currentVersion === latestVersion)
      updateAction = "migrate";
    // A foreground process cannot safely replace/restart itself. Both the v0 checkout installer and the
    // managed installer persist service.json, so require that explicit supervisor contract before OTA.
    const updatable = installation !== "unmanaged" && this.hasRestartableService();
    const changelog = newer.flatMap((release) => parseReleaseNotes(release, this.now()));
    const checkStatus = this.cache?.failed ? (this.cache.releases.length ? "stale" : "error") : "fresh";
    return {
      current: currentVersion && isStableVersion(currentVersion) ? `v${currentVersion}` : (currentVersion ?? "dev"),
      latest: isStableVersion(latestVersion) ? `v${latestVersion}` : latestVersion,
      behind: newer.length,
      releaseCount: newer.length,
      updatable,
      updateAvailable: updatable && updateAction !== "none",
      updateAction,
      installation,
      rollbackAvailable: readPreviousVersion(this.installRoot()) !== undefined,
      changelog,
      runningVersion: this.runningVersion,
      ...(activeVersion ? { activeVersion } : {}),
      installDrift,
      checkStatus,
      ...(this.cache ? { checkedAt: this.cache.at } : {}),
      ...(this.cache?.error ? { error: this.cache.error } : {}),
      runningBuild: this.runningVersion,
      buildDrift: installDrift,
    };
  }

  readStatus(): UpdateStatus {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(join(this.dataDir, "update-status.json"))) as UpdateStatus;
      return parsed && typeof parsed.state === "string" ? parsed : { state: "idle" };
    } catch {
      return { state: "idle" };
    }
  }

  private writeStatus(status: ManagedInstallStatus): void {
    this.fs.mkdirSync(this.dataDir);
    const path = join(this.dataDir, "update-status.json");
    const value = JSON.stringify(status, null, 2) + "\n";
    if (this.fs.renameSync) {
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      this.fs.writeFileSync(temp, value, 0o600);
      this.fs.renameSync(temp, path);
    } else {
      this.fs.writeFileSync(path, value, 0o600);
    }
    this.fs.chmodSync(path, 0o600);
  }

  readLastGoodVersion(): string | undefined {
    return readPreviousVersion(this.installRoot());
  }

  /** Deprecated compatibility method: rollback is now version/pointer based. */
  readLastGoodSha(): string | undefined {
    return this.readLastGoodVersion();
  }

  private updateIsRunning(): boolean {
    const status = this.readStatus();
    if (status.state === "idle" || status.state === "done" || status.state === "failed") return false;
    return this.now() - (status.updatedAt ?? 0) < UPDATE_STALE_MS;
  }

  private finalizeRestartIfHealthy(): void {
    const status = this.readStatus();
    if (status.state !== "restarting" || !status.target || !status.operationId) return;
    const active = readActiveVersion(this.installRoot());
    if (active !== status.target || this.runningVersion !== status.target) return;
    this.writeStatus({
      operationId: status.operationId,
      state: "done",
      phase: "done",
      target: status.target,
      ...(status.fromVersion ? { fromVersion: status.fromVersion } : {}),
      updatedAt: this.now(),
    });
  }

  async startUpdate(opts: { targetVersion?: string; rollback?: boolean } = {}): Promise<{
    started: boolean;
    reason?: string;
    operationId?: string;
    target?: string;
  }> {
    if (this.inFlight && !this.updateIsRunning()) this.inFlight = false;
    if (this.inFlight || this.updateIsRunning()) return { started: false, reason: "an update is already in progress" };
    const versionInfo = await this.getVersion(true);
    if (!versionInfo.updatable) return { started: false, reason: "run 'roamcode install' to enable managed OTA" };

    let target: string;
    let integrities: Record<string, string> | undefined;
    if (opts.rollback) {
      const previous = this.readLastGoodVersion();
      if (!previous) return { started: false, reason: "no previous managed version is available" };
      target = previous;
    } else {
      target = (opts.targetVersion ?? versionInfo.latest).replace(/^v/, "");
      if (!isStableVersion(target)) return { started: false, reason: "invalid target version" };
      if (isStableVersion(this.runningVersion) && compareVersions(target, this.runningVersion) < 0) {
        return { started: false, reason: "use the rollback action to activate an older version" };
      }
      if (target === this.runningVersion && versionInfo.updateAction === "none") {
        return { started: false, reason: `v${target} is already active` };
      }
      const release = this.cache?.releases.find((candidate) => candidate.version === target);
      if (!release) return { started: false, reason: `v${target} is not a published stable GitHub Release` };
      if (!release.manifestUrl) return { started: false, reason: `v${target} is missing ${RELEASE_MANIFEST_ASSET}` };
      try {
        integrities = manifestIntegrities(await this.fetchManifest(release.manifestUrl), target);
      } catch (error) {
        return { started: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }

    const operationId = randomUUID();
    const status: ManagedInstallStatus = {
      operationId,
      state: "starting",
      phase: opts.rollback
        ? "preparing rollback"
        : versionInfo.updateAction === "migrate"
          ? "preparing migration"
          : "starting",
      target,
      ...(isStableVersion(this.runningVersion) ? { fromVersion: this.runningVersion } : {}),
      updatedAt: this.now(),
    };
    this.writeStatus(status);
    this.inFlight = true;
    try {
      const configPath = join(this.dataDir, `update-${operationId}.json`);
      this.fs.mkdirSync(this.dataDir);
      this.fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            operationId,
            version: target,
            installRoot: this.installRoot(),
            dataDir: this.dataDir,
            nodePath: process.execPath,
            ...(integrities ? { expectedIntegrities: integrities } : {}),
            restart: true,
          },
          null,
          2,
        ) + "\n",
        0o600,
      );
      const child = this.spawn(process.execPath, [this.helperPath, configPath], {
        detached: true,
        stdio: "ignore",
        env: { ...this.env, ROAMCODE_INSTALL_ROOT: this.installRoot() },
      });
      child.on("error", (error: Error) => {
        this.inFlight = false;
        this.writeStatus({
          ...status,
          state: "failed",
          phase: "starting",
          error: error.message,
          updatedAt: this.now(),
        });
      });
      child.unref();
      return { started: true, operationId, target };
    } catch (error) {
      this.inFlight = false;
      const message = error instanceof Error ? error.message : String(error);
      this.writeStatus({ ...status, state: "failed", phase: "starting", error: message, updatedAt: this.now() });
      return { started: false, reason: message };
    }
  }
}

export function createUpdater(opts: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  runningVersion?: string;
}): Updater {
  return new Updater({
    dataDir: opts.dataDir,
    env: opts.env,
    repoRoot: opts.repoRoot,
    runningVersion: opts.runningVersion,
  });
}
