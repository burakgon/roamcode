import { execFile as nodeExecFile } from "node:child_process";
import type { ProviderAvailability } from "./providers/types.js";

/** Merge host and provider capability probes while replacing all provider/child detail with stable text. */
export function normalizeProviderAvailability(
  hostTerminalAvailable: boolean,
  probed: ProviderAvailability,
  metadataAvailable: boolean = probed.metadataAvailable,
): ProviderAvailability {
  const terminalAvailable = hostTerminalAvailable && probed.terminalAvailable;
  return {
    terminalAvailable,
    metadataAvailable,
    ...(probed.version ? { version: probed.version } : {}),
    ...(!terminalAvailable
      ? { detail: "Provider terminal unavailable" }
      : !metadataAvailable
        ? { detail: "Provider metadata protocol unavailable" }
        : {}),
  };
}

/**
 * Best-effort, CACHED `claude --version` probe for the authed GET /diag (fleet observability). It must
 * NOT block the request long, so the spawn is timeout-guarded (short) and the result is cached for
 * CLAUDE_VERSION_CACHE_MS — a /diag poll then never re-spawns within the window. A missing/erroring
 * claude resolves to {available:false} (never throws), so /diag degrades instead of 500ing.
 *
 * The spawn is injectable (a function returning {stdout} or rejecting) so tests assert the caching +
 * the available/unavailable shaping without spawning a real binary.
 */

/** How long a probe result (success OR failure) is reused before re-spawning. Long enough that the
 *  /diag poll is cheap; short enough that a claude install/upgrade is reflected within a few minutes. */
export const CLAUDE_VERSION_CACHE_MS = 5 * 60_000;

/** Short hard timeout on the spawn so a hung claude never makes /diag hang. */
export const CLAUDE_VERSION_TIMEOUT_MS = 3_000;

export interface ClaudeAvailability {
  available: boolean;
  /** The parsed version string (e.g. "1.2.3") when available; absent otherwise. */
  version?: string;
}

/** Run `<bin> --version` (timeout-guarded), resolving its stdout. Rejects on spawn error / non-zero. */
export type RunClaudeVersion = () => Promise<{ stdout: string }>;

export interface ClaudeVersionProbe {
  /** Resolve the (cached) availability. Never rejects. */
  get(): Promise<ClaudeAvailability>;
}

/** The real runner: `<claudeBin> --version` with the server env + a short timeout. */
export function defaultRunClaudeVersion(claudeBin: string, env: NodeJS.ProcessEnv): RunClaudeVersion {
  return () =>
    new Promise<{ stdout: string }>((resolve, reject) => {
      nodeExecFile(
        claudeBin,
        ["--version"],
        { env, timeout: CLAUDE_VERSION_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) reject(err);
          else resolve({ stdout: String(stdout) });
        },
      );
    });
}

/**
 * Extract a version-looking token from `claude --version` output (e.g. "1.2.3 (Claude Code)" → "1.2.3").
 * Returns the trimmed raw string when no dotted-number token is found (still useful), or undefined for
 * empty output.
 */
export function parseClaudeVersion(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const m = /\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?/.exec(trimmed);
  return m ? m[0] : trimmed;
}

/** Build a cached probe over an injected runner + clock. */
export function createClaudeVersionProbe(deps: { run: RunClaudeVersion; now?: () => number }): ClaudeVersionProbe {
  const now = deps.now ?? (() => Date.now());
  let cache: { at: number; value: ClaudeAvailability } | undefined;
  let inFlight: Promise<ClaudeAvailability> | undefined;
  return {
    async get(): Promise<ClaudeAvailability> {
      const t = now();
      if (cache && t - cache.at < CLAUDE_VERSION_CACHE_MS) return cache.value;
      // Collapse concurrent probes into one spawn.
      if (inFlight) return inFlight;
      inFlight = (async () => {
        let value: ClaudeAvailability;
        try {
          const { stdout } = await deps.run();
          const version = parseClaudeVersion(stdout);
          value = version ? { available: true, version } : { available: true };
        } catch {
          value = { available: false };
        }
        cache = { at: now(), value };
        inFlight = undefined;
        return value;
      })();
      return inFlight;
    },
  };
}
