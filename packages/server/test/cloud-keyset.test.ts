import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { canonicalCloudJson } from "../src/cloud-contract.js";
import {
  CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN,
  CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN_V2,
  CloudKeysetVerificationError,
  cloudAuthorizationKeysetSigningPayload,
  cloudAuthorizationTrustedKeysFromKeyset,
  parseCloudAuthorizationKeyset,
  verifySignedCloudAuthorizationKeyset,
} from "../src/cloud-keyset.js";
import {
  cloudAuthorizationKeyset,
  cloudAuthorizationKeysetKey,
  cloudAuthorizationKeysetKeyV2,
  cloudAuthorizationKeysetV2,
  cloudSigningFixture,
  signCloudAuthorizationKeyset,
  signCloudAuthorizationKeysetV2,
} from "./helpers/cloud-authorization.js";

describe("cloud authorization keyset", () => {
  test("verifies a cross-signed rotation and exposes both overlap keys to snapshot verification", () => {
    const oldKey = cloudSigningFixture("key-old");
    const newKey = cloudSigningFixture("key-new");
    const pinned = cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(oldKey, { status: "current" })]);
    const rotated = cloudAuthorizationKeyset(
      [
        cloudAuthorizationKeysetKey(oldKey, { status: "previous", notAfter: 5_000 }),
        cloudAuthorizationKeysetKey(newKey, { status: "current", notBefore: 2_000 }),
      ],
      { issuedAt: 2_000, expiresAt: 12_000 },
    );

    const verified = verifySignedCloudAuthorizationKeyset(
      signCloudAuthorizationKeyset(rotated, [oldKey, newKey]),
      pinned,
      2_000,
    );
    expect(verified.keyset).toEqual(rotated);
    expect(cloudAuthorizationTrustedKeysFromKeyset(rotated)).toEqual([
      expect.objectContaining({ keyId: "key-old", notAfter: 5_000 }),
      expect.objectContaining({ keyId: "key-new", notBefore: 2_000 }),
    ]);
  });

  test("uses exact domain-separated canonical bytes and accepts the retirement boundary inclusively", () => {
    const retiring = cloudSigningFixture("key-retiring");
    const next = cloudSigningFixture("key-next");
    const pinned = cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(retiring, { status: "current" })]);
    const rotated = cloudAuthorizationKeyset(
      [
        cloudAuthorizationKeysetKey(retiring, { status: "previous", notAfter: 2_000 }),
        cloudAuthorizationKeysetKey(next, { status: "current", notBefore: 2_000 }),
      ],
      { issuedAt: 2_000, expiresAt: 12_000 },
    );
    const envelope = signCloudAuthorizationKeyset(rotated, [retiring, next]);

    expect(cloudAuthorizationKeysetSigningPayload(rotated).toString("utf8")).toMatch(
      new RegExp(`^${CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN}\\u0000\\{`),
    );
    expect(() => verifySignedCloudAuthorizationKeyset(envelope, pinned, 2_000)).not.toThrow();
  });

  test("rejects unknown signers, tampering, stale envelopes, and invalid key shapes", () => {
    const trusted = cloudSigningFixture("key-trusted");
    const unknown = cloudSigningFixture("key-unknown");
    const next = cloudSigningFixture("key-next");
    const pinned = cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(trusted, { status: "current" })]);
    const rotated = cloudAuthorizationKeyset(
      [
        cloudAuthorizationKeysetKey(trusted, { status: "previous", notAfter: 3_000 }),
        cloudAuthorizationKeysetKey(next, { status: "current", notBefore: 2_000 }),
      ],
      { issuedAt: 2_000, expiresAt: 4_000 },
    );
    const unknownOnly = cloudAuthorizationKeyset(
      [cloudAuthorizationKeysetKey(unknown, { status: "current", notBefore: 2_000 })],
      { issuedAt: 2_000, expiresAt: 4_000 },
    );

    expect(() =>
      verifySignedCloudAuthorizationKeyset(signCloudAuthorizationKeyset(unknownOnly, [unknown]), pinned, 2_000),
    ).toThrowError(expect.objectContaining({ code: "UNTRUSTED_ROTATION" }));

    const tampered = signCloudAuthorizationKeyset(rotated, [trusted, next]);
    tampered.keyset.expiresAt += 1;
    expect(() => verifySignedCloudAuthorizationKeyset(tampered, pinned, 2_000)).toThrowError(
      expect.objectContaining({ code: "UNTRUSTED_ROTATION" }),
    );
    expect(() =>
      verifySignedCloudAuthorizationKeyset(signCloudAuthorizationKeyset(rotated, [trusted, next]), pinned, 4_001),
    ).toThrowError(expect.objectContaining({ code: "EXPIRED" }));
    expect(() =>
      parseCloudAuthorizationKeyset({
        ...pinned,
        keys: [{ ...pinned.keys[0], publicKey: "not-an-ed25519-key" }],
      }),
    ).toThrowError(CloudKeysetVerificationError);
  });

  test("requires one current key and finite retirement windows for previous keys", () => {
    const key = cloudSigningFixture();
    expect(() =>
      parseCloudAuthorizationKeyset(
        cloudAuthorizationKeyset([{ ...cloudAuthorizationKeysetKey(key, { status: "current" }), notAfter: 2_000 }]),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_KEYSET" }));
    expect(() =>
      parseCloudAuthorizationKeyset(
        cloudAuthorizationKeyset([{ ...cloudAuthorizationKeysetKey(key, { status: "previous" }), notAfter: null }]),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_KEYSET" }));
  });

  test("rejects backdating with an expired retired pin at and after its inclusive boundary", () => {
    const oldKey = cloudSigningFixture("key-old");
    const newKey = cloudSigningFixture("key-new");
    const pinned = cloudAuthorizationKeyset(
      [
        cloudAuthorizationKeysetKey(oldKey, { status: "previous", notAfter: 2_000 }),
        cloudAuthorizationKeysetKey(newKey, { status: "current", notBefore: 1_500 }),
      ],
      { issuedAt: 1_500, expiresAt: 10_000 },
    );
    const staleReplica = cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(oldKey, { status: "current" })], {
      issuedAt: 2_000,
      expiresAt: 4_000,
    });
    const envelope = signCloudAuthorizationKeyset(staleReplica, [oldKey]);

    expect(() => verifySignedCloudAuthorizationKeyset(envelope, pinned, 2_000)).toThrowError(
      expect.objectContaining({ code: "KEYSET_ROLLBACK" }),
    );
    expect(() => verifySignedCloudAuthorizationKeyset(envelope, pinned, 2_001)).toThrowError(
      expect.objectContaining({ code: "UNTRUSTED_ROTATION" }),
    );
  });

  test("rejects current-key reversal and premature overlap removal but permits removal after retirement", () => {
    const oldKey = cloudSigningFixture("key-old");
    const newKey = cloudSigningFixture("key-new");
    const pinned = cloudAuthorizationKeyset(
      [
        cloudAuthorizationKeysetKey(oldKey, { status: "previous", notAfter: 5_000 }),
        cloudAuthorizationKeysetKey(newKey, { status: "current", notBefore: 2_000 }),
      ],
      { issuedAt: 2_000, expiresAt: 10_000 },
    );
    const staleReplica = cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(oldKey, { status: "current" })], {
      issuedAt: 3_000,
      expiresAt: 9_000,
    });
    expect(() =>
      verifySignedCloudAuthorizationKeyset(signCloudAuthorizationKeyset(staleReplica, [oldKey]), pinned, 3_000),
    ).toThrowError(expect.objectContaining({ code: "KEYSET_ROLLBACK" }));

    const newOnlyEarly = cloudAuthorizationKeyset(
      [cloudAuthorizationKeysetKey(newKey, { status: "current", notBefore: 2_000 })],
      { issuedAt: 3_000, expiresAt: 9_000 },
    );
    expect(() =>
      verifySignedCloudAuthorizationKeyset(signCloudAuthorizationKeyset(newOnlyEarly, [newKey]), pinned, 3_000),
    ).toThrowError(expect.objectContaining({ code: "KEYSET_ROLLBACK" }));

    const newOnlyAfterRetirement = cloudAuthorizationKeyset(
      [cloudAuthorizationKeysetKey(newKey, { status: "current", notBefore: 2_000 })],
      { issuedAt: 5_001, expiresAt: 9_000 },
    );
    expect(() =>
      verifySignedCloudAuthorizationKeyset(
        signCloudAuthorizationKeyset(newOnlyAfterRetirement, [newKey]),
        pinned,
        5_001,
      ),
    ).not.toThrow();
  });

  test("fails closed after the pinned keyset expires and requires protected re-enrollment", () => {
    const current = cloudSigningFixture("key-current");
    const pinned = cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(current, { status: "current" })], {
      issuedAt: 1_000,
      expiresAt: 2_000,
    });
    const renewal = cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(current, { status: "current" })], {
      issuedAt: 2_001,
      expiresAt: 3_000,
    });
    expect(() =>
      verifySignedCloudAuthorizationKeyset(signCloudAuthorizationKeyset(renewal, [current]), pinned, 2_001),
    ).toThrowError(expect.objectContaining({ code: "PIN_EXPIRED" }));
  });

  test("cross-signs V2 rotations over the exact 32-byte domain-separated digest", () => {
    const oldKey = cloudSigningFixture("key-v2-old");
    const newKey = cloudSigningFixture("key-v2-new");
    const pinned = cloudAuthorizationKeysetV2([cloudAuthorizationKeysetKeyV2(oldKey, { status: "current" })]);
    const rotated = cloudAuthorizationKeysetV2(
      [
        cloudAuthorizationKeysetKeyV2(oldKey, { status: "previous", notAfter: 5_000 }),
        cloudAuthorizationKeysetKeyV2(newKey, { status: "current", notBefore: 2_000 }),
      ],
      { issuedAt: 2_000, expiresAt: 12_000 },
    );
    const payload = cloudAuthorizationKeysetSigningPayload(rotated);
    const expected = createHash("sha256")
      .update(
        `${CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN_V2}\0${canonicalCloudJson({
          v: 2,
          kind: "signed-authorization-keyset",
          keyset: rotated,
        })}`,
        "utf8",
      )
      .digest();
    expect(payload).toEqual(expected);
    expect(payload).toHaveLength(32);
    expect(
      cloudAuthorizationKeysetSigningPayload({
        v: 2,
        kind: "authorization-keyset",
        issuedAt: 1_000,
        expiresAt: 2_000,
        keys: [
          {
            keyId: "key-1",
            algorithm: "Ed25519-SHA256",
            publicKey: "MCowBQYDK2VwAyEACq0g54_RuuyYsloEbojLoKGmROnt-H8JZId9cAW-1XQ",
            notBefore: 0,
            notAfter: null,
            status: "current",
          },
        ],
      }).toString("hex"),
    ).toBe("ae909c58597ec59b93c7b3759204c099e099f8e10ad552cd6e42d7c9858961a2");
    expect(
      verifySignedCloudAuthorizationKeyset(signCloudAuthorizationKeysetV2(rotated, [oldKey, newKey]), pinned, 2_000)
        .keyset,
    ).toEqual(rotated);
  });

  test("rejects a cross-version keyset response instead of silently downgrading a V2 pin", () => {
    const key = cloudSigningFixture("same-key");
    const pinnedV2 = cloudAuthorizationKeysetV2([cloudAuthorizationKeysetKeyV2(key, { status: "current" })]);
    const nextV1 = cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(key, { status: "current" })], {
      issuedAt: 2_000,
      expiresAt: 12_000,
    });
    expect(() =>
      verifySignedCloudAuthorizationKeyset(signCloudAuthorizationKeyset(nextV1, [key]), pinnedV2, 2_000),
    ).toThrowError(expect.objectContaining({ code: "UNTRUSTED_ROTATION" }));
  });
});
