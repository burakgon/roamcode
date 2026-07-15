import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureDataDir } from "./data-dir.js";
import type { RelayIdentity } from "./relay-crypto.js";
import { loadOrCreateRelayIdentity } from "./relay-identity-store.js";
import { relayConnectUrl } from "./relay-host.js";
import { normalizeRelayAppUrl } from "./relay-pairing.js";

const RELAY_HOST_CONFIG_FILE = "relay-host.json";
const MAX_CONFIG_BYTES = 16 * 1024;

export interface RelayHostRuntimeConfig {
  relayUrl: string;
  routeId: string;
  hostCredential: string;
  hostIdentity: RelayIdentity;
  /** Static PWA origin used only for one-use remote pairing links. */
  appUrl?: string;
  hostLabel: string;
}

export interface PersistedRelayHostConfig {
  version: 1;
  relayUrl: string;
  routeId: string;
  hostCredential: string;
  appUrl?: string;
  hostLabel: string;
}

export type RelayHostConfigInput = Omit<PersistedRelayHostConfig, "version">;

function safeHostLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("relay host label is required");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new Error("relay host label must be 1-80 printable characters");
  }
  return normalized;
}

function validateCore(input: {
  relayUrl: unknown;
  routeId: unknown;
  hostCredential: unknown;
  appUrl?: unknown;
  hostLabel: unknown;
}): RelayHostConfigInput {
  if (typeof input.relayUrl !== "string") throw new Error("relay URL is required");
  relayConnectUrl(input.relayUrl);
  if (typeof input.routeId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.routeId)) {
    throw new Error("relay route id is invalid");
  }
  if (typeof input.hostCredential !== "string" || !/^rrh_[A-Za-z0-9_-]{43}$/.test(input.hostCredential)) {
    throw new Error("relay host credential is invalid");
  }
  return {
    relayUrl: input.relayUrl.trim(),
    routeId: input.routeId,
    hostCredential: input.hostCredential,
    ...(input.appUrl === undefined || input.appUrl === ""
      ? {}
      : { appUrl: normalizeRelayAppUrl(String(input.appUrl)) }),
    hostLabel: safeHostLabel(input.hostLabel),
  };
}

export function relayHostConfigPath(dataDir: string): string {
  return join(dataDir, RELAY_HOST_CONFIG_FILE);
}

function existingConfigStat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function readRelayHostConfig(dataDir: string): PersistedRelayHostConfig | undefined {
  const path = relayHostConfigPath(dataDir);
  const stat = existingConfigStat(path);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("relay host config path must be a regular file");
  if (stat.size > MAX_CONFIG_BYTES) throw new Error("relay host config is too large");
  let value: Partial<PersistedRelayHostConfig>;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedRelayHostConfig>;
  } catch {
    throw new Error("relay host config is corrupt");
  }
  if (value.version !== 1) throw new Error("relay host config has an unsupported version");
  const validated = validateCore({
    relayUrl: value.relayUrl,
    routeId: value.routeId,
    hostCredential: value.hostCredential,
    appUrl: value.appUrl,
    hostLabel: value.hostLabel,
  });
  chmodSync(path, 0o600);
  return { version: 1, ...validated };
}

export function writeRelayHostConfig(dataDir: string, input: RelayHostConfigInput): PersistedRelayHostConfig {
  const document: PersistedRelayHostConfig = { version: 1, ...validateCore(input) };
  ensureDataDir(dataDir);
  const path = relayHostConfigPath(dataDir);
  const existing = existingConfigStat(path);
  if (existing) {
    const stat = existing;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("relay host config path must be a regular file");
  }
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return { ...document };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed or never created */
    }
  }
}

export function removeRelayHostConfig(dataDir: string): boolean {
  const path = relayHostConfigPath(dataDir);
  const stat = existingConfigStat(path);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("relay host config path must be a regular file");
  unlinkSync(path);
  return true;
}

export function resolveRelayHostConfig(env: NodeJS.ProcessEnv, dataDir: string): RelayHostRuntimeConfig | undefined {
  const relayUrl = env.ROAMCODE_RELAY_URL?.trim();
  const routeId = env.ROAMCODE_RELAY_ROUTE_ID?.trim();
  const hostCredential = env.ROAMCODE_RELAY_HOST_CREDENTIAL?.trim();
  const hasEnvironmentCore = !!(relayUrl || routeId || hostCredential);
  if (hasEnvironmentCore && (!relayUrl || !routeId || !hostCredential)) {
    throw new Error(
      "relay configuration is incomplete; ROAMCODE_RELAY_URL, ROAMCODE_RELAY_ROUTE_ID, and ROAMCODE_RELAY_HOST_CREDENTIAL are all required",
    );
  }
  const persisted = hasEnvironmentCore ? undefined : readRelayHostConfig(dataDir);
  if (!hasEnvironmentCore && !persisted) return undefined;
  const values = validateCore({
    relayUrl: relayUrl ?? persisted?.relayUrl,
    routeId: routeId ?? persisted?.routeId,
    hostCredential: hostCredential ?? persisted?.hostCredential,
    appUrl: env.ROAMCODE_RELAY_APP_URL?.trim() || persisted?.appUrl,
    hostLabel:
      env.ROAMCODE_RELAY_HOST_LABEL?.trim() ||
      env.ROAMCODE_HOST_NAME?.trim() ||
      env.REMOTE_CODER_HOST_NAME?.trim() ||
      persisted?.hostLabel ||
      "RoamCode host",
  });
  return {
    ...values,
    hostIdentity: loadOrCreateRelayIdentity({ dataDir }).identity,
  };
}
