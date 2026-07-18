import { chmodSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  CLOUD_AUTHORIZATION_FILE,
  CLOUD_AUTHORIZATION_LAST_GOOD_FILE,
  CloudAuthorizationStoreError,
  openCloudAuthorizationStore,
} from "../src/cloud-authorization-store.js";
import type { CloudAuthorizationTrustedKey } from "../src/cloud-contract.js";
import { cloudAuthorizationTrustedKeysFromKeyset } from "../src/cloud-keyset.js";
import {
  cloudAuthorizationKeyset,
  cloudAuthorizationKeysetKey,
  cloudAuthorizationSnapshotV2,
  cloudAuthorizationSnapshot,
  cloudSigningFixture,
  cloudTrustedKeyV2,
  signCloudAuthorizationSnapshot,
  signCloudAuthorizationSnapshotV2,
} from "./helpers/cloud-authorization.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "roamcode-cloud-authorization-"));
  directories.push(directory);
  return directory;
}

function open(
  directory: string,
  trustedKeys: readonly CloudAuthorizationTrustedKey[] | (() => readonly CloudAuthorizationTrustedKey[]),
) {
  return openCloudAuthorizationStore({
    dataDir: directory,
    organizationId: "organization-1",
    hostId: "host-1",
    trustedKeys,
  });
}

