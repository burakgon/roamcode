import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";
import { relayIdentityFingerprint } from "./relay-crypto.js";

export const CLOUD_CONTRACT_VERSION = 1 as const;
export const CLOUD_AUTHORIZATION_CONTRACT_VERSION = 2 as const;
export const CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM = "Ed25519" as const;
export const CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2 = "Ed25519-SHA256" as const;
export const CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN = "roamcode-cloud-authorization-snapshot-v1";
export const CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN_V2 = "roamcode-cloud-authorization-snapshot-v2";
export const CLOUD_AUTHORIZATION_MAX_SNAPSHOT_TTL_MS = 60 * 60_000;
export const CLOUD_AUTHORIZATION_MAX_SNAPSHOT_AGE_MS = CLOUD_AUTHORIZATION_MAX_SNAPSHOT_TTL_MS;

export const CLOUD_AUTHORIZATION_PERMISSIONS = [
  "team:read",
  "sessions:read",
  "sessions:operate",
  "attention:read",
  "attention:manage",
  "presence:read",
  "presence:write",
  "workspaces:manage",
  "extensions:manage",
  "policy:manage",
  "members:manage",
  "node-access:manage",
  "audit:read",
  "fleet:read",
] as const;

const SafeIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);
const SafeCounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Base64UrlSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/);

export const CloudRelayHostIdentitySchema = z
  .object({
    publicKey: Base64UrlSchema,
    fingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  })
  .strict()
  .superRefine((identity, context) => {
    try {
      if (relayIdentityFingerprint(identity.publicKey) !== identity.fingerprint) {
        context.addIssue({ code: "custom", path: ["fingerprint"], message: "fingerprint does not match public key" });
      }
    } catch {
      context.addIssue({ code: "custom", path: ["publicKey"], message: "public key must be a P-256 SPKI key" });
    }
  });

export const CloudAuthorizationPermissionSchema = z.enum(CLOUD_AUTHORIZATION_PERMISSIONS);

export const CloudHostHeartbeatV1Schema = z
  .object({
    v: z.literal(CLOUD_CONTRACT_VERSION),
    kind: z.literal("host-heartbeat"),
    organizationId: SafeIdentifierSchema,
    hostId: SafeIdentifierSchema,
    instanceId: SafeIdentifierSchema,
    sentAt: TimestampSchema,
    sequence: SafeCounterSchema,
    softwareVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9A-Za-z.+-]+$/),
    state: z.enum(["ready", "draining"]),
    authorizationRevision: PositiveRevisionSchema.nullable(),
    relayHostIdentity: CloudRelayHostIdentitySchema.optional(),
    capabilities: z
      .array(
        z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-z][a-z0-9_.:-]*$/),
      )
      .max(64),
  })
  .strict()
  .superRefine((heartbeat, context) => {
    if (new Set(heartbeat.capabilities).size !== heartbeat.capabilities.length) {
      context.addIssue({ code: "custom", path: ["capabilities"], message: "capabilities must be unique" });
    }
  });

export const CloudAuthorizationScopeV1Schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("organization") }).strict(),
  z.object({ type: z.literal("host"), id: SafeIdentifierSchema }).strict(),
  z.object({ type: z.literal("workspace"), id: SafeIdentifierSchema }).strict(),
]);

export const CloudAuthorizationGrantV1Schema = z
  .object({
    principalType: z.enum(["device", "relay"]),
    principalId: SafeIdentifierSchema,
    permissions: z.array(CloudAuthorizationPermissionSchema).min(1).max(CLOUD_AUTHORIZATION_PERMISSIONS.length),
    scope: CloudAuthorizationScopeV1Schema,
  })
  .strict()
  .superRefine((grant, context) => {
    if (new Set(grant.permissions).size !== grant.permissions.length) {
      context.addIssue({ code: "custom", path: ["permissions"], message: "permissions must be unique" });
    }
  });

