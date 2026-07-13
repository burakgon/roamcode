import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/**
 * Claude usage limits (the `/usage` slash command), surfaced in the session rail and settings:
 * the 5-hour SESSION limit, the all-model WEEKLY limit, and any provider-named weekly buckets.
 *
 * DATA SOURCE: the real `claude` CLI's `/usage` command returns the exact numbers. Invoked headlessly
 * as `claudeBin -p "/usage" --output-format json --dangerously-skip-permissions` (clean exit, ONE JSON
 * line). Its `.result` string carries the human-readable usage block we parse here, e.g.:
 *
 *   Current session: 12% used · resets Jun 25 at 11:30pm (Europe/Istanbul)
 *   Current week (all models): 72% used · resets Jun 25 at 10pm (Europe/Istanbul)
 *   Current week (Fable): 2% used · resets Jun 25 at 9:59pm (Europe/Istanbul)
 *
 * The spawn is the cost; a short TTL cache keeps it to ~once/3min regardless of how fast the rail
 * polls. A failed/empty fetch (claude missing / not logged in / parse fail) degrades GRACEFULLY to the
 * last good cached value, or null when there's none — the feature simply hides in the UI, never 500s.
 *
 * Deps are INJECTABLE (`runUsage` + `now`, mirroring the updater's style) so the parse + cache logic is
 * unit-testable against fixture text with no real spawn.
 */

/** A single usage bar: percent used (0–100) plus a reset string when the provider supplies one. */
export interface Bar {
  percent: number;
  /** Claude omits this while a window is still at 0%, so reset time is optional. */
  resets?: string;
}

export interface ModelWeekBar extends Bar {
  model: string;
}

/**
 * Parsed usage snapshot. `session` is the 5-hour limit; `week` is the all-models weekly limit;
 * `weekModels` contains provider-named weekly buckets. `weekSonnet` remains for older clients.
 */
export interface UsageInfo {
  session?: Bar;
  week?: Bar;
  /** Provider-named weekly buckets such as Fable or the legacy Sonnet-only limit. */
  weekModels?: ModelWeekBar[];
  /** Legacy compatibility for older clients; new code should prefer weekModels. */
  weekSonnet?: Bar;
  fetchedAt: number;
}

/** Resolve the raw `.result` string from `claude /usage`. NEVER rejects — resolves "" on any failure. */
export type RunUsage = () => Promise<string>;

export interface UsageServiceDeps {
  runUsage: RunUsage;
  /** Clock seam so the cache TTL is testable. */
  now: () => number;
  /** Cache TTL in ms (default USAGE_CACHE_MS). A getUsage within this window reuses the cache. */
  ttlMs?: number;
}

interface UsagePty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
  kill(signal?: string): void;
}

type UsagePtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
) => UsagePty;

/** Cache TTL for a parsed usage snapshot. The rail polls ~every 60s; this throttles the real spawn to
 * roughly once every few minutes regardless of poll rate. */
export const USAGE_CACHE_MS = 3 * 60 * 1000;

/** Hard timeout for the `claude /usage` spawn so a hung CLI never blocks the /usage response. */
export const USAGE_TIMEOUT_MS = 15_000;

/** Match one usage line (`<label>: NN% used [· resets <when>]`) into a Bar. Tolerant of spacing / the
 * middle `·` / `reset` vs `resets`, case-insensitive. Returns undefined when the line isn't present. */
function matchBar(text: string, re: RegExp): Bar | undefined {
  const m = re.exec(text);
  if (!m) return undefined;
  const parsed = Number.parseInt(m[1]!, 10);
  if (Number.isNaN(parsed)) return undefined;
  // Clamp to [0,100] so a malformed/over-100 value can't render an overflowing progress bar.
  const percent = Math.max(0, Math.min(100, parsed));
  const resets = (m[2] ?? "").trim();
  return { percent, ...(resets ? { resets } : {}) };
}

const OPTIONAL_RESET = String.raw`(?:\s*·?\s*resets?\s*(.+))?\s*$`;
const SESSION_RE = new RegExp(String.raw`^Current session:\s*(\d+)%\s*used${OPTIONAL_RESET}`, "im");
const WEEK_RE = new RegExp(String.raw`^Current week \(all models\):\s*(\d+)%\s*used${OPTIONAL_RESET}`, "im");
const MODEL_WEEK_RE = new RegExp(
  String.raw`^Current week \((?!all models\))(.+?)\):\s*(\d+)%\s*used${OPTIONAL_RESET}`,
  "gim",
);

function matchModelWeeks(text: string): ModelWeekBar[] {
  return Array.from(text.matchAll(MODEL_WEEK_RE), (match) => {
    const model = match[1]!.trim().replace(/\s+only$/i, "");
    const percent = Math.max(0, Math.min(100, Number.parseInt(match[2]!, 10)));
    const resets = (match[3] ?? "").trim();
    return { model, percent, ...(resets ? { resets } : {}) };
  }).filter((bar) => bar.model.length > 0 && !Number.isNaN(bar.percent));
}