describe("cloud authorization store", () => {
  test("persists a verified snapshot atomically and reloads it as last-known-good state", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture();
    const store = open(directory, [key.trustedKey]);
    const envelope = signCloudAuthorizationSnapshot(cloudAuthorizationSnapshot(), key);
    expect(store.apply(envelope, 1_000).snapshot.revision).toBe(1);
    expect(store.getState(1_001)).toMatchObject({ status: "active", revision: 1, expiresAt: 10_000 });
    expect(statSync(join(directory, CLOUD_AUTHORIZATION_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    chmodSync(join(directory, CLOUD_AUTHORIZATION_FILE), 0o644);
    const reloaded = open(directory, [key.trustedKey]);
    expect(reloaded.getLastKnownGood()?.snapshot).toEqual(envelope.snapshot);
    if (process.platform !== "win32") {
      expect(statSync(join(directory, CLOUD_AUTHORIZATION_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  test("accepts a rotated key id while rejecting equal, lower, and temporally regressed revisions", async () => {
    const directory = await dataDir();
    const firstKey = cloudSigningFixture("key-a");
    const nextKey = cloudSigningFixture("key-b");
    let keys: readonly CloudAuthorizationTrustedKey[] = [firstKey.trustedKey];
    const store = open(directory, () => keys);
    const first = signCloudAuthorizationSnapshot(cloudAuthorizationSnapshot(), firstKey);
    store.apply(first, 1_000);
    expect(() => store.apply(first, 1_001)).toThrowError(expect.objectContaining({ code: "REPLAY" }));

    keys = [firstKey.trustedKey, nextKey.trustedKey];
    const second = signCloudAuthorizationSnapshot(
      cloudAuthorizationSnapshot({ revision: 2, issuedAt: 2_000, notBefore: 2_000 }),
      nextKey,
    );
    expect(store.apply(second, 2_000).envelope.keyId).toBe("key-b");
    expect(() =>
      store.apply(
        signCloudAuthorizationSnapshot(
          cloudAuthorizationSnapshot({ revision: 3, issuedAt: 1_999, notBefore: 2_000 }),
          nextKey,
        ),
        2_001,
      ),
    ).toThrowError(expect.objectContaining({ code: "TEMPORAL_REGRESSION" }));
  });

  test("rejects invalid target, future, expired, and tampered snapshots without replacing the current revision", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture();
    const store = open(directory, [key.trustedKey]);
    store.apply(signCloudAuthorizationSnapshot(cloudAuthorizationSnapshot(), key), 1_000);

    expect(() =>
      store.apply(
        signCloudAuthorizationSnapshot(cloudAuthorizationSnapshot({ hostId: "host-2", revision: 2 }), key),
        1_100,
      ),
    ).toThrowError(expect.objectContaining({ code: "TARGET_MISMATCH" }));
    expect(() =>
      store.apply(
        signCloudAuthorizationSnapshot(
          cloudAuthorizationSnapshot({ revision: 2, issuedAt: 1_000_000, notBefore: 1_000_000, expiresAt: 2_000_000 }),
          key,
        ),
        1_100,
      ),
    ).toThrowError(expect.objectContaining({ code: "ISSUED_IN_FUTURE" }));
    expect(() =>
      store.apply(
        signCloudAuthorizationSnapshot(
          cloudAuthorizationSnapshot({ revision: 2, issuedAt: 1_050, notBefore: 1_050, expiresAt: 1_099 }),
          key,
        ),
        1_100,
      ),
    ).toThrowError(expect.objectContaining({ code: "EXPIRED" }));

    const tampered = signCloudAuthorizationSnapshot(
      cloudAuthorizationSnapshot({ revision: 2, issuedAt: 1_100, notBefore: 1_100 }),
      key,
    );
    tampered.snapshot.grants = [];
    expect(() => store.apply(tampered, 1_100)).toThrow();
    expect(store.getLastKnownGood()?.snapshot.revision).toBe(1);
    expect(open(directory, [key.trustedKey]).getLastKnownGood()?.snapshot.revision).toBe(1);
  });

  test("retains an expired snapshot as a replay floor while refusing to authorize from it", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture();
    const envelope = signCloudAuthorizationSnapshot(cloudAuthorizationSnapshot({ expiresAt: 1_500 }), key);
    const store = open(directory, [key.trustedKey]);
    store.apply(envelope, 1_000);
    expect(store.getState(1_500)).toMatchObject({ status: "expired", revision: 1 });
    expect(store.getActiveSnapshot(1_500)).toBeUndefined();
    expect(store.authorize("device", "device-1", "sessions:read", undefined, 1_500)).toMatchObject({
      allowed: false,
      reason: "cloud-authorization-expired",
      revision: 1,
    });

    const reloaded = open(directory, [key.trustedKey]);
    expect(reloaded.getState(2_000).status).toBe("expired");
    expect(() => reloaded.apply(envelope, 2_000)).toThrowError(expect.objectContaining({ code: "REPLAY" }));
  });

  test("persists a near-future snapshot during clock skew but keeps it inactive until not-before", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture();
    const store = open(directory, [key.trustedKey]);
    store.apply(
      signCloudAuthorizationSnapshot(
        cloudAuthorizationSnapshot({ issuedAt: 1_000, notBefore: 1_200, expiresAt: 2_000 }),
        key,
      ),
      1_000,
    );
    expect(store.getState(1_100)).toMatchObject({ status: "pending", revision: 1 });
    expect(store.authorize("device", "device-1", "sessions:read", undefined, 1_100)).toMatchObject({
      allowed: false,
      reason: "cloud-authorization-pending",
    });
    expect(store.getState(1_200).status).toBe("active");
  });

  test("expires keyset trust fail-closed and recovers only after a protected keyset replacement", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture("key-a");
    let trustedKeys = cloudAuthorizationTrustedKeysFromKeyset(
      cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(key, { status: "current" })], {
        issuedAt: 1_000,
        expiresAt: 1_500,
      }),
    );
    const store = open(directory, () => trustedKeys);
    store.apply(signCloudAuthorizationSnapshot(cloudAuthorizationSnapshot({ expiresAt: 1_400 }), key), 1_000);

    const afterMissedOverlap = signCloudAuthorizationSnapshot(
      cloudAuthorizationSnapshot({ revision: 2, issuedAt: 2_000, notBefore: 2_000, expiresAt: 2_500 }),
      key,
    );
    expect(() => store.apply(afterMissedOverlap, 2_000)).toThrowError(
      expect.objectContaining({ code: "TRUST_EXPIRED" }),
    );
    expect(open(directory, () => trustedKeys).getLastKnownGood()?.snapshot.revision).toBe(1);

    trustedKeys = cloudAuthorizationTrustedKeysFromKeyset(
      cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(key, { status: "current" })], {
        issuedAt: 2_000,
        expiresAt: 5_000,
      }),
    );
    expect(store.apply(afterMissedOverlap, 2_000).snapshot.revision).toBe(2);
  });

  test("rejects snapshots outside the maximum issue-age window", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture("key-a");
    const store = open(directory, [key.trustedKey]);
    const old = signCloudAuthorizationSnapshot(
      cloudAuthorizationSnapshot({ issuedAt: 1, notBefore: 1, expiresAt: 3_600_001 }),
      key,
    );
    expect(() => store.apply(old, 3_600_002)).toThrowError(expect.objectContaining({ code: "ISSUED_TOO_OLD" }));
  });

  test("keeps the latest replay floor when the primary file becomes corrupt", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture();
    const store = open(directory, [key.trustedKey]);
    store.apply(signCloudAuthorizationSnapshot(cloudAuthorizationSnapshot(), key), 1_000);
    store.apply(
      signCloudAuthorizationSnapshot(
        cloudAuthorizationSnapshot({ revision: 2, issuedAt: 2_000, notBefore: 2_000 }),
        key,
      ),
      2_000,
    );
    expect(statSync(join(directory, CLOUD_AUTHORIZATION_LAST_GOOD_FILE)).mode & 0o777).toBe(0o600);
    await writeFile(join(directory, CLOUD_AUTHORIZATION_FILE), "not-json\n", { mode: 0o600 });

    const recovered = open(directory, [key.trustedKey]);
    expect(recovered.getLastKnownGood()?.snapshot.revision).toBe(2);
    expect(() =>
      recovered.apply(
        signCloudAuthorizationSnapshot(
          cloudAuthorizationSnapshot({ revision: 2, issuedAt: 2_000, notBefore: 2_000 }),
          key,
        ),
        2_100,
      ),
    ).toThrowError(expect.objectContaining({ code: "REPLAY" }));
  });

  test("refuses unsafe persisted paths even when a backup might exist", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture();
    const target = join(directory, "untrusted.json");
    await writeFile(target, "{}\n");
    await symlink(target, join(directory, CLOUD_AUTHORIZATION_FILE));
    expect(() => open(directory, [key.trustedKey])).toThrowError(CloudAuthorizationStoreError);
  });

  test("persists V2 digest envelopes and rejects a valid V1 signature under a V2-provisioned store", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture("key-shared");
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId: "organization-1",
      hostId: "host-1",
      authorizationVersion: 2,
      trustedKeys: [cloudTrustedKeyV2(key)],
    });
    expect(store.apply(signCloudAuthorizationSnapshotV2(cloudAuthorizationSnapshotV2(), key), 1_000).envelope.v).toBe(
      2,
    );

    const nextV1 = signCloudAuthorizationSnapshot(
      cloudAuthorizationSnapshot({ revision: 2, issuedAt: 2_000, notBefore: 2_000 }),
      key,
    );
    expect(() => store.apply(nextV1, 2_000)).toThrowError(expect.objectContaining({ code: "ALGORITHM_MISMATCH" }));
  });
});