export const CloudAuthorizationSnapshotV1Schema = z
  .object({
    v: z.literal(CLOUD_CONTRACT_VERSION),
    kind: z.literal("authorization-snapshot"),
    organizationId: SafeIdentifierSchema,
    hostId: SafeIdentifierSchema,
    revision: PositiveRevisionSchema,
    issuedAt: TimestampSchema,
    notBefore: TimestampSchema,
    expiresAt: TimestampSchema,
    grants: z.array(CloudAuthorizationGrantV1Schema).max(10_000),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.expiresAt <= snapshot.issuedAt) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiry must be after issue time" });
    }
    if (snapshot.expiresAt <= snapshot.notBefore) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiry must be after activation time" });
    }
    if (snapshot.expiresAt - snapshot.issuedAt > CLOUD_AUTHORIZATION_MAX_SNAPSHOT_TTL_MS) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "snapshot lifetime exceeds one hour" });
    }
  });

export const CloudAuthorizationSnapshotV2Schema = z
  .object({
    v: z.literal(CLOUD_AUTHORIZATION_CONTRACT_VERSION),
    kind: z.literal("authorization-snapshot"),
    organizationId: SafeIdentifierSchema,
    hostId: SafeIdentifierSchema,
    revision: PositiveRevisionSchema,
    issuedAt: TimestampSchema,
    notBefore: TimestampSchema,
    expiresAt: TimestampSchema,
    grants: z.array(CloudAuthorizationGrantV1Schema).max(10_000),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.expiresAt <= snapshot.issuedAt) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiry must be after issue time" });
    }
    if (snapshot.expiresAt <= snapshot.notBefore) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiry must be after activation time" });
    }
    if (snapshot.expiresAt - snapshot.issuedAt > CLOUD_AUTHORIZATION_MAX_SNAPSHOT_TTL_MS) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "snapshot lifetime exceeds one hour" });
    }
  });

export const CloudAuthorizationSnapshotSchema = z.discriminatedUnion("v", [
  CloudAuthorizationSnapshotV1Schema,
  CloudAuthorizationSnapshotV2Schema,
]);

export const SignedCloudAuthorizationSnapshotV1Schema = z
  .object({
    v: z.literal(CLOUD_CONTRACT_VERSION),
    kind: z.literal("signed-authorization-snapshot"),
    algorithm: z.literal(CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM),
    keyId: SafeIdentifierSchema,
    snapshot: CloudAuthorizationSnapshotV1Schema,
    signature: Base64UrlSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    const decoded = Buffer.from(envelope.signature, "base64url");
    if (decoded.length !== 64 || decoded.toString("base64url") !== envelope.signature) {
      context.addIssue({ code: "custom", path: ["signature"], message: "signature must be canonical Ed25519 bytes" });
    }
  });

export const SignedCloudAuthorizationSnapshotV2Schema = z
  .object({
    v: z.literal(CLOUD_AUTHORIZATION_CONTRACT_VERSION),
    kind: z.literal("signed-authorization-snapshot"),
    algorithm: z.literal(CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2),
    keyId: SafeIdentifierSchema,
    snapshot: CloudAuthorizationSnapshotV2Schema,
    signature: Base64UrlSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    const decoded = Buffer.from(envelope.signature, "base64url");
    if (decoded.length !== 64 || decoded.toString("base64url") !== envelope.signature) {
      context.addIssue({ code: "custom", path: ["signature"], message: "signature must be canonical Ed25519 bytes" });
    }
  });

export const SignedCloudAuthorizationSnapshotSchema = z.discriminatedUnion("v", [
  SignedCloudAuthorizationSnapshotV1Schema,
  SignedCloudAuthorizationSnapshotV2Schema,
]);

