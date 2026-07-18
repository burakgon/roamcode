import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";
import {
  CLOUD_AUTHORIZATION_CONTRACT_VERSION,
  CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2,
  canonicalCloudJson,
  type CloudAuthorizationTrustedKey,
} from "./cloud-contract.js";

export const CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN = "roamcode-cloud-authorization-keyset-v1";
export const CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN_V2 = "roamcode-cloud-authorization-keyset-v2";
export const CLOUD_AUTHORIZATION_KEYSET_PATH = "/api/v1/meta/authorization-keyset";
export const CLOUD_KEYSET_CLOCK_SKEW_MS = 5 * 60_000;
export const CLOUD_AUTHORIZATION_MAX_KEYSET_TTL_MS = 24 * 60 * 60_000;

const SafeIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);
const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Base64UrlSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/);

export const CloudAuthorizationKeysetKeyV1Schema = z
  .object({
    keyId: SafeIdentifierSchema,
    algorithm: z.literal("Ed25519"),
    publicKey: Base64UrlSchema,
    notBefore: TimestampSchema,
    notAfter: TimestampSchema.nullable(),
    status: z.enum(["current", "previous"]),
  })
  .strict()
  .superRefine((key, context) => {
    if (key.notAfter !== null && key.notAfter <= key.notBefore) {
      context.addIssue({ code: "custom", path: ["notAfter"], message: "key expiry must be after activation" });
    }
    if (key.status === "current" && key.notAfter !== null) {
      context.addIssue({ code: "custom", path: ["notAfter"], message: "current key must not be retired" });
    }
    if (key.status === "previous" && key.notAfter === null) {
      context.addIssue({ code: "custom", path: ["notAfter"], message: "previous key must have a retirement time" });
    }
  });

export const CloudAuthorizationKeysetKeyV2Schema = z
  .object({
    keyId: SafeIdentifierSchema,
    algorithm: z.literal(CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2),
    publicKey: Base64UrlSchema,
    notBefore: TimestampSchema,
    notAfter: TimestampSchema.nullable(),
    status: z.enum(["current", "previous"]),
  })
  .strict()
  .superRefine((key, context) => {
    if (key.notAfter !== null && key.notAfter <= key.notBefore) {
      context.addIssue({ code: "custom", path: ["notAfter"], message: "key expiry must be after activation" });
    }
    if (key.status === "current" && key.notAfter !== null) {
      context.addIssue({ code: "custom", path: ["notAfter"], message: "current key must not be retired" });
    }
    if (key.status === "previous" && key.notAfter === null) {
      context.addIssue({ code: "custom", path: ["notAfter"], message: "previous key must have a retirement time" });
    }
  });

export const CloudAuthorizationKeysetV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal("authorization-keyset"),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    keys: z.array(CloudAuthorizationKeysetKeyV1Schema).min(1).max(8),
  })
  .strict()
  .superRefine((keyset, context) => {
    if (keyset.expiresAt <= keyset.issuedAt) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "keyset expiry must follow issue time" });
    }
    if (keyset.expiresAt - keyset.issuedAt > CLOUD_AUTHORIZATION_MAX_KEYSET_TTL_MS) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "keyset lifetime exceeds 24 hours" });
    }
    if (new Set(keyset.keys.map((key) => key.keyId)).size !== keyset.keys.length) {
      context.addIssue({ code: "custom", path: ["keys"], message: "key ids must be unique" });
    }
    if (keyset.keys.filter((key) => key.status === "current").length !== 1) {
      context.addIssue({ code: "custom", path: ["keys"], message: "keyset must contain exactly one current key" });
    }
    keyset.keys.forEach((key, index) => {
      if (key.notBefore > keyset.issuedAt) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "notBefore"],
          message: "key must be active when the keyset is issued",
        });
      }
      if (key.notAfter !== null && key.notAfter < keyset.issuedAt) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "notAfter"],
          message: "previous key must still overlap when the keyset is issued",
        });
      }
    });
  });

