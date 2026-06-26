import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import {
  chmodSync as nodeChmodSync,
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";

/**
 * In-app OTA self-update for a self-hosted git checkout (macOS launchd / Linux systemd).
 *
 * Version model = automatic date-version + commit changelog from LOCAL git (no GitHub API, no manual
 * releases). On open the app calls GET /version → this module runs `git fetch` (cached ~2min) and
 * compares HEAD↔origin/main; if behind it returns a changelog. "Update now" → POST /update spawns a
 * DETACHED updater script that pulls + builds + restarts the service, writing a status file the app
 * polls; the app reconnects to the new version.
 *
 * ALL git is run through an INJECTABLE `runGit` (mirroring the codebase's injectable-deps style) so the
 * check/changelog/version logic is unit-testable against FIXTURE git output with no real repo mutation.
 */

/** The official repo this updater will pull from — the detached script refuses any other origin. */
export const EXPECTED_REMOTE_SUBSTRING = "github.com/burakgon/remote-coder";

/** Cache TTL for the `git fetch` + behind-count check. The app polls /version on open + ~every 3m;
 * this guards against hammering the network — a check inside this window reuses the last result. Kept
 * short (2m) so a freshly pushed update is detected promptly instead of lingering behind a stale cache. */
export const CHECK_CACHE_MS = 2 * 60 * 1000;

/** A FAILED check (e.g. an offline `git fetch`) is cached only briefly so it retries soon after the
 *  network is back, instead of pinning a false "up to date" for the full CHECK_CACHE_MS. */
export const FAILED_CHECK_TTL_MS = 15_000;

/** Hard timeout for the network `git fetch` so a hung remote never blocks the /version response. */
export const FETCH_TIMEOUT_MS = 20_000;

export interface RunGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Inject a git runner: given args (+ optional cwd/timeout) it resolves to {stdout,stderr,code}.
 * NEVER rejects on a non-zero exit — it resolves with the exit code so callers branch on `code`. */
export type RunGit = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunGitResult>;

/** Minimal fs surface the updater needs — injectable so tests use an in-memory/temp double. */
export interface UpdaterFs {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, data: string, mode?: number) => void;
  mkdirSync: (path: string) => void;
  chmodSync: (path: string, mode: number) => void;
}

export interface UpdaterDeps {
  runGit: RunGit;
  fs: UpdaterFs;
  /** Spawn the detached updater script. Mirrors child_process.spawn's shape we use. */
  spawn: typeof nodeSpawn;
  /** Clock seam so the cache TTL is testable. */
  now: () => number;
  /** Data dir the status file + update.log + updater script live in. */
  dataDir: string;
  /** Repo root (the git checkout). When omitted, derived from import.meta.url at construction. */
  repoRoot?: string;
  /** The env the service-restart resolution reads REMOTE_CODER_SERVICE_LABEL / _MANAGER from. */
  env?: NodeJS.ProcessEnv;
  /** Platform override (tests exercise both restart branches). Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/** A grouped, human-facing changelog entry parsed from a conventional-commit subject. */
export interface ChangelogEntry {
  /** Short sha (for traceability / keys). */
  sha: string;
  /** The commit subject with its conventional-commit prefix stripped. */
  subject: string;
  /** Group bucket the prefix maps to. */
  group: "new" | "fixes" | "improvements" | "other";
  /** Relative time label (e.g. "2d") for the commit date. */
  when: string;
  /** ISO commit date (for sorting / "latest"). */
  date: string;
}

export interface VersionInfo {
  /** Current version label, e.g. `v2026.06.25 · a1b2c3d`. */
  current: string;
  /** Latest available label (the newest origin/main commit), or the current label when up to date. */
  latest: string;
  /** Commits HEAD is behind origin/main. 0 when up to date. */
  behind: number;
  /** Whether the feature is even available (a git checkout with the expected remote). */
  updatable: boolean;
  /** behind > 0 && updatable. */
  updateAvailable: boolean;
  /** Grouped changelog of the behind commits (empty when up to date / not updatable). */
  changelog: ChangelogEntry[];
}

export type UpdateState =
  | "idle"
  | "starting"
  | "pulling"
  | "installing"
  | "building"
  | "restarting"
  | "done"
  | "failed";

export interface UpdateStatus {
  state: UpdateState;
  /** A short human phase label (mirrors state, sometimes more specific). */
  phase?: string;
  /** Set when state === "failed": the last error/log lines. */
  error?: string;
  /** The target version label written on success. */
  target?: string;
  /** Last few log lines (tail) for surfacing progress/failure in the UI. */
  log?: string;
  /** Epoch ms the status was last written (for staleness). */
  updatedAt?: number;
}

const STATUS_FILE = "update-status.json";
const LOG_FILE = "update.log";
const SCRIPT_FILE = "rc-update.sh";

/** The real runGit: spawn `git` and collect stdout/stderr, resolving (never rejecting) with the code. */
export const defaultRunGit: RunGit = (args, opts = {}) =>
  new Promise<RunGitResult>((resolve) => {
    const child = nodeSpawn("git", args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code });
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          finish(124); // 124 = timeout, matching coreutils `timeout`
        }, opts.timeoutMs)
      : undefined;
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      finish(127); // 127 = command not found / spawn error
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      finish(code ?? 0);
    });
  });

