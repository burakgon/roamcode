import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2,
  CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN_V2,
  CLOUD_CONTRACT_VERSION,
  CloudAuthorizationVerificationError,
  canonicalCloudJson,
  cloudAuthorizationSnapshotSigningPayload,
  parseCloudAuthorizationSnapshot,
  parseCloudHostHeartbeat,
  verifySignedCloudAuthorizationSnapshot,
} from "../src/cloud-contract.js";
import {
  cloudAuthorizationSnapshot,
  cloudAuthorizationSnapshotV2,
  cloudSigningFixture,
  cloudTrustedKeyV2,
  signCloudAuthorizationSnapshot,
  signCloudAuthorizationSnapshotV2,
} from "./helpers/cloud-authorization.js";
import { generateRelayIdentity } from "../src/relay-crypto.js";

describe("cloud host contracts", () => {
  test("accepts a privacy-minimal versioned heartbeat and rejects uncontracted host data", () => {
    const relayIdentity = generateRelayIdentity();
    const heartbeat = {
      v: CLOUD_CONTRACT_VERSION,
      kind: "host-heartbeat",
      organizationId: "organization-1",
      hostId: "host-1",
      instanceId: "boot-1",
      sentAt: 1_000,
      sequence: 4,
      softwareVersion: "2.0.0-beta.1",
      state: "ready",
      authorizationRevision: 7,
      relayHostIdentity: { publicKey: relayIdentity.publicKey, fingerprint: relayIdentity.fingerprint },
      capabilities: ["relay-v1", "authorization-snapshot-v1"],
    } as const;
    expect(parseCloudHostHeartbeat(heartbeat)).toEqual(heartbeat);
    expect(() => parseCloudHostHeartbeat({ ...heartbeat, cwd: "/private/project" })).toThrow();
    expect(() => parseCloudHostHeartbeat({ ...heartbeat, capabilities: ["relay-v1", "relay-v1"] })).toThrow();
    expect(() =>
      parseCloudHostHeartbeat({
        ...heartbeat,
        relayHostIdentity: { ...heartbeat.relayHostIdentity, fingerprint: `sha256:${"x".repeat(43)}` },
      }),
    ).toThrow();
  });

  test("strictly validates snapshot lifetimes, grants, scopes, and permissions", () => {
    const snapshot = cloudAuthorizationSnapshot({
      grants: [
        {
          principalType: "device",
          principalId: "device-1",
          permissions: ["sessions:read"],
          scope: { type: "workspace", id: "workspace-1" },
        },
      ],
    });
    expect(parseCloudAuthorizationSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseCloudAuthorizationSnapshot({ ...snapshot, expiresAt: snapshot.issuedAt })).toThrow();
    expect(() =>
      parseCloudAuthorizationSnapshot({ ...snapshot, expiresAt: snapshot.issuedAt + 60 * 60_000 + 1 }),
    ).toThrow();
    expect(() =>
      parseCloudAuthorizationSnapshot({
        ...snapshot,
        grants: [{ ...snapshot.grants[0], permissions: ["sessions:read", "sessions:read"] }],
      }),
    ).toThrow();
    expect(() =>
      parseCloudAuthorizationSnapshot({
        ...snapshot,
        grants: [{ ...snapshot.grants[0], permissions: ["terminal:root"] }],
      }),
    ).toThrow();
  });
});

