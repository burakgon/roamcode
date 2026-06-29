/**
 * The LATEST published `claude` CLI version, for update-awareness: the UI compares a session's
 * `claudeVersion` (what it spawned with) against this to show a subtle "update available" hint when a
 * chat is running an older Claude than what's out.
 *
 * Source: the npm registry's dist-tag for `@anthropic-ai/claude-code` (the same release train as the
 * native installer), fetched best-effort and TTL-cached so the rare /claude/version poll is cheap. Any
 * failure (offline, timeout, registry hiccup) degrades to the last good value, or undefined — the UI
 * simply hides the hint, never errors. The fetch is an INJECTABLE seam so the cache logic is unit-testable.
 */

const NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
export const CLAUDE_LATEST_CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/** Resolve the latest version string (e.g. "2.1.195"). NEVER rejects — resolves undefined on any failure. */
export type FetchLatest = () => Promise<string | undefined>;

export interface ClaudeLatestDeps {
  fetchLatest: FetchLatest;
  now: () => number;
  ttlMs?: number;
}

/** Pull `version` out of an npm dist-tag document (`{ "version": "2.1.195", … }`). */
export function parseNpmLatest(json: unknown): string | undefined {
  if (json && typeof json === "object" && typeof (json as { version?: unknown }).version === "string") {
    return (json as { version: string }).version;
  }
  return undefined;
}

export class ClaudeLatestService {
  private readonly fetchLatest: FetchLatest;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cache?: { at: number; value: string | undefined };

  constructor(deps: ClaudeLatestDeps) {
    this.fetchLatest = deps.fetchLatest;
    this.now = deps.now;
    this.ttlMs = deps.ttlMs ?? CLAUDE_LATEST_CACHE_MS;
  }

  /** The latest version, TTL-cached. A failed refresh keeps the last good value (or undefined). */
  async getLatest(): Promise<string | undefined> {
    const now = this.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.value;
    const fetched = await this.fetchLatest().catch(() => undefined);
    const value = fetched ?? this.cache?.value;
    this.cache = { at: now, value };
    return value;
  }
}

/** The real fetch adapter: GET the npm dist-tag doc with a short timeout. Resolves undefined on any error. */
export function createClaudeLatestService(opts: { now?: () => number; ttlMs?: number } = {}): ClaudeLatestService {
  const fetchLatest: FetchLatest = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(NPM_LATEST_URL, { signal: controller.signal });
      if (!res.ok) return undefined;
      return parseNpmLatest(await res.json());
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  return new ClaudeLatestService({ fetchLatest, now: opts.now ?? (() => Date.now()), ttlMs: opts.ttlMs });
}