export const CloudAuthorizationKeysetV2Schema = z
  .object({
    v: z.literal(CLOUD_AUTHORIZATION_CONTRACT_VERSION),
    kind: z.literal("authorization-keyset"),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    keys: z.array(CloudAuthorizationKeysetKeyV2Schema).min(1).max(8),
  })
  .strict()
  .superRefine((keyset, context) => {
    if (keyset.expiresAt <= keyset.issuedAt) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "keyset expiry must follow issue time" });
    }
    if (keyset.expiresAt - keyset.issuedAt > CLOUD_AUTHORIZATION_MAX_KEYSET_TTL_MS) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "keyset lifetime exceeds 24 hours" });
    }
    if (new Set(keyset.keys.map((key) => key.keyId)).size !== keyset.keys.length) {
      context.addIssue({ code: "custom", path: ["keys"], message: "key ids must be unique" });
    }
    if (keyset.keys.filter((key) => key.status === "current").length !== 1) {
      context.addIssue({ code: "custom", path: ["keys"], message: "keyset must contain exactly one current key" });
    }
    keyset.keys.forEach((key, index) => {
      if (key.notBefore > keyset.issuedAt) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "notBefore"],
          message: "key must be active when the keyset is issued",
        });
      }
      if (key.notAfter !== null && key.notAfter < keyset.issuedAt) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "notAfter"],
          message: "previous key must still overlap when the keyset is issued",
        });
      }
    });
  });

export const CloudAuthorizationKeysetSchema = z.discriminatedUnion("v", [
  CloudAuthorizationKeysetV1Schema,
  CloudAuthorizationKeysetV2Schema,
]);

export const SignedCloudAuthorizationKeysetSignatureV1Schema = z
  .object({
    keyId: SafeIdentifierSchema,
    algorithm: z.literal("Ed25519"),
    signature: Base64UrlSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    const signature = Buffer.from(entry.signature, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== entry.signature) {
      context.addIssue({ code: "custom", path: ["signature"], message: "signature must be canonical Ed25519 bytes" });
    }
  });

export const SignedCloudAuthorizationKeysetSignatureV2Schema = z
  .object({
    keyId: SafeIdentifierSchema,
    algorithm: z.literal(CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2),
    signature: Base64UrlSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    const signature = Buffer.from(entry.signature, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== entry.signature) {
      context.addIssue({ code: "custom", path: ["signature"], message: "signature must be canonical Ed25519 bytes" });
    }
  });

export const SignedCloudAuthorizationKeysetV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal("signed-authorization-keyset"),
    keyset: CloudAuthorizationKeysetV1Schema,
    signatures: z.array(SignedCloudAuthorizationKeysetSignatureV1Schema).min(1).max(8),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (new Set(envelope.signatures.map((entry) => entry.keyId)).size !== envelope.signatures.length) {
      context.addIssue({ code: "custom", path: ["signatures"], message: "signature key ids must be unique" });
    }
    const keyIds = new Set(envelope.keyset.keys.map((key) => key.keyId));
    const signatureIds = new Set(envelope.signatures.map((entry) => entry.keyId));
    if (
      envelope.signatures.some((entry) => !keyIds.has(entry.keyId)) ||
      envelope.keyset.keys.some((key) => !signatureIds.has(key.keyId)) ||
      envelope.signatures.length !== envelope.keyset.keys.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["signatures"],
        message: "every active key must cross-sign the keyset exactly once",
      });
    }
  });

export const SignedCloudAuthorizationKeysetV2Schema = z
  .object({
    v: z.literal(CLOUD_AUTHORIZATION_CONTRACT_VERSION),
    kind: z.literal("signed-authorization-keyset"),
    keyset: CloudAuthorizationKeysetV2Schema,
    signatures: z.array(SignedCloudAuthorizationKeysetSignatureV2Schema).min(1).max(8),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (new Set(envelope.signatures.map((entry) => entry.keyId)).size !== envelope.signatures.length) {
      context.addIssue({ code: "custom", path: ["signatures"], message: "signature key ids must be unique" });
    }
    const keyIds = new Set(envelope.keyset.keys.map((key) => key.keyId));
    const signatureIds = new Set(envelope.signatures.map((entry) => entry.keyId));
    if (
      envelope.signatures.some((entry) => !keyIds.has(entry.keyId)) ||
      envelope.keyset.keys.some((key) => !signatureIds.has(key.keyId)) ||
      envelope.signatures.length !== envelope.keyset.keys.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["signatures"],
        message: "every active key must cross-sign the keyset exactly once",
      });
    }
  });