describe("signed cloud authorization snapshots", () => {
  test("verifies Ed25519 bytes and detects any signed payload change", () => {
    const key = cloudSigningFixture();
    const envelope = signCloudAuthorizationSnapshot(cloudAuthorizationSnapshot(), key);
    expect(verifySignedCloudAuthorizationSnapshot(envelope, [key.trustedKey])).toEqual(envelope);
    expect(() =>
      verifySignedCloudAuthorizationSnapshot({ ...envelope, snapshot: { ...envelope.snapshot, hostId: "host-2" } }, [
        key.trustedKey,
      ]),
    ).toThrowError(CloudAuthorizationVerificationError);
    expect(() =>
      verifySignedCloudAuthorizationSnapshot({ ...envelope, keyId: "cloud-key-alias" }, [
        key.trustedKey,
        { ...key.trustedKey, keyId: "cloud-key-alias" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SIGNATURE" }));
  });

  test("supports overlapping key ids during rotation and refuses unknown or inactive keys", () => {
    const oldKey = cloudSigningFixture("key-old", { notBefore: 0, notAfter: 2_000 });
    const nextKey = cloudSigningFixture("key-next", { notBefore: 1_500, notAfter: 20_000 });
    const nextEnvelope = signCloudAuthorizationSnapshot(
      cloudAuthorizationSnapshot({ issuedAt: 1_600, notBefore: 1_600 }),
      nextKey,
    );
    expect(verifySignedCloudAuthorizationSnapshot(nextEnvelope, [oldKey.trustedKey, nextKey.trustedKey])).toEqual(
      nextEnvelope,
    );
    expect(() => verifySignedCloudAuthorizationSnapshot(nextEnvelope, [oldKey.trustedKey])).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_KEY" }),
    );

    const earlyEnvelope = signCloudAuthorizationSnapshot(
      cloudAuthorizationSnapshot({ issuedAt: 1_400, notBefore: 1_400 }),
      nextKey,
    );
    expect(() =>
      verifySignedCloudAuthorizationSnapshot(earlyEnvelope, [oldKey.trustedKey, nextKey.trustedKey]),
    ).toThrowError(expect.objectContaining({ code: "KEY_NOT_ACTIVE" }));

    const beforeRetirement = signCloudAuthorizationSnapshot(
      cloudAuthorizationSnapshot({ issuedAt: 1_999, notBefore: 1_999, expiresAt: 2_000 }),
      oldKey,
    );
    expect(() => verifySignedCloudAuthorizationSnapshot(beforeRetirement, [oldKey.trustedKey])).not.toThrow();
    const retirementBoundary = signCloudAuthorizationSnapshot(
      cloudAuthorizationSnapshot({ issuedAt: 2_000, notBefore: 2_000, expiresAt: 2_001 }),
      oldKey,
    );
    expect(() => verifySignedCloudAuthorizationSnapshot(retirementBoundary, [oldKey.trustedKey])).toThrowError(
      expect.objectContaining({ code: "KEY_NOT_ACTIVE" }),
    );
    const afterRetirement = signCloudAuthorizationSnapshot(
      cloudAuthorizationSnapshot({ issuedAt: 2_001, notBefore: 2_001 }),
      oldKey,
    );
    expect(() => verifySignedCloudAuthorizationSnapshot(afterRetirement, [oldKey.trustedKey])).toThrowError(
      expect.objectContaining({ code: "KEY_NOT_ACTIVE" }),
    );
  });

  test("rejects malformed keyrings instead of selecting an ambiguous duplicate id", () => {
    const key = cloudSigningFixture();
    const other = cloudSigningFixture(key.trustedKey.keyId);
    const envelope = signCloudAuthorizationSnapshot(cloudAuthorizationSnapshot(), key);
    expect(() => verifySignedCloudAuthorizationSnapshot(envelope, [key.trustedKey, other.trustedKey])).toThrowError(
      expect.objectContaining({ code: "INVALID_KEYRING" }),
    );
  });

  test("verifies V2 over exactly the domain-separated SHA-256 digest while preserving V1 raw signatures", () => {
    const key = cloudSigningFixture("key-v2");
    const snapshot = cloudAuthorizationSnapshotV2();
    const payload = cloudAuthorizationSnapshotSigningPayload(snapshot, key.trustedKey.keyId);
    const protectedEnvelope = {
      v: 2,
      kind: "signed-authorization-snapshot",
      algorithm: CLOUD_AUTHORIZATION_SIGNATURE_ALGORITHM_V2,
      keyId: key.trustedKey.keyId,
      snapshot,
    };
    const expected = createHash("sha256")
      .update(`${CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN_V2}\0${canonicalCloudJson(protectedEnvelope)}`, "utf8")
      .digest();
    expect(payload).toEqual(expected);
    expect(payload).toHaveLength(32);

    const envelope = signCloudAuthorizationSnapshotV2(snapshot, key);
    expect(verifySignedCloudAuthorizationSnapshot(envelope, [cloudTrustedKeyV2(key)])).toEqual(envelope);
    expect(
      cloudAuthorizationSnapshotSigningPayload(cloudAuthorizationSnapshot(), key.trustedKey.keyId).length,
    ).toBeGreaterThan(32);
    expect(
      cloudAuthorizationSnapshotSigningPayload(
        {
          v: 2,
          kind: "authorization-snapshot",
          organizationId: "org-1",
          hostId: "host-1",
          revision: 7,
          issuedAt: 1_000,
          notBefore: 1_000,
          expiresAt: 2_000,
          grants: [],
        },
        "key-1",
      ).toString("hex"),
    ).toBe("5eed8d9adccf338ecc6e8fa7e70e1040f01005e9e1a8858b2ea85d78707dfe8e");
  });

  test("never accepts a V1/V2 algorithm downgrade even when the Ed25519 key bytes are identical", () => {
    const key = cloudSigningFixture("shared-key-id");
    const v2 = signCloudAuthorizationSnapshotV2(cloudAuthorizationSnapshotV2(), key);
    expect(() => verifySignedCloudAuthorizationSnapshot(v2, [key.trustedKey])).toThrowError(
      expect.objectContaining({ code: "ALGORITHM_MISMATCH" }),
    );
    expect(() =>
      verifySignedCloudAuthorizationSnapshot({ ...v2, v: 1, algorithm: "Ed25519" }, [cloudTrustedKeyV2(key)]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });
});
