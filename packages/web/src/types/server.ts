// Client-side mirror of the server's REST contract types (SessionMeta, VersionInfo, UsageInfo,
// ClaudeAuthStatus, DirListing, …). Kept as a standalone type module so the browser bundle never
// imports the Node server package.

/** One selectable model the account offers (mirror of the server's ModelOption, from the init handshake). */
export interface ModelOption {
  value: string;
  displayName: string;
  description?: string;
  supportedEffortLevels?: string[];
}

export interface SessionMeta {
  id: string;
  cwd: string;
  model?: string;
  /** The account's available models (from the live session's init handshake) — drives a real model picker
   *  instead of free-text. Absent on cold/old sessions; the client falls back to a curated static list. */
  availableModels?: ModelOption[];
  effort?: string;
  dangerouslySkip: boolean;
  status: "running" | "dormant" | "errored" | "stopped";
  createdAt: number;
  /** The `claude` CLI version this session is running on (e.g. "2.1.187"), captured at spawn. Absent on
   *  dormant/old sessions. Shown compactly in Settings; compared to /claude/version's `latest` for the
   *  subtle "update available" hint. */
  claudeVersion?: string;
  permissionMode?: string;
  /**
   * Server truth: a permission OR question is pending for this session — TRUE even for sessions the
   * client is NOT actively connected to (the meta carries it). Drives the rail's "needs you" row
   * indicator + the global badge, so attention is visible from anywhere. Optional so older payloads
   * (and test fixtures) default to "not awaiting".
   */
  awaiting?: boolean;
  /**
   * Server truth (ms): bumped on user-send AND on assistant/result, monotonic. The rail orders by
   * this (most-recent-first); a missing value falls back to `createdAt`. Optional so older payloads /
   * fixtures degrade gracefully.
   */
  lastActivityAt?: number;
  /** Session kind — always "terminal" (a PTY-backed claude TUI over the binary terminal WebSocket).
   *  Optional so older payloads / fixtures degrade gracefully. */
  mode?: "terminal";
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  gitBranch?: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

/**
 * OTA self-update (server-side mirror: packages/server/src/updater.ts). GET /version reports whether a
 * newer version is on origin/main and a grouped changelog of the behind commits; POST /update spawns
 * the detached pull+build+restart; GET /update/status reports the updater's progress.
 */
export interface ChangelogEntry {
  sha: string;
  subject: string;
  group: "new" | "fixes" | "improvements" | "other";
  when: string;
  date: string;
}

export interface VersionInfo {
  current: string;
  latest: string;
  behind: number;
  /** False when the server isn't a git checkout / has the wrong remote — hides the whole feature. */
  updatable: boolean;
  updateAvailable: boolean;
  changelog: ChangelogEntry[];
  /** True when the server can spawn PTY-backed terminal sessions (the `terminal` mode feature). Gates
   * the wizard's Chat/Terminal toggle. Absent (older servers) is treated as unavailable. */
  terminalAvailable?: boolean;
}

export type UpdateState =
  "idle" | "starting" | "pulling" | "installing" | "building" | "restarting" | "done" | "failed";

export interface UpdateStatus {
  state: UpdateState;
  phase?: string;
  error?: string;
  target?: string;
  log?: string;
  updatedAt?: number;
}

/**
 * Claude usage limits (server-side mirror: packages/server/src/usage-service.ts). GET /usage reports the
 * 5-hour SESSION limit + the WEEKLY limit (all models) + an optional Sonnet-only weekly limit, each a
 * percent-used and a human reset string. `usage` is null when the feature is unavailable (claude not
 * logged in / not installed / parse failed) — the UI then hides the bars.
 */
export interface UsageBar {
  /** Percent of the limit used (0–100). */
  percent: number;
  /** Human reset string, e.g. "Jun 25 at 11:30pm (Europe/Istanbul)". The UI may shorten it. */
  resets: string;
}

export interface UsageInfo {
  /** The rolling 5-hour session limit. */
  session?: UsageBar;
  /** The weekly limit across all models. */
  week?: UsageBar;
  /** The Sonnet-only weekly limit (optional; not always present). */
  weekSonnet?: UsageBar;
  /** Server clock (ms) when the snapshot was parsed. */
  fetchedAt: number;
}

/** One selectable model from GET /models (server-normalized from the CLI init response). */
export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
}

/** GET /auth/status — the server-side Claude sign-in state. `available:false` means the feature is off
 *  (no claude bin / a test server). `loggedIn` reflects stored creds existing (NOT that they still work —
 *  expired creds report loggedIn:true yet 401 on use, so the UI always offers re-authentication). */
export interface ClaudeAuthStatus {
  available: boolean;
  loggedIn?: boolean;
  email?: string;
  subscriptionType?: string;
  authMethod?: string;
  orgName?: string;
}