/**
 * Parse the `/usage` result text into a UsageInfo. PURE: no spawn, no clock (the `now` arg stamps
 * `fetchedAt`). Returns null when neither the session nor the all-models week line parses (the feature
 * is then unavailable → the UI hides). Model-specific weeks and reset strings are optional. Reset
 * strings are kept as-is (trimmed); the UI may shorten them further.
 */
export function parseUsage(text: string, now: number = Date.now()): UsageInfo | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const session = matchBar(text, SESSION_RE);
  const week = matchBar(text, WEEK_RE);
  const weekModels = matchModelWeeks(text);
  const weekSonnetModel = weekModels.find((bar) => bar.model.toLowerCase() === "sonnet");
  const weekSonnet = weekSonnetModel
    ? {
        percent: weekSonnetModel.percent,
        ...(weekSonnetModel.resets ? { resets: weekSonnetModel.resets } : {}),
      }
    : undefined;
  if (!session && !week) return null;
  const info: UsageInfo = { fetchedAt: now };
  if (session) info.session = session;
  if (week) info.week = week;
  if (weekModels.length > 0) info.weekModels = weekModels;
  if (weekSonnet) info.weekSonnet = weekSonnet;
  return info;
}

/**
 * Pull the JSON object out of a PTY stream. Claude writes one JSON line, then may restore terminal modes
 * with ANSI sequences; using the outermost braces excludes that terminal trailer without trying to strip
 * arbitrary content from the JSON string itself.
 */
function resultFromPtyOutput(output: string): string {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return "";
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { result?: unknown };
    return typeof parsed.result === "string" ? parsed.result : "";
  } catch {
    return "";
  }
}

/**
 * The real `runUsage` adapter. Claude 2.1.207+ omits account-limit lines when stdin is not a TTY, so a
 * normal child-process pipe returns only the diagnostic "What's contributing" section and parses as no
 * limits. Run the short-lived `/usage` command in its own isolated PTY instead. This is NOT a RoamCode tmux
 * session; it exits with the command and never attaches to a user's chat. ANTHROPIC_API_KEY is stripped so
 * subscription auth is used. NEVER rejects — resolves "" on spawn error, timeout, malformed JSON, or a
 * missing `.result`.
 */
export function createUsageRunner(opts: {
  claudeBin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Test seam; production lazily loads node-pty, already required by terminal sessions. */
  ptySpawn?: UsagePtySpawn;
}): RunUsage {
  return () =>
    new Promise<string>((resolve) => {
      let settled = false;
      const finish = (val: string) => {
        if (settled) return;
        settled = true;
        resolve(val);
      };

      // Subscription auth only (mirrors claude-process): never pass an API key to the child.
      const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
      delete env.ANTHROPIC_API_KEY;

      let child: UsagePty;
      try {
        const ptySpawn: UsagePtySpawn =
          opts.ptySpawn ??
          ((file, args, options) => {
            const pty = require("node-pty") as typeof import("node-pty");
            return pty.spawn(file, args, options) as unknown as UsagePty;
          });
        child = ptySpawn(
          opts.claudeBin,
          ["-p", "/usage", "--output-format", "json", "--dangerously-skip-permissions"],
          { name: "xterm-256color", cols: 200, rows: 24, cwd: process.cwd(), env },
        );
      } catch {
        finish("");
        return;
      }

      let stdout = "";
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish("");
      }, opts.timeoutMs ?? USAGE_TIMEOUT_MS);

      child.onData((data) => (stdout += data));
      child.onExit(() => {
        clearTimeout(timer);
        finish(resultFromPtyOutput(stdout));
      });
    });
}

/**
 * Resolves + caches the parsed Claude usage. The cache stores the LAST GOOD snapshot; the TTL governs
 * when `runUsage` is re-run. A failed/empty fetch returns the last good value (or null), never throws.
 */
export class UsageService {
  private readonly runUsage: RunUsage;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cache?: { at: number; info: UsageInfo | null };

  constructor(deps: UsageServiceDeps) {
    this.runUsage = deps.runUsage;
    this.now = deps.now;
    this.ttlMs = deps.ttlMs ?? USAGE_CACHE_MS;
  }

  /**
   * Get the current usage. Within the TTL (and not forced) returns the cached snapshot WITHOUT
   * re-spawning. Otherwise runs `runUsage`, parses, and (on success) caches it as the new last-good.
   * A failed/empty refresh keeps the last good value (or null) and re-stamps the cache time so an
   * outage doesn't re-spawn on every poll.
   */
  async getUsage(force = false): Promise<UsageInfo | null> {
    const now = this.now();
    if (!force && this.cache && now - this.cache.at < this.ttlMs) return this.cache.info;

    const raw = await this.runUsage();
    const parsed = parseUsage(raw, now);
    // On a failed/empty refresh keep the last good snapshot if we have one, else null.
    const info = parsed ?? this.cache?.info ?? null;
    this.cache = { at: now, info };
    return info;
  }
}

/** Construct a UsageService with the real spawn adapter (the production wiring). */
export function createUsageService(opts: {
  claudeBin: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
}): UsageService {
  return new UsageService({
    runUsage: createUsageRunner({ claudeBin: opts.claudeBin, env: opts.env, timeoutMs: opts.timeoutMs }),
    now: opts.now ?? (() => Date.now()),
    ttlMs: opts.ttlMs,
  });
}
