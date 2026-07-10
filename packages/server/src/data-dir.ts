import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/**
 * Host data dir for the SQLite DB + access token. Never inside the project tree by default.
 *
 * Rename compat (Remote Coder → RoamCode): installs that predate the rename keep their data where it
 * already lives — the legacy `REMOTE_CODER_DATA_DIR` env still wins over defaults, and an existing
 * `…/remote-coder` dir is preferred over creating a fresh `…/roamcode` (their token / service.json /
 * session index MUST survive an OTA update). Only brand-new installs get the new directory name.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync): string {
  if (env.ROAMCODE_DATA_DIR) return env.ROAMCODE_DATA_DIR;
  if (env.REMOTE_CODER_DATA_DIR) return env.REMOTE_CODER_DATA_DIR; // legacy (pre-rename services set this)
  const pick = (next: string, legacy: string) => (!exists(next) && exists(legacy) ? legacy : next);
  if (env.XDG_CONFIG_HOME) return pick(join(env.XDG_CONFIG_HOME, "roamcode"), join(env.XDG_CONFIG_HOME, "remote-coder"));
  if (env.HOME) return pick(join(env.HOME, ".config", "roamcode"), join(env.HOME, ".config", "remote-coder"));
  return pick(join(process.cwd(), ".roamcode"), join(process.cwd(), ".remote-coder"));
}

export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Strong default token: 32 bytes of CSPRNG entropy (>= spec §9 baseline),
 * base64url-encoded (43 chars, no padding). Never Math.random / randomUUID.
 */
export function generateAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Persist a token to `<dataDir>/token` with mode 0600 (overwriting any prior file). Used by both first-run
 * generation and POST /token/rotate. `writeFileSync`'s `mode` is honored only when CREATING a file, so we
 * chmod unconditionally afterwards — a rotated secret can never land in a too-permissive (e.g. world-
 * readable) file left behind by an earlier write.
 */
export function persistAccessToken(dataDir: string, token: string): void {
  ensureDataDir(dataDir);
  const tokenPath = join(dataDir, "token");
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
}

export interface ResolveAccessTokenOptions {
  /** From ACCESS_TOKEN; when set it wins and is not persisted. */
  configured?: string;
  dataDir: string;
  /** Injectable generator for tests. Defaults to a 32-byte base64url CSPRNG token. */
  generate?: () => string;
}

/**
 * Spec §9: a long random secret generated on first run (printed once, stored).
 * Precedence: explicit ACCESS_TOKEN > persisted token file > freshly generated.
 *
 * A configured (env) token is used verbatim and never written to disk. A
 * generated token is persisted to `<dataDir>/token` with mode 0600 so other
 * users on the host cannot read it; `generated: true` lets the caller print it
 * once with the access URL.
 */
export function resolveAccessToken(opts: ResolveAccessTokenOptions): { token: string; generated: boolean } {
  if (opts.configured) return { token: opts.configured, generated: false };

  const tokenPath = join(opts.dataDir, "token");
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing) return { token: existing, generated: false };
  } catch {
    // no token file yet — fall through to generation
  }

  const token = (opts.generate ?? generateAccessToken)();
  persistAccessToken(opts.dataDir, token);
  return { token, generated: true };
}
