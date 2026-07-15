import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureDataDir } from "./data-dir.js";
import { generateRelayIdentity, validateRelayIdentity, type RelayIdentity } from "./relay-crypto.js";

const RELAY_IDENTITY_FILE = "relay-identity.json";

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
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error("relay identity could not be read");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("relay identity path must be a regular file");
  let document: Partial<PersistedRelayIdentity>;
  try {
    document = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedRelayIdentity>;
  } catch {
    throw new Error("relay identity file is corrupt; restore it from backup instead of replacing it");
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
  // Existing installs may have inherited a permissive umask. Repair metadata only; never replace key bytes.
  chmodSync(path, 0o600);
  return { identity, createdAt: document.createdAt!, path, generated: false };
}

function writeDurably(path: string, document: PersistedRelayIdentity): boolean {
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    try {
      // A hard-link install is atomic and cannot replace a concurrently-created identity.
      linkSync(temporary, path);
      return true;
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
