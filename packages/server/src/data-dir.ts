import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const ACCESS_TOKEN_FILE = "token";
const MAX_ACCESS_TOKEN_BYTES = 4 * 1024;
const MAX_ACCESS_TOKEN_FILE_BYTES = MAX_ACCESS_TOKEN_BYTES + 2; // allow one trailing LF or CRLF

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
  if (env.XDG_CONFIG_HOME)
    return pick(join(env.XDG_CONFIG_HOME, "roamcode"), join(env.XDG_CONFIG_HOME, "remote-coder"));
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

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && !(process.platform === "win32" && code === "EPERM")) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function existingTokenStat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateAccessToken(token: string): string {
  if (!token || Buffer.byteLength(token, "utf8") > MAX_ACCESS_TOKEN_BYTES || /[\u0000-\u0020\u007f]/u.test(token)) {
    throw new Error("access token must be non-empty printable text without whitespace");
  }
  return token;
}

function decodePersistedAccessToken(content: string): string {
  let token = content;
  if (token.endsWith("\n")) token = token.slice(0, -1);
  if (token.endsWith("\r")) token = token.slice(0, -1);
  return validateAccessToken(token);
}

/** Reads only the already-inspected inode and repairs legacy permissive file modes without following links. */
function readPersistedAccessToken(path: string): string | undefined {
  const before = existingTokenStat(path);
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("access token path must be a regular file");
  if (before.size > MAX_ACCESS_TOKEN_FILE_BYTES) throw new Error("access token file is too large");
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw new Error("access token file must be owned by the current user");
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > MAX_ACCESS_TOKEN_FILE_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) {
      throw new Error("access token changed while it was being opened");
    }
    // Repair old installations through the descriptor so a swapped path is never chmodded.
    fchmodSync(descriptor, 0o600);
    return decodePersistedAccessToken(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("access token ")) throw error;
    throw new Error("access token file could not be read safely");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function stageAccessToken(path: string, token: string): string {
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  let failed = false;
  let failure: unknown;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${validateAccessToken(token)}\n`, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    descriptor = undefined;
  }
  if (failed) {
    try {
      unlinkSync(temporary);
    } catch {
      /* never created */
    }
    throw failure;
  }
  return temporary;
}

/**
 * Persist a token to `<dataDir>/token` with mode 0600 (atomically replacing any prior regular file). Used by
 * POST /token/rotate and access reset. The secret is fsynced before rename, and the containing directory is
 * fsynced afterwards; a crash can expose either the complete old token or the complete new token, never a
 * truncated intermediate value.
 */
export function persistAccessToken(dataDir: string, token: string): void {
  ensureDataDir(dataDir);
  const tokenPath = join(dataDir, ACCESS_TOKEN_FILE);
  const existing = existingTokenStat(tokenPath);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("access token path must be a regular file");
    if (typeof process.getuid === "function" && existing.uid !== process.getuid()) {
      throw new Error("access token file must be owned by the current user");
    }
  }
  const temporary = stageAccessToken(tokenPath, token);
  try {
    renameSync(temporary, tokenPath);
    try {
      fsyncDirectory(dirname(tokenPath));
    } catch (error) {
      // A late directory-fsync error can arrive after rename made the complete new token authoritative. Treat a
      // securely re-read exact match as committed so the live AuthGate cannot remain on the old token while disk
      // already contains the new one.
      let visible: string | undefined;
      try {
        visible = readPersistedAccessToken(tokenPath);
      } catch {
        /* Preserve the original durability error below. */
      }
      if (visible !== token) throw error;
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed or already removed */
    }
  }
}

/** Installs a first-run token without replacing a value concurrently created by another server process. */
function installAccessTokenIfMissing(dataDir: string, token: string): boolean {
  ensureDataDir(dataDir);
  const tokenPath = join(dataDir, ACCESS_TOKEN_FILE);
  const temporary = stageAccessToken(tokenPath, token);
  let installed = false;
  try {
    try {
      linkSync(temporary, tokenPath);
      installed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already removed or never created */
    }
  }
  if (installed) fsyncDirectory(dirname(tokenPath));
  return installed;
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

  const tokenPath = join(opts.dataDir, ACCESS_TOKEN_FILE);
  const existing = readPersistedAccessToken(tokenPath);
  if (existing) return { token: existing, generated: false };

  const token = validateAccessToken((opts.generate ?? generateAccessToken)());
  if (installAccessTokenIfMissing(opts.dataDir, token)) return { token, generated: true };

  // Another process won first-run initialization. Return its durable token and never print our unused candidate.
  const winner = readPersistedAccessToken(tokenPath);
  if (!winner) throw new Error("access token initialization raced with removal; retry startup");
  return { token: winner, generated: false };
}