export const SignedCloudAuthorizationKeysetSchema = z.discriminatedUnion("v", [
  SignedCloudAuthorizationKeysetV1Schema,
  SignedCloudAuthorizationKeysetV2Schema,
]);

export type CloudAuthorizationKeysetKeyV1 = z.infer<typeof CloudAuthorizationKeysetKeyV1Schema>;
export type CloudAuthorizationKeysetKeyV2 = z.infer<typeof CloudAuthorizationKeysetKeyV2Schema>;
export type CloudAuthorizationKeysetKey = CloudAuthorizationKeysetKeyV1 | CloudAuthorizationKeysetKeyV2;
export type CloudAuthorizationKeysetV1 = z.infer<typeof CloudAuthorizationKeysetV1Schema>;
export type CloudAuthorizationKeysetV2 = z.infer<typeof CloudAuthorizationKeysetV2Schema>;
export type CloudAuthorizationKeyset = z.infer<typeof CloudAuthorizationKeysetSchema>;
export type SignedCloudAuthorizationKeysetV1 = z.infer<typeof SignedCloudAuthorizationKeysetV1Schema>;
export type SignedCloudAuthorizationKeysetV2 = z.infer<typeof SignedCloudAuthorizationKeysetV2Schema>;
export type SignedCloudAuthorizationKeyset = z.infer<typeof SignedCloudAuthorizationKeysetSchema>;

export type CloudKeysetVerificationErrorCode =
  | "INVALID_KEYSET"
  | "INVALID_PINNED_KEY"
  | "ISSUED_IN_FUTURE"
  | "EXPIRED"
  | "PIN_EXPIRED"
  | "UNTRUSTED_ROTATION"
  | "KEYSET_ROLLBACK";

export class CloudKeysetVerificationError extends Error {
  constructor(readonly code: CloudKeysetVerificationErrorCode) {
    super(
      code === "ISSUED_IN_FUTURE"
        ? "cloud authorization keyset was issued in the future"
        : code === "EXPIRED"
          ? "cloud authorization keyset has expired"
          : code === "PIN_EXPIRED"
            ? "cloud authorization pinned keyset has expired and must be re-enrolled"
            : code === "KEYSET_ROLLBACK"
              ? "cloud authorization keyset would reverse or truncate an accepted rotation"
              : code === "UNTRUSTED_ROTATION"
                ? "cloud authorization keyset rotation is not signed by an existing pin"
                : code === "INVALID_PINNED_KEY"
                  ? "cloud authorization pinned key is invalid"
                  : "cloud authorization keyset is invalid",
    );
    this.name = "CloudKeysetVerificationError";
  }
}

function ed25519PublicKey(value: string, code: CloudKeysetVerificationErrorCode) {
  try {
    const der = Buffer.from(value, "base64url");
    if (der.length === 0 || der.length > 256 || der.toString("base64url") !== value) throw new Error();
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    throw new CloudKeysetVerificationError(code);
  }
}

export function parseCloudAuthorizationKeyset(value: unknown): CloudAuthorizationKeyset {
  const parsed = CloudAuthorizationKeysetSchema.safeParse(value);
  if (!parsed.success) throw new CloudKeysetVerificationError("INVALID_KEYSET");
  for (const key of parsed.data.keys) ed25519PublicKey(key.publicKey, "INVALID_KEYSET");
  return parsed.data;
}

export function cloudAuthorizationKeysetSigningPayload(keyset: unknown): Buffer {
  const validated = parseCloudAuthorizationKeyset(keyset);
  const protectedEnvelope = {
    v: validated.v,
    kind: "signed-authorization-keyset",
    keyset: validated,
  };
  if (validated.v === 1) {
    return Buffer.from(
      `${CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN}\0${canonicalCloudJson(protectedEnvelope)}`,
      "utf8",
    );
  }
  return createHash("sha256")
    .update(CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN_V2, "utf8")
    .update("\0", "utf8")
    .update(canonicalCloudJson(protectedEnvelope), "utf8")
    .digest();
}

