import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ensureDataDir } from "./data-dir.js";
import { normalizeCloudControlPlaneOrigin } from "./cloud-device-enrollment.js";
import {
  CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2,
  CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN,
  CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN_V2,
} from "./cloud-contract.js";
import {
  CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN,
  CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN_V2,
  CloudAuthorizationKeysetV1Schema,
  CloudAuthorizationKeysetV2Schema,
  parseCloudAuthorizationKeyset,
  type CloudAuthorizationKeyset,
} from "./cloud-keyset.js";

export const CLOUD_HOST_CONFIG_FILE = "cloud-host.json";
const MAX_CONFIG_BYTES = 128 * 1024;
const HOST_CREDENTIAL = /^rch_[A-Za-z0-9_-]{64}$/;

export const CloudHostConfigV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal("roamcode-cloud-host-config"),
    organizationId: z.uuid(),
    hostId: z.uuid(),
    controlPlaneOrigin: z.string().min(1).max(2_048),
    hostCredential: z.string().regex(HOST_CREDENTIAL),
    authorization: z
      .object({
        algorithm: z.literal("Ed25519"),
        signatureDomain: z.literal(CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN),
        keysetSignatureDomain: z.literal(CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN),
        keyset: CloudAuthorizationKeysetV1Schema,
      })
      .strict(),
    heartbeatIntervalSeconds: z.number().int().min(5).max(300),
    authorizationRefreshIntervalSeconds: z.number().int().min(10).max(600),
  })
  .strict()
  .transform((config, context) => {
    let controlPlaneOrigin: string;
    try {
      controlPlaneOrigin = normalizeCloudControlPlaneOrigin(config.controlPlaneOrigin);
      parseCloudAuthorizationKeyset(config.authorization.keyset);
    } catch {
      context.addIssue({ code: "custom", message: "cloud host configuration is invalid" });
      return z.NEVER;
    }
    return { ...config, controlPlaneOrigin };
  });

export const CloudHostConfigV2Schema = z
  .object({
    v: z.literal(2),
    kind: z.literal("roamcode-cloud-host-config"),
    organizationId: z.uuid(),
    hostId: z.uuid(),
    controlPlaneOrigin: z.string().min(1).max(2_048),
    hostCredential: z.string().regex(HOST_CREDENTIAL),
    authorization: z
      .object({
        algorithm: z.literal(CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2),
        signatureDomain: z.literal(CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN_V2),
        keysetSignatureDomain: z.literal(CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN_V2),
        keyset: CloudAuthorizationKeysetV2Schema,
      })
      .strict(),
    heartbeatIntervalSeconds: z.number().int().min(5).max(300),
    authorizationRefreshIntervalSeconds: z.number().int().min(10).max(600),
  })
  .strict()
  .transform((config, context) => {
    let controlPlaneOrigin: string;
    try {
      controlPlaneOrigin = normalizeCloudControlPlaneOrigin(config.controlPlaneOrigin);
      parseCloudAuthorizationKeyset(config.authorization.keyset);
    } catch {
      context.addIssue({ code: "custom", message: "cloud host configuration is invalid" });
      return z.NEVER;
    }
    return { ...config, controlPlaneOrigin };
  });

export const CloudHostConfigSchema = z.union([CloudHostConfigV1Schema, CloudHostConfigV2Schema]);

export type CloudHostConfigV1 = z.output<typeof CloudHostConfigV1Schema>;
export type CloudHostConfigV2 = z.output<typeof CloudHostConfigV2Schema>;
export type CloudHostConfig = z.output<typeof CloudHostConfigSchema>;

export interface ResolvedCloudHostConfig {
  path: string;
  config: CloudHostConfig;
}

function existingFile(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("cloud host configuration could not be inspected");
  }
}

function assertSafeConfigFile(path: string): Stats | undefined {
  const stat = existingFile(path);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("cloud host configuration must be a regular file");
  if (stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) throw new Error("cloud host configuration has an invalid size");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("cloud host configuration must have mode 0600");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("cloud host configuration must be owned by the current user");
  }
  return stat;
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && !(process.platform === "win32" && code === "EPERM")) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function cloudHostConfigPath(dataDir: string): string {
  return join(dataDir, CLOUD_HOST_CONFIG_FILE);
}

export function readCloudHostConfig(path: string): CloudHostConfig | undefined {
  const before = assertSafeConfigFile(path);
  if (!before) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size <= 0 ||
      opened.size > MAX_CONFIG_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (opened.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) {
      throw new Error("cloud host configuration changed while it was being opened");
    }
    const raw = readFileSync(descriptor, "utf8");
    const afterRead = fstatSync(descriptor);
    if (
      Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES ||
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size
    ) {
      throw new Error("cloud host configuration changed while it was being read");
    }
    const parsed = CloudHostConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("cloud host configuration is corrupt");
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("cloud host configuration")) throw error;
    throw new Error("cloud host configuration is corrupt");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeCloudHostConfig(path: string, value: unknown): CloudHostConfig {
  const parsed = CloudHostConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error("cloud host configuration is invalid");
  const document = parsed.data;
  const serialized = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("cloud host configuration is too large");
  }
  ensureDataDir(dirname(path));
  const existing = existingFile(path);
  if (existing) assertSafeConfigFile(path);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
    return document;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed or never created */
    }
  }
}

/** Remove a managed host configuration without following links or deleting an unowned file. */
export function removeCloudHostConfig(path: string): boolean {
  const existing = existingFile(path);
  if (!existing) return false;
  assertSafeConfigFile(path);
  unlinkSync(path);
  fsyncDirectory(dirname(path));
  return true;
}

export function replaceCloudHostAuthorizationKeyset(
  path: string,
  current: CloudHostConfig,
  keyset: CloudAuthorizationKeyset,
): CloudHostConfig {
  const visible = readCloudHostConfig(path);
  if (!visible || JSON.stringify(visible) !== JSON.stringify(current)) {
    throw new Error("cloud host configuration changed before key rotation could be persisted");
  }
  if (visible.v !== keyset.v) {
    throw new Error("cloud authorization keyset contract does not match the provisioned host configuration");
  }
  return writeCloudHostConfig(path, {
    ...visible,
    authorization: { ...visible.authorization, keyset },
  });
}

export function resolveCloudHostConfig(env: NodeJS.ProcessEnv, dataDir: string): ResolvedCloudHostConfig | undefined {
  const configuredPath = env.ROAMCODE_CLOUD_HOST_CONFIG_FILE?.trim();
  if (!configuredPath) ensureDataDir(dataDir);
  const path = configuredPath || cloudHostConfigPath(dataDir);
  const config = readCloudHostConfig(path);
  if (!config && configuredPath) throw new Error("configured cloud host configuration file does not exist");
  return config ? { path, config } : undefined;
}
