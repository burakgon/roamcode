import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM,
  CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2,
  CLOUD_CONTRACT_VERSION,
  cloudAuthorizationSnapshotSigningPayload,
  type CloudAuthorizationSnapshotV1,
  type CloudAuthorizationSnapshotV2,
  type CloudAuthorizationTrustedKey,
  type SignedCloudAuthorizationSnapshotV1,
  type SignedCloudAuthorizationSnapshotV2,
} from "../../src/cloud-contract.js";
import {
  cloudAuthorizationKeysetSigningPayload,
  type CloudAuthorizationKeysetKeyV1,
  type CloudAuthorizationKeysetV1,
  type CloudAuthorizationKeysetKeyV2,
  type CloudAuthorizationKeysetV2,
  type SignedCloudAuthorizationKeysetV1,
  type SignedCloudAuthorizationKeysetV2,
} from "../../src/cloud-keyset.js";

export interface CloudSigningFixture {
  privateKey: KeyObject;
  trustedKey: CloudAuthorizationTrustedKey;
}

export function cloudSigningFixture(
  keyId = "cloud-key-a",
  validity: Pick<CloudAuthorizationTrustedKey, "notBefore" | "notAfter"> = {},
): CloudSigningFixture {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    trustedKey: {
      keyId,
      algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM,
      publicKey: Buffer.from(pair.publicKey.export({ type: "spki", format: "der" })).toString("base64url"),
      ...validity,
    },
  };
}

export function cloudAuthorizationSnapshot(
  overrides: Partial<CloudAuthorizationSnapshotV1> = {},
): CloudAuthorizationSnapshotV1 {
  return {
    v: CLOUD_CONTRACT_VERSION,
    kind: "authorization-snapshot",
    organizationId: "organization-1",
    hostId: "host-1",
    revision: 1,
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 10_000,
    grants: [
      {
        principalType: "device",
        principalId: "device-1",
        permissions: ["sessions:read", "sessions:operate"],
        scope: { type: "organization" },
      },
    ],
    ...overrides,
  };
}

export function signCloudAuthorizationSnapshot(
  snapshot: CloudAuthorizationSnapshotV1,
  fixture: CloudSigningFixture,
): SignedCloudAuthorizationSnapshotV1 {
  return {
    v: CLOUD_CONTRACT_VERSION,
    kind: "signed-authorization-snapshot",
    algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM,
    keyId: fixture.trustedKey.keyId,
    snapshot,
    signature: sign(
      null,
      cloudAuthorizationSnapshotSigningPayload(snapshot, fixture.trustedKey.keyId),
      fixture.privateKey,
    ).toString("base64url"),
  };
}

export function cloudAuthorizationSnapshotV2(
  overrides: Partial<CloudAuthorizationSnapshotV2> = {},
): CloudAuthorizationSnapshotV2 {
  return {
    v: 2,
    kind: "authorization-snapshot",
    organizationId: "organization-1",
    hostId: "host-1",
    revision: 1,
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 10_000,
    grants: [
      {
        principalType: "device",
        principalId: "device-1",
        permissions: ["sessions:read", "sessions:operate"],
        scope: { type: "organization" },
      },
    ],
    ...overrides,
  };
}

export function signCloudAuthorizationSnapshotV2(
  snapshot: CloudAuthorizationSnapshotV2,
  fixture: CloudSigningFixture,
): SignedCloudAuthorizationSnapshotV2 {
  const trustedKey = { ...fixture.trustedKey, algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2 } as const;
  return {
    v: 2,
    kind: "signed-authorization-snapshot",
    algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2,
    keyId: trustedKey.keyId,
    snapshot,
    signature: sign(
      null,
      cloudAuthorizationSnapshotSigningPayload(snapshot, trustedKey.keyId),
      fixture.privateKey,
    ).toString("base64url"),
  };
}

export function cloudTrustedKeyV2(fixture: CloudSigningFixture): CloudAuthorizationTrustedKey {
  return { ...fixture.trustedKey, algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2 };
}

export function cloudAuthorizationKeysetKey(
  fixture: CloudSigningFixture,
  options: {
    status: "current" | "previous";
    notBefore?: number;
    notAfter?: number | null;
  },
): CloudAuthorizationKeysetKeyV1 {
  return {
    keyId: fixture.trustedKey.keyId,
    algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM,
    publicKey: fixture.trustedKey.publicKey,
    notBefore: options.notBefore ?? 0,
    notAfter: options.notAfter ?? (options.status === "current" ? null : 10_000),
    status: options.status,
  };
}

export function cloudAuthorizationKeyset(
  keys: CloudAuthorizationKeysetKeyV1[],
  overrides: Partial<CloudAuthorizationKeysetV1> = {},
): CloudAuthorizationKeysetV1 {
  return {
    v: CLOUD_CONTRACT_VERSION,
    kind: "authorization-keyset",
    issuedAt: 1_000,
    expiresAt: 10_000,
    keys,
    ...overrides,
  };
}

export function signCloudAuthorizationKeyset(
  keyset: CloudAuthorizationKeysetV1,
  fixtures: readonly CloudSigningFixture[],
): SignedCloudAuthorizationKeysetV1 {
  return {
    v: CLOUD_CONTRACT_VERSION,
    kind: "signed-authorization-keyset",
    keyset,
    signatures: fixtures.map((fixture) => ({
      keyId: fixture.trustedKey.keyId,
      algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM,
      signature: sign(null, cloudAuthorizationKeysetSigningPayload(keyset), fixture.privateKey).toString("base64url"),
    })),
  };
}

export function cloudAuthorizationKeysetKeyV2(
  fixture: CloudSigningFixture,
  options: {
    status: "current" | "previous";
    notBefore?: number;
    notAfter?: number | null;
  },
): CloudAuthorizationKeysetKeyV2 {
  return {
    keyId: fixture.trustedKey.keyId,
    algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2,
    publicKey: fixture.trustedKey.publicKey,
    notBefore: options.notBefore ?? 0,
    notAfter: options.notAfter ?? (options.status === "current" ? null : 10_000),
    status: options.status,
  };
}

export function cloudAuthorizationKeysetV2(
  keys: CloudAuthorizationKeysetKeyV2[],
  overrides: Partial<CloudAuthorizationKeysetV2> = {},
): CloudAuthorizationKeysetV2 {
  return {
    v: 2,
    kind: "authorization-keyset",
    issuedAt: 1_000,
    expiresAt: 10_000,
    keys,
    ...overrides,
  };
}

export function signCloudAuthorizationKeysetV2(
  keyset: CloudAuthorizationKeysetV2,
  fixtures: readonly CloudSigningFixture[],
): SignedCloudAuthorizationKeysetV2 {
  return {
    v: 2,
    kind: "signed-authorization-keyset",
    keyset,
    signatures: fixtures.map((fixture) => ({
      keyId: fixture.trustedKey.keyId,
      algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2,
      signature: sign(null, cloudAuthorizationKeysetSigningPayload(keyset), fixture.privateKey).toString("base64url"),
    })),
  };
}