export function cloudAuthorizationTrustedKeysFromKeyset(value: unknown): readonly CloudAuthorizationTrustedKey[] {
  const keyset = parseCloudAuthorizationKeyset(value);
  return keyset.keys.map((key) => ({
    keyId: key.keyId,
    algorithm: key.algorithm,
    publicKey: key.publicKey,
    notBefore: key.notBefore,
    ...(key.notAfter === null ? {} : { notAfter: key.notAfter }),
    trustExpiresAt: keyset.expiresAt,
  }));
}

function assertMonotonicKeysetTransition(
  pinned: CloudAuthorizationKeyset,
  next: CloudAuthorizationKeyset,
  now: number,
): void {
  const nextById = new Map(next.keys.map((key) => [key.keyId, key]));
  const pinnedPreviousIds = new Set(pinned.keys.filter((key) => key.status === "previous").map((key) => key.keyId));
  const nextCurrent = next.keys.find((key) => key.status === "current")!;
  if (pinnedPreviousIds.has(nextCurrent.keyId)) {
    throw new CloudKeysetVerificationError("KEYSET_ROLLBACK");
  }
  for (const pin of pinned.keys) {
    const candidate = nextById.get(pin.keyId);
    if (!candidate) {
      if (pin.status === "current" || pin.notAfter === null || now <= pin.notAfter) {
        throw new CloudKeysetVerificationError("KEYSET_ROLLBACK");
      }
      continue;
    }
    if (
      candidate.algorithm !== pin.algorithm ||
      candidate.publicKey !== pin.publicKey ||
      candidate.notBefore !== pin.notBefore
    ) {
      throw new CloudKeysetVerificationError("KEYSET_ROLLBACK");
    }
    if (pin.status === "previous") {
      if (candidate.status !== "previous" || candidate.notAfter !== pin.notAfter) {
        throw new CloudKeysetVerificationError("KEYSET_ROLLBACK");
      }
      continue;
    }
    if (candidate.status === "previous" && (candidate.notAfter === null || candidate.notAfter < now)) {
      throw new CloudKeysetVerificationError("KEYSET_ROLLBACK");
    }
  }
}

export function verifySignedCloudAuthorizationKeyset(
  value: unknown,
  pinnedKeysetValue: unknown,
  now = Date.now(),
  clockSkewMs = CLOUD_KEYSET_CLOCK_SKEW_MS,
): SignedCloudAuthorizationKeyset {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) {
    throw new Error("invalid cloud keyset verification clock");
  }
  const envelope = SignedCloudAuthorizationKeysetSchema.safeParse(value);
  if (!envelope.success) throw new CloudKeysetVerificationError("INVALID_KEYSET");
  const keyset = parseCloudAuthorizationKeyset(envelope.data.keyset);
  if (keyset.issuedAt > now + clockSkewMs) throw new CloudKeysetVerificationError("ISSUED_IN_FUTURE");
  if (keyset.expiresAt <= now) throw new CloudKeysetVerificationError("EXPIRED");
  const pins = parseCloudAuthorizationKeyset(pinnedKeysetValue);
  if (keyset.v !== pins.v) throw new CloudKeysetVerificationError("UNTRUSTED_ROTATION");
  if (pins.issuedAt > now + clockSkewMs) throw new CloudKeysetVerificationError("INVALID_PINNED_KEY");
  if (pins.expiresAt <= now) throw new CloudKeysetVerificationError("PIN_EXPIRED");
  const signatures = new Map(envelope.data.signatures.map((entry) => [entry.keyId, entry]));
  const payload = cloudAuthorizationKeysetSigningPayload(keyset);
  const trusted = pins.keys.some((pin) => {
    const signature = signatures.get(pin.keyId);
    if (!signature || signature.algorithm !== pin.algorithm) return false;
    if (now < pin.notBefore || (pin.notAfter !== null && now > pin.notAfter)) return false;
    const key = ed25519PublicKey(pin.publicKey, "INVALID_PINNED_KEY");
    return cryptoVerify(null, payload, key, Buffer.from(signature.signature, "base64url"));
  });
  if (!trusted) throw new CloudKeysetVerificationError("UNTRUSTED_ROTATION");
  assertMonotonicKeysetTransition(pins, keyset, now);
  return envelope.data;
}