export const CloudAuthorizationTrustedKeySchema = z
  .object({
    keyId: SafeIdentifierSchema,
    algorithm: z.literal(CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM),
    publicKey: Base64UrlSchema,
    notBefore: TimestampSchema.optional(),
    notAfter: TimestampSchema.optional(),
    trustExpiresAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((key, context) => {
    if (key.notBefore !== undefined && key.notAfter !== undefined && key.notAfter <= key.notBefore) {
      context.addIssue({ code: "custom", path: ["notAfter"], message: "key expiry must be after activation" });
    }
  });

export const CloudAuthorizationTrustedKeyV2Schema = z
  .object({
    keyId: SafeIdentifierSchema,
    algorithm: z.literal(CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2),
    publicKey: Base64UrlSchema,
    notBefore: TimestampSchema.optional(),
    notAfter: TimestampSchema.optional(),
    trustExpiresAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((key, context) => {
    if (key.notBefore !== undefined && key.notAfter !== undefined && key.notAfter <= key.notBefore) {
      context.addIssue({ code: "custom", path: ["notAfter"], message: "key expiry must be after activation" });
    }
  });

export const CloudAuthorizationTrustedKeyAnySchema = z.discriminatedUnion("algorithm", [
  CloudAuthorizationTrustedKeySchema,
  CloudAuthorizationTrustedKeyV2Schema,
]);

export type CloudAuthorizationPermission = z.infer<typeof CloudAuthorizationPermissionSchema>;
export type CloudRelayHostIdentity = z.infer<typeof CloudRelayHostIdentitySchema>;
export type CloudHostHeartbeatV1 = z.infer<typeof CloudHostHeartbeatV1Schema>;
export type CloudAuthorizationScopeV1 = z.infer<typeof CloudAuthorizationScopeV1Schema>;
export type CloudAuthorizationGrantV1 = z.infer<typeof CloudAuthorizationGrantV1Schema>;
export type CloudAuthorizationSnapshotV1 = z.infer<typeof CloudAuthorizationSnapshotV1Schema>;
export type CloudAuthorizationSnapshotV2 = z.infer<typeof CloudAuthorizationSnapshotV2Schema>;
export type CloudAuthorizationSnapshot = z.infer<typeof CloudAuthorizationSnapshotSchema>;
export type SignedCloudAuthorizationSnapshotV1 = z.infer<typeof SignedCloudAuthorizationSnapshotV1Schema>;
export type SignedCloudAuthorizationSnapshotV2 = z.infer<typeof SignedCloudAuthorizationSnapshotV2Schema>;
export type SignedCloudAuthorizationSnapshot = z.infer<typeof SignedCloudAuthorizationSnapshotSchema>;
export type CloudAuthorizationTrustedKeyV1 = z.infer<typeof CloudAuthorizationTrustedKeySchema>;
export type CloudAuthorizationTrustedKeyV2 = z.infer<typeof CloudAuthorizationTrustedKeyV2Schema>;
export type CloudAuthorizationTrustedKey = z.infer<typeof CloudAuthorizationTrustedKeyAnySchema>;

export type CloudAuthorizationVerificationErrorCode =
  | "INVALID_ENVELOPE"
  | "INVALID_KEYRING"
  | "UNKNOWN_KEY"
  | "KEY_NOT_ACTIVE"
  | "TRUST_EXPIRED"
  | "ALGORITHM_MISMATCH"
  | "INVALID_PUBLIC_KEY"
  | "INVALID_SIGNATURE";

export class CloudAuthorizationVerificationError extends Error {
  constructor(
    readonly code: CloudAuthorizationVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CloudAuthorizationVerificationError";
  }
}

export function canonicalCloudJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalCloudJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalCloudJson(object[key])}`)
    .join(",")}}`;
}

export function parseCloudHostHeartbeat(value: unknown): CloudHostHeartbeatV1 {
  return CloudHostHeartbeatV1Schema.parse(value);
}

export function parseCloudAuthorizationSnapshot(value: unknown): CloudAuthorizationSnapshot {
  return CloudAuthorizationSnapshotSchema.parse(value);
}

export function parseSignedCloudAuthorizationSnapshot(value: unknown): SignedCloudAuthorizationSnapshot {
  return SignedCloudAuthorizationSnapshotSchema.parse(value);
}

/**
 * Exact, domain-separated bytes that the cloud control plane signs and the host verifies.
 *
 * V1 signs the raw protected envelope for self-host compatibility. V2 signs exactly the SHA-256 digest of the
 * protected envelope so hardware signers never receive attacker-amplifiable snapshot bytes.
 */
export function cloudAuthorizationSnapshotSigningPayload(snapshot: unknown, keyId: string): Buffer {
  const validated = parseCloudAuthorizationSnapshot(snapshot);
  const validatedKeyId = SafeIdentifierSchema.parse(keyId);
  if (validated.v === CLOUD_CONTRACT_VERSION) {
    const protectedEnvelope = {
      v: CLOUD_CONTRACT_VERSION,
      kind: "signed-authorization-snapshot",
      algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM,
      keyId: validatedKeyId,
      snapshot: validated,
    };
    return Buffer.from(`${CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN}\0${canonicalCloudJson(protectedEnvelope)}`, "utf8");
  }
  const protectedEnvelope = {
    v: CLOUD_AUTHORIZATION_CONTRACT_VERSION,
    kind: "signed-authorization-snapshot",
    algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2,
    keyId: validatedKeyId,
    snapshot: validated,
  };
  return createHash("sha256")
    .update(CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN_V2, "utf8")
    .update("\0", "utf8")
    .update(canonicalCloudJson(protectedEnvelope), "utf8")
    .digest();
}

function trustedKeyMap(keys: readonly CloudAuthorizationTrustedKey[]): Map<string, CloudAuthorizationTrustedKey> {
  const map = new Map<string, CloudAuthorizationTrustedKey>();
  for (const value of keys) {
    const parsed = CloudAuthorizationTrustedKeyAnySchema.safeParse(value);
    if (!parsed.success) {
      throw new CloudAuthorizationVerificationError("INVALID_KEYRING", "cloud authorization keyring is invalid");
    }
    if (map.has(parsed.data.keyId)) {
      throw new CloudAuthorizationVerificationError(
        "INVALID_KEYRING",
        "cloud authorization keyring contains a duplicate key id",
      );
    }
    map.set(parsed.data.keyId, parsed.data);
  }
  return map;
}

/** Verifies one envelope against any active key id, allowing safe overlap during signing-key rotation. */
export function verifySignedCloudAuthorizationSnapshot(
  value: unknown,
  trustedKeys: readonly CloudAuthorizationTrustedKey[],
  verificationTime = Date.now(),
): SignedCloudAuthorizationSnapshot {
  if (!Number.isSafeInteger(verificationTime) || verificationTime < 0) {
    throw new Error("invalid cloud authorization verification time");
  }
  const parsed = SignedCloudAuthorizationSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new CloudAuthorizationVerificationError("INVALID_ENVELOPE", "cloud authorization envelope is invalid");
  }
  const envelope = parsed.data;
  const key = trustedKeyMap(trustedKeys).get(envelope.keyId);
  if (!key) throw new CloudAuthorizationVerificationError("UNKNOWN_KEY", "cloud authorization signing key is unknown");
  if (key.algorithm !== envelope.algorithm) {
    throw new CloudAuthorizationVerificationError(
      "ALGORITHM_MISMATCH",
      "cloud authorization signature algorithm does not match its trusted key",
    );
  }
  if (key.trustExpiresAt !== undefined && verificationTime >= key.trustExpiresAt) {
    throw new CloudAuthorizationVerificationError(
      "TRUST_EXPIRED",
      "cloud authorization keyset trust has expired and must be re-enrolled",
    );
  }
  if (
    (key.notBefore !== undefined && envelope.snapshot.issuedAt < key.notBefore) ||
    (key.notAfter !== undefined &&
      (envelope.snapshot.issuedAt > key.notAfter || envelope.snapshot.expiresAt > key.notAfter))
  ) {
    throw new CloudAuthorizationVerificationError(
      "KEY_NOT_ACTIVE",
      "cloud authorization signing key was not active at issue time",
    );
  }

  let publicKey;
  try {
    const der = Buffer.from(key.publicKey, "base64url");
    if (der.length === 0 || der.length > 256 || der.toString("base64url") !== key.publicKey) throw new Error();
    publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error();
  } catch {
    throw new CloudAuthorizationVerificationError(
      "INVALID_PUBLIC_KEY",
      "cloud authorization public key must be an Ed25519 SPKI key",
    );
  }

  const signature = Buffer.from(envelope.signature, "base64url");
  if (
    !cryptoVerify(
      null,
      cloudAuthorizationSnapshotSigningPayload(envelope.snapshot, envelope.keyId),
      publicKey,
      signature,
    )
  ) {
    throw new CloudAuthorizationVerificationError("INVALID_SIGNATURE", "cloud authorization signature is invalid");
  }
  return envelope;
}
