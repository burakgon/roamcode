import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureDataDir } from "./data-dir.js";
import { generateRelayIdentity, validateRelayIdentity, type RelayIdentity } from "./relay-crypto.js";

const RELAY_IDENTITY_FILE = "relay-identity.json";
const MAX_IDENTITY_BYTES = 32 * 1024;

interface PersistedRelayIdentity extends RelayIdentity {
  version: 1;
  createdAt: number;
}

export interface RelayIdentityStoreOptions {
  dataDir: string;
  generate?: () => RelayIdentity;
  now?: () => number;
}

export interface DurableRelayIdentity {
  identity: RelayIdentity;
  createdAt: number;
  path: string;
  generated: boolean;
}

function readIdentity(path: string): DurableRelayIdentity {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    throw new Error("relay identity could not be read");
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("relay identity path must be a regular file");
  if (before.size > MAX_IDENTITY_BYTES) throw new Error("relay identity file is too large");
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw new Error("relay identity must be owned by the current user");
  }
  let descriptor: number | undefined;
  let document: Partial<PersistedRelayIdentity>;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > MAX_IDENTITY_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) {
      throw new Error("relay identity changed while it was being opened");
    }
    // Existing installs may have inherited a permissive umask. Repair the already-opened inode only; never follow a
    // swapped path or replace key bytes.
    fchmodSync(descriptor, 0o600);
    document = JSON.parse(readFileSync(descriptor, "utf8")) as Partial<PersistedRelayIdentity>;
  } catch {
    throw new Error("relay identity file is corrupt; restore it from backup instead of replacing it");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (document.version !== 1 || !Number.isSafeInteger(document.createdAt) || document.createdAt! < 0) {
    throw new Error("relay identity file has an unsupported format");
  }
  let identity: RelayIdentity;
  try {
    identity = validateRelayIdentity(document);
  } catch {
    throw new Error("relay identity file contains an invalid or mismatched keypair");
  }
  return { identity, createdAt: document.createdAt!, path, generated: false };
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

function writeDurably(path: string, document: PersistedRelayIdentity): boolean {
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  let installed = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      // A hard-link install is atomic and cannot replace a concurrently-created identity.
      linkSync(temporary, path);
      installed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      /* already removed or never created */
    }
  }
  if (installed) fsyncDirectory(dirname(path));
  return installed;
}

/** Loads one stable host identity or creates it once without allowing concurrent processes to overwrite it. */
export function loadOrCreateRelayIdentity(options: RelayIdentityStoreOptions): DurableRelayIdentity {
  ensureDataDir(options.dataDir);
  const path = join(options.dataDir, RELAY_IDENTITY_FILE);
  if (existsSync(path)) return readIdentity(path);
  const identity = validateRelayIdentity((options.generate ?? generateRelayIdentity)());
  const createdAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("invalid relay identity creation time");
  const installed = writeDurably(path, { version: 1, createdAt, ...identity });
  if (!installed) return readIdentity(path);
  return { identity, createdAt, path, generated: true };
}