/** The real fs adapter over node:fs. */
export const defaultUpdaterFs: UpdaterFs = {
  existsSync: (p) => nodeExistsSync(p),
  readFileSync: (p) => nodeReadFileSync(p, "utf8"),
  writeFileSync: (p, data, mode) => nodeWriteFileSync(p, data, mode !== undefined ? { mode } : undefined),
  mkdirSync: (p) => nodeMkdirSync(p, { recursive: true, mode: 0o700 }),
  chmodSync: (p, mode) => nodeChmodSync(p, mode),
};

/** Derive the repo root by walking up from this module's directory (mirrors start.ts's import.meta.url
 * pattern). The actual root is resolved at runtime via `git rev-parse --show-toplevel`; this is only
 * the cwd we run that from. */
function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Map a conventional-commit prefix to a changelog group. feat → new; fix → fixes; perf/refactor →
 * improvements; chore/docs/test/ci/build/style → other (hidden by default). An unknown/absent prefix
 * is grouped as "improvements" (a real change worth showing) unless it's clearly noise.
 */
export function groupForPrefix(prefix: string | undefined): ChangelogEntry["group"] {
  switch (prefix) {
    case "feat":
      return "new";
    case "fix":
      return "fixes";
    case "perf":
    case "refactor":
      return "improvements";
    case "chore":
    case "docs":
    case "test":
    case "ci":
    case "build":
    case "style":
      return "other";
    default:
      return "improvements";
  }
}

/**
 * Parse a conventional-commit subject like `feat(server): add OTA` → {prefix:"feat", subject:"add OTA"}.
 * Strips an optional `(scope)` and a trailing `!` (breaking-change marker). Returns the original
 * subject (and no prefix) when it doesn't match the conventional shape.
 */
export function parseConventionalSubject(raw: string): { prefix?: string; subject: string } {
  const m = /^([a-z]+)(?:\([^)]*\))?(!)?:\s*(.+)$/i.exec(raw.trim());
  if (!m) return { subject: raw.trim() };
  return { prefix: m[1]!.toLowerCase(), subject: m[3]!.trim() };
}

/** Separator used in the `git log` format so subject/sha/date never collide with commit text. */
const LOG_SEP = "\x1f"; // ASCII unit separator (never appears in commit text)
const LOG_FORMAT = `%h${LOG_SEP}%cI${LOG_SEP}%s`;

/**
 * Parse `git log HEAD..origin/main --format=%h<US>%cI<US>%s` output into grouped changelog entries.
 * Each line is `<shortSha><US><isoDate><US><subject>`. Lines that don't split into 3 parts are skipped.
 * "Other"/noise commits (chore/docs/test/ci/build/style) are EXCLUDED from the returned changelog
 * (folded/hidden per the plan), so the UI shows only New / Fixes / Improvements.
 */
export function parseChangelog(logOutput: string, now: number): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  for (const line of logOutput.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(LOG_SEP);
    if (parts.length < 3) continue;
    const sha = parts[0]!.trim();
    const date = parts[1]!.trim();
    const rawSubject = parts.slice(2).join(LOG_SEP).trim();
    const { prefix, subject } = parseConventionalSubject(rawSubject);
    const group = groupForPrefix(prefix);
    if (group === "other") continue; // hidden noise
    const when = relativeWhen(date, now);
    out.push({ sha, subject, group, when, date });
  }
  return out;
}

/** Compact relative-time label from an ISO date to `now` (e.g. `now`, `3m`, `2h`, `5d`). Pure. */
export function relativeWhen(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const deltaMs = now - then;
  if (deltaMs < 0) return "now";
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(day / 365)}y`;
}

/** Build the `v<YYYY.MM.DD> · <sha>` label from an ISO commit date + short sha. */
export function versionLabel(iso: string, sha: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return sha ? `· ${sha}` : "unknown";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `v${yyyy}.${mm}.${dd} · ${sha}`;
}

/**
 * The Updater orchestrates the version check + spawning the detached self-update. All git goes through
 * the injected `runGit`; all fs through the injected `fs`. Construct with `createUpdater(deps)`.
 */
export class Updater {
  private readonly deps: Required<Pick<UpdaterDeps, "runGit" | "fs" | "spawn" | "now" | "dataDir">> & {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  };
  private repoRoot: string;
  private cache?: { at: number; info: VersionInfo; failed?: boolean };
  /** Guards against a second POST /update spawning a concurrent pull/build/restart on the same repo.
   *  Stays true once an update launches (the process restarts soon); reset only if the launch fails. */
  private updateInFlight = false;
  /** Memoized "is this a git checkout with the right remote" — repoRoot resolution is one-time. */
  private rootResolved = false;

  constructor(deps: UpdaterDeps) {
    this.deps = {
      runGit: deps.runGit,
      fs: deps.fs,
      spawn: deps.spawn,
      now: deps.now,
      dataDir: deps.dataDir,
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
    };
    this.repoRoot = deps.repoRoot ?? moduleDir();
  }

  /** Resolve the real repo root via `git rev-parse --show-toplevel`. Sets `updatable:false` when the
   * server isn't running from a git checkout (the toplevel command fails). Idempotent + memoized. */
  private async resolveRoot(): Promise<string | undefined> {
    if (this.rootResolved) return this.repoRoot || undefined;
    const res = await this.deps.runGit(["rev-parse", "--show-toplevel"], { cwd: this.repoRoot });
    if (res.code !== 0) {
      // Memoize ONLY a successful resolution — a TRANSIENT failure (git momentarily unavailable / a 127
      // "git not found" blip) must not pin updatable:false for the whole process lifetime. Re-resolve
      // on the next check instead.
      return undefined;
    }
    this.rootResolved = true;
    this.repoRoot = res.stdout.trim();
    return this.repoRoot || undefined;
  }

  /** Whether the configured remote points at the expected repo (the pull guard, also surfaced so the
   * UI can disable updates if someone forked the checkout). */
  private async hasExpectedRemote(root: string): Promise<boolean> {
    const res = await this.deps.runGit(["config", "--get", "remote.origin.url"], { cwd: root });
    if (res.code !== 0) return false;
    return res.stdout.trim().includes(EXPECTED_REMOTE_SUBSTRING);
  }

  /**
   * The cached version check. Resolves repoRoot, verifies the remote, runs `git fetch origin main`
   * (timeout-guarded), counts `HEAD..origin/main`, and builds the grouped changelog. Reuses the last
   * result within CHECK_CACHE_MS. A non-git checkout / wrong remote → updatable:false (feature off).
   */
  async getVersion(force = false): Promise<VersionInfo> {
    const now = this.deps.now();
    const ttl = this.cache?.failed ? FAILED_CHECK_TTL_MS : CHECK_CACHE_MS;
    if (!force && this.cache && now - this.cache.at < ttl) return this.cache.info;

    const root = await this.resolveRoot();
    if (!root) {
      // Not a git checkout — feature off.
      const info = notUpdatable();
      this.cache = { at: now, info };
      return info;
    }
    if (!(await this.hasExpectedRemote(root))) {
      // origin is not the official remote — feature off (the pull guard would refuse anyway).
      const info = notUpdatable();
      this.cache = { at: now, info };
      return info;
    }

    // Current version label from HEAD.
    const head = await this.deps.runGit(["rev-parse", "--short", "HEAD"], { cwd: root });
    const headDate = await this.deps.runGit(["log", "-1", "--format=%cI"], { cwd: root });
    const currentSha = head.stdout.trim();
    const current = versionLabel(headDate.stdout.trim(), currentSha);

    // Network: fetch origin/main (timeout-guarded). A fetch failure (offline) is non-fatal — we report
    // the current version as up to date rather than erroring the whole /version response.
    const fetched = await this.deps.runGit(["fetch", "origin", "main", "--quiet"], {
      cwd: root,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (fetched.code !== 0) {
      const info: VersionInfo = {
        current,
        latest: current,
        behind: 0,
        updatable: true,
        updateAvailable: false,
        changelog: [],
      };
      // Mark the cache as failed so it's only honored for FAILED_CHECK_TTL_MS — a transient offline
      // fetch retries within ~15s instead of pinning "up to date" for the full cache window.
      this.cache = { at: now, info, failed: true };
      return info;
    }

    const countRes = await this.deps.runGit(["rev-list", "--count", "HEAD..origin/main"], { cwd: root });
    const behind = Number.parseInt(countRes.stdout.trim(), 10) || 0;

    let changelog: ChangelogEntry[] = [];
    let latest = current;
    if (behind > 0) {
      const logRes = await this.deps.runGit(["log", "HEAD..origin/main", `--format=${LOG_FORMAT}`], { cwd: root });
      changelog = parseChangelog(logRes.stdout, now);
      // latest = the newest origin/main commit (date + sha). Read it explicitly so an all-"other"
      // changelog (every commit hidden) still reports an accurate latest label.
      const latestRes = await this.deps.runGit(["log", "-1", "origin/main", `--format=${LOG_SEP}%cI${LOG_SEP}%h`], {
        cwd: root,
      });
      const latestParts = latestRes.stdout.trim().split(LOG_SEP).filter(Boolean);
      if (latestParts.length >= 2) latest = versionLabel(latestParts[0]!, latestParts[1]!);
    }

    const info: VersionInfo = {
      current,
      latest,
      behind,
      updatable: true,
      updateAvailable: behind > 0,
      changelog,
    };
    this.cache = { at: now, info };
    return info;
  }

  /** Read the persisted update status file → UpdateStatus. Returns {state:"idle"} when none exists. */
  readStatus(): UpdateStatus {
    const path = join(this.deps.dataDir, STATUS_FILE);
    if (!this.deps.fs.existsSync(path)) return { state: "idle" };
    try {
      const parsed = JSON.parse(this.deps.fs.readFileSync(path)) as UpdateStatus;
      if (parsed && typeof parsed.state === "string") return parsed;
    } catch {
      // corrupt/half-written — treat as idle rather than crashing the status endpoint
    }
    return { state: "idle" };
  }

  /** Write the status file (0600 — it can contain a build-error log). */
  private writeStatus(status: UpdateStatus): void {
    const path = join(this.deps.dataDir, STATUS_FILE);
    this.deps.fs.mkdirSync(this.deps.dataDir);
    this.deps.fs.writeFileSync(path, JSON.stringify({ ...status, updatedAt: this.deps.now() }, null, 2), 0o600);
  }

  /**
   * Spawn the detached self-update. Guards: must be a git checkout with the official remote (else it
   * throws and the route 409s). Writes status {state:"starting"}, writes the updater .sh into the data
   * dir, and spawns it DETACHED ({detached:true, stdio:"ignore"}) + unref() so it survives THIS
   * process being restarted by the service. The script pulls + builds + restarts, writing the status
   * file + appending update.log at each step.
   */
  async startUpdate(): Promise<{ started: boolean; reason?: string }> {
    const root = await this.resolveRoot();
    if (!root) return { started: false, reason: "not a git checkout" };
    if (!(await this.hasExpectedRemote(root))) return { started: false, reason: "origin is not the official remote" };
    if (this.updateInFlight) return { started: false, reason: "an update is already in progress" };

    this.updateInFlight = true;
    this.writeStatus({ state: "starting", phase: "starting" });

    try {
      const scriptPath = join(this.deps.dataDir, SCRIPT_FILE);
      const statusPath = join(this.deps.dataDir, STATUS_FILE);
      const logPath = join(this.deps.dataDir, LOG_FILE);
      const restart = this.resolveServiceRestart();
      const script = renderUpdaterScript({
        repoRoot: root,
        statusPath,
        logPath,
        expectedRemote: EXPECTED_REMOTE_SUBSTRING,
        restartCommand: restart.command,
        parentPid: process.pid,
      });
      this.deps.fs.mkdirSync(this.deps.dataDir);
      this.deps.fs.writeFileSync(scriptPath, script, 0o700);
      this.deps.fs.chmodSync(scriptPath, 0o700);

      const child = this.deps.spawn("/bin/sh", [scriptPath], {
        detached: true,
        stdio: "ignore",
        cwd: root,
      });
      // A detached child's async spawn failure (e.g. ENOENT) emits a listener-less 'error' that would
      // otherwise crash the server — handle it: mark failed + clear the in-flight guard so a retry works.
      child.on("error", (err: Error) => {
        this.updateInFlight = false;
        this.writeStatus({ state: "failed", phase: "starting", error: `failed to launch updater: ${err.message}` });
      });
      child.unref();
      return { started: true };
    } catch (err) {
      // A synchronous spawn/write failure must not leave the status stuck on "starting" forever.
      this.updateInFlight = false;
      const message = (err as Error).message;
      this.writeStatus({ state: "failed", phase: "starting", error: message });
      return { started: false, reason: message };
    }
  }

  /**
   * Resolve how to restart the service after a successful build, cross-install:
   *   1. `<dataDir>/service.json` ({manager,label}) written by `remote-coder install`.
   *   2. env REMOTE_CODER_SERVICE_MANAGER / REMOTE_CODER_SERVICE_LABEL.
   *   3. platform default (macOS launchd com.remote-coder; Linux systemd remote-coder).
   * Returns the shell command the detached script runs; SIGTERM-parent fallback is in the script when
   * the command itself fails (the service supervisor then auto-restarts us).
   */
  resolveServiceRestart(): { manager: string; label: string; command: string } {
    let manager: string | undefined;
    let label: string | undefined;

    const servicePath = join(this.deps.dataDir, "service.json");
    if (this.deps.fs.existsSync(servicePath)) {
      try {
        const parsed = JSON.parse(this.deps.fs.readFileSync(servicePath)) as { manager?: string; label?: string };
        if (typeof parsed.manager === "string") manager = parsed.manager;
        if (typeof parsed.label === "string") label = parsed.label;
      } catch {
        // ignore a corrupt service.json — fall through to env/defaults
      }
    }
    manager = manager ?? this.deps.env.REMOTE_CODER_SERVICE_MANAGER ?? undefined;
    label = label ?? this.deps.env.REMOTE_CODER_SERVICE_LABEL ?? undefined;

    if (!manager) manager = this.deps.platform === "darwin" ? "launchd" : "systemd";
    if (!label) label = this.deps.platform === "darwin" ? "com.remote-coder" : "remote-coder";

    const command = renderRestartCommand(manager, label);
    return { manager, label, command };
  }
}

/** A VersionInfo for a non-updatable deploy (not a git checkout, or the wrong remote). */
function notUpdatable(): VersionInfo {
  return {
    current: "—",
    latest: "—",
    behind: 0,
    updatable: false,
    updateAvailable: false,
    changelog: [],
  };
}

/** Build the restart shell command for a (manager,label). */
export function renderRestartCommand(manager: string, label: string): string {
  // The label is interpolated into a command later run via `sh -c`, so reject anything outside a strict
  // service-label charset (operator-controlled via service.json / REMOTE_CODER_SERVICE_LABEL, but
  // unvalidated) — a label like `x"; rm -rf ~; "` would otherwise be command injection at restart.
  if (label && !/^[A-Za-z0-9._@-]+$/.test(label)) {
    throw new Error(`invalid service label (only A-Za-z0-9._@- allowed): ${label}`);
  }
  if (manager === "launchd") {
    // launchctl kickstart -k restarts the agent for the current GUI session.
    return `launchctl kickstart -k "gui/$(id -u)/${label}"`;
  }
  if (manager === "systemd") {
    return `systemctl --user restart "${label}"`;
  }
  // Unknown manager — no restart command; the script's SIGTERM-parent fallback covers it.
  return "";
}

export interface RenderUpdaterScriptOptions {
  repoRoot: string;
  statusPath: string;
  logPath: string;
  expectedRemote: string;
  restartCommand: string;
  parentPid: number;
}

/**
 * Render the detached updater shell script. Each step writes the status file (a small JSON blob) and
 * appends the log. On ANY failure it records `failed` with the tail of the log and does NOT restart
 * (the old server keeps running — nothing breaks). On success it restarts via `restartCommand`, and
 * if that command fails it falls back to SIGTERM-ing the parent (the service supervisor auto-restarts).
 *
 * The script is intentionally POSIX `sh` (no bashisms) so it runs under /bin/sh on macOS + Linux.
 */
export function renderUpdaterScript(opts: RenderUpdaterScriptOptions): string {
  const { repoRoot, statusPath, logPath, expectedRemote, restartCommand, parentPid } = opts;
  // Single-quote every interpolated value for the shell, escaping embedded single quotes.
  const q = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;

  // The script body is assembled line-by-line (NOT a template literal) so the many shell `$VAR` /
  // `$(...)` / `${3:-}` constructs aren't mistaken for JS interpolation. The only injected values are
  // the safely-quoted header assignments below.
  const header = [
    "#!/bin/sh",
    "# remote-coder OTA self-update — generated; pulls + builds + restarts the service.",
    "# Writes a JSON status file at each step and appends a log. On failure it does NOT restart.",
    "set -u",
    "",
    `REPO=${q(repoRoot)}`,
    `STATUS=${q(statusPath)}`,
    `LOG=${q(logPath)}`,
    `EXPECTED=${q(expectedRemote)}`,
    `RESTART_CMD=${q(restartCommand)}`,
    `PARENT_PID=${q(String(parentPid))}`,
    "",
  ];

  const body = [
    'cd "$REPO" || exit 1',
    "",
    `log() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG" 2>&1; }`,
    "",
    "# json_escape: escape backslashes, double-quotes, and newlines for a JSON string value.",
    "json_escape() {",
    `  printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' | tr '\\n' ' '`,
    "}",
    "",
    "write_status() {",
    "  # $1=state $2=phase $3=error(optional) $4=target(optional)",
    '  _state="$1"; _phase="$2"; _error="${3:-}"; _target="${4:-}"',
    '  _tail="$(tail -n 12 "$LOG" 2>/dev/null || true)"',
    '  _tail_esc="$(json_escape "$_tail")"',
    '  _error_esc="$(json_escape "$_error")"',
    "  {",
    "    printf '{'",
    `    printf '"state":"%s",' "$_state"`,
    `    printf '"phase":"%s",' "$_phase"`,
    `    [ -n "$_error" ] && printf '"error":"%s",' "$_error_esc"`,
    `    [ -n "$_target" ] && printf '"target":"%s",' "$_target"`,
    `    printf '"log":"%s",' "$_tail_esc"`,
    `    printf '"updatedAt":%s' "$(date +%s)000"`,
    "    printf '}'",
    '  } > "$STATUS"',
    "}",
    "",
    "fail() {",
    '  log "FAILED: $1"',
    '  write_status "failed" "$2" "$1"',
    "  exit 1",
    "}",
    "",
    "# Guard: the configured remote must be the official repo (RCE-by-design only on OUR repo).",
    'ORIGIN_URL="$(git config --get remote.origin.url 2>/dev/null || true)"',
    'case "$ORIGIN_URL" in',
    '  *"$EXPECTED"*) : ;;',
    '  *) fail "remote origin ($ORIGIN_URL) is not the expected repository; refusing to update" "pulling" ;;',
    "esac",
    "",
    "# 1. pulling",
    'log "pulling: git pull --ff-only origin main"',
    'write_status "pulling" "pulling"',
    'if ! git pull --ff-only origin main >> "$LOG" 2>&1; then',
    '  log "ff-only pull failed; falling back to fetch + reset --hard origin/main"',
    '  if ! git fetch origin main >> "$LOG" 2>&1; then fail "git fetch failed" "pulling"; fi',
    '  if ! git reset --hard origin/main >> "$LOG" 2>&1; then fail "git reset --hard failed" "pulling"; fi',
    "fi",
    "",
    'TARGET_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"',
    "",
    "# 2. installing",
    'log "installing: pnpm install --frozen-lockfile"',
    'write_status "installing" "installing"',
    'if ! pnpm install --frozen-lockfile >> "$LOG" 2>&1; then fail "pnpm install failed" "installing"; fi',
    "",
    "# 3. building",
    'log "building: pnpm -r build"',
    'write_status "building" "building"',
    'if ! pnpm -r build >> "$LOG" 2>&1; then fail "pnpm -r build failed" "building"; fi',
    "",
    "# 4. success → restart",
    'log "build succeeded at $TARGET_SHA; restarting service"',
    // Status stays "restarting" through the restart attempt — do NOT pre-write "done", or a restart that
    // never happens would be masked as success while the app hangs on the spinner (it ends "updating"
    // only when /version's `current` changes, which a confirmed restart produces). The new process boots
    // on the new SHA; if NO restart mechanism works we write "failed" so the UI can surface it.
    'write_status "restarting" "restarting" "" "$TARGET_SHA"',
    "",
    'if [ -n "$RESTART_CMD" ]; then',
    '  log "restart: $RESTART_CMD"',
    '  if sh -c "$RESTART_CMD" >> "$LOG" 2>&1; then',
    '    log "restart command issued"',
    "    exit 0",
    "  fi",
    '  log "restart command failed; falling back to SIGTERM parent ($PARENT_PID)"',
    "fi",
    "",
    "# Fallback: terminate the parent; its launchd/systemd supervisor (KeepAlive / Restart=always)",
    "# brings it back on the new code.",
    'if [ -n "$PARENT_PID" ]; then',
    '  log "sending SIGTERM to parent $PARENT_PID (supervisor will auto-restart)"',
    '  kill -TERM "$PARENT_PID" >> "$LOG" 2>&1 || true',
    "  exit 0",
    "fi",
    "",
    "# No restart command AND no parent to signal: nothing can restart us, so the new code will never run.",
    '# Report failure (instead of leaving "restarting") so the UI stops waiting on a version change.',
    'log "no restart mechanism available; reporting failed"',
    'write_status "failed" "built ok but could not restart the service automatically; restart it manually" "" "$TARGET_SHA"',
    "exit 1",
    "",
  ];

  return [...header, ...body].join("\n");
}

/** Construct an Updater with the real adapters (the production wiring). */
export function createUpdater(opts: { dataDir: string; env?: NodeJS.ProcessEnv; repoRoot?: string }): Updater {
  return new Updater({
    runGit: defaultRunGit,
    fs: defaultUpdaterFs,
    spawn: nodeSpawn,
    now: () => Date.now(),
    dataDir: opts.dataDir,
    env: opts.env,
    repoRoot: opts.repoRoot,
  });
}
