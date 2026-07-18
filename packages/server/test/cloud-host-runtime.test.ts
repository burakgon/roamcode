import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { openCloudAuthorizationStore } from "../src/cloud-authorization-store.js";
import {
  CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN,
  CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN_V2,
  type CloudAuthorizationTrustedKey,
} from "../src/cloud-contract.js";
import {
  CloudHostConfigV2Schema,
  CloudHostConfigV1Schema,
  readCloudHostConfig,
  replaceCloudHostAuthorizationKeyset,
  writeCloudHostConfig,
  type CloudHostConfigV1,
  type CloudHostConfigV2,
} from "../src/cloud-host-config.js";
import {
  CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH,
  CLOUD_HOST_HEARTBEAT_PATH,
  CLOUD_HOST_MAX_SIGNED_RESPONSE_BYTES,
  createCloudHostRuntime,
} from "../src/cloud-host-runtime.js";
import {
  CLOUD_AUTHORIZATION_KEYSET_PATH,
  CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN,
  CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN_V2,
  cloudAuthorizationTrustedKeysFromKeyset,
} from "../src/cloud-keyset.js";
import {
  cloudAuthorizationKeyset,
  cloudAuthorizationKeysetKey,
  cloudAuthorizationKeysetKeyV2,
  cloudAuthorizationKeysetV2,
  cloudAuthorizationSnapshot,
  cloudAuthorizationSnapshotV2,
  cloudSigningFixture,
  signCloudAuthorizationKeyset,
  signCloudAuthorizationKeysetV2,
  signCloudAuthorizationSnapshot,
  signCloudAuthorizationSnapshotV2,
  type CloudSigningFixture,
} from "./helpers/cloud-authorization.js";
import { generateRelayIdentity } from "../src/relay-crypto.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "roamcode-cloud-host-runtime-"));
  directories.push(directory);
  return directory;
}

function configFor(key: CloudSigningFixture): CloudHostConfigV1 {
  return CloudHostConfigV1Schema.parse({
    v: 1,
    kind: "roamcode-cloud-host-config",
    organizationId,
    hostId,
    controlPlaneOrigin: "https://control.roamcode.ai",
    hostCredential: `rch_${"a".repeat(64)}`,
    authorization: {
      algorithm: "Ed25519",
      signatureDomain: CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN,
      keysetSignatureDomain: CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN,
      keyset: cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(key, { status: "current" })]),
    },
    heartbeatIntervalSeconds: 30,
    authorizationRefreshIntervalSeconds: 60,
  });
}

function configForV2(key: CloudSigningFixture): CloudHostConfigV2 {
  return CloudHostConfigV2Schema.parse({
    v: 2,
    kind: "roamcode-cloud-host-config",
    organizationId,
    hostId,
    controlPlaneOrigin: "https://control.roamcode.ai",
    hostCredential: `rch_${"a".repeat(64)}`,
    authorization: {
      algorithm: "Ed25519-SHA256",
      signatureDomain: CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN_V2,
      keysetSignatureDomain: CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN_V2,
      keyset: cloudAuthorizationKeysetV2([cloudAuthorizationKeysetKeyV2(key, { status: "current" })]),
    },
    heartbeatIntervalSeconds: 30,
    authorizationRefreshIntervalSeconds: 60,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function snapshot(revision: number, issuedAt: number, expiresAt: number) {
  return cloudAuthorizationSnapshot({
    organizationId,
    hostId,
    revision,
    issuedAt,
    notBefore: issuedAt,
    expiresAt,
  });
}

describe("cloud host runtime", () => {
  test("coalesces concurrent authorization refreshes into one keyset and snapshot request", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture("key-coalesced");
    const config = configFor(key);
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId,
      hostId,
      trustedKeys: [key.trustedKey],
    });
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith(CLOUD_AUTHORIZATION_KEYSET_PATH)) {
        return json(signCloudAuthorizationKeyset(config.authorization.keyset, [key]));
      }
      await snapshotGate;
      return json(signCloudAuthorizationSnapshot(snapshot(1, 1_000, 2_000), key));
    }) as typeof globalThis.fetch;
    const runtime = createCloudHostRuntime({
      config,
      authorizationStore: store,
      instanceId: "instance-coalesced",
      softwareVersion: "1.2.0",
      capabilities: [],
      replaceAuthorizationKeyset: vi.fn(),
      fetch,
      now: () => 1_000,
    });

    const first = runtime.syncAuthorization();
    const second = runtime.syncAuthorization();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(requested).toHaveLength(2));
    releaseSnapshot();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(requested.filter((url) => url.endsWith(CLOUD_AUTHORIZATION_KEYSET_PATH))).toHaveLength(1);
    expect(requested.filter((url) => url.includes(CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH))).toHaveLength(1);
  });

  test("starts a fresh authorization request after an older in-flight poll", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture("key-fresh-after-confirmation");
    const config = configFor(key);
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId,
      hostId,
      trustedKeys: [key.trustedKey],
    });
    let releaseOldSnapshot!: () => void;
    const oldSnapshotGate = new Promise<void>((resolve) => {
      releaseOldSnapshot = resolve;
    });
    let snapshotRequests = 0;
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith(CLOUD_AUTHORIZATION_KEYSET_PATH)) {
        return json(signCloudAuthorizationKeyset(config.authorization.keyset, [key]));
      }
      snapshotRequests += 1;
      if (snapshotRequests === 1) await oldSnapshotGate;
      return json(
        signCloudAuthorizationSnapshot(
          snapshot(snapshotRequests, 1_000 + snapshotRequests - 1, 2_000 + snapshotRequests - 1),
          key,
        ),
      );
    }) as typeof globalThis.fetch;
    const runtime = createCloudHostRuntime({
      config,
      authorizationStore: store,
      instanceId: "instance-fresh-after-confirmation",
      softwareVersion: "1.2.0",
      capabilities: [],
      replaceAuthorizationKeyset: vi.fn(),
      fetch,
      now: () => 1_001,
    });

    const old = runtime.syncAuthorization();
    await vi.waitFor(() => expect(snapshotRequests).toBe(1));
    const fresh = runtime.syncAuthorizationFresh();
    expect(snapshotRequests).toBe(1);
    releaseOldSnapshot();

    await expect(old).resolves.toBe(1);
    await expect(fresh).resolves.toBe(2);
    expect(requested.filter((url) => url.includes(CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH))).toEqual([
      `https://control.roamcode.ai${CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH}`,
      `https://control.roamcode.ai${CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH}?after_revision=1`,
    ]);
  });

  test("negotiates the strict V2 profile and preserves cross-signed key rotation", async () => {
    const directory = await dataDir();
    const oldKey = cloudSigningFixture("key-v2-old");
    const newKey = cloudSigningFixture("key-v2-new");
    const config = configForV2(oldKey);
    let trustedKeys = cloudAuthorizationTrustedKeysFromKeyset(config.authorization.keyset);
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId,
      hostId,
      authorizationVersion: 2,
      trustedKeys: () => trustedKeys,
    });
    const rotated = cloudAuthorizationKeysetV2(
      [
        cloudAuthorizationKeysetKeyV2(oldKey, { status: "previous", notAfter: 5_000 }),
        cloudAuthorizationKeysetKeyV2(newKey, { status: "current", notBefore: 2_000 }),
      ],
      { issuedAt: 2_000, expiresAt: 12_000 },
    );
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith(CLOUD_AUTHORIZATION_KEYSET_PATH)
        ? json(signCloudAuthorizationKeysetV2(rotated, [oldKey, newKey]))
        : json(
            signCloudAuthorizationSnapshotV2(
              cloudAuthorizationSnapshotV2({
                organizationId,
                hostId,
                issuedAt: 2_000,
                notBefore: 2_000,
                expiresAt: 4_000,
              }),
              newKey,
            ),
          ),
    ) as typeof globalThis.fetch;
    const replace = vi.fn((keyset) => {
      trustedKeys = cloudAuthorizationTrustedKeysFromKeyset(keyset);
    });
    const runtime = createCloudHostRuntime({
      config,
      authorizationStore: store,
      instanceId: "instance-v2",
      softwareVersion: "1.2.0",
      capabilities: [],
      replaceAuthorizationKeyset: replace,
      fetch,
      now: () => 2_000,
    });

    expect(await runtime.syncAuthorization()).toBe(1);
    expect(replace).toHaveBeenCalledWith(rotated);
    expect(store.getLastKnownGood()?.envelope).toMatchObject({ v: 2, algorithm: "Ed25519-SHA256" });
  });

  test("sends a strict privacy-minimal heartbeat with monotonic sequence and no host metadata", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture("key-a");
    const config = configFor(key);
    const originalCredential = config.hostCredential;
    const relayIdentity = generateRelayIdentity();
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId,
      hostId,
      trustedKeys: [key.trustedKey],
    });
    store.apply(signCloudAuthorizationSnapshot(snapshot(1, 1_000, 10_000), key), 1_000);
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        init: init ?? {},
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const runtime = createCloudHostRuntime({
      config,
      authorizationStore: store,
      instanceId: "instance-a",
      softwareVersion: "1.2.0",
      capabilities: ["terminal.v1", "authorization.v1", "terminal.v1"],
      relayHostIdentity: { publicKey: relayIdentity.publicKey, fingerprint: relayIdentity.fingerprint },
      replaceAuthorizationKeyset: vi.fn(),
      fetch,
      now: () => 1_500,
    });
    // The destination and capability are captured at construction; later object mutation cannot redirect them.
    config.controlPlaneOrigin = "https://changed.example.com";
    config.hostCredential = `rch_${"z".repeat(64)}`;

    await runtime.sendHeartbeat();
    await runtime.sendHeartbeat("draining");

    expect(requests.map(({ url }) => url)).toEqual([
      `https://control.roamcode.ai${CLOUD_HOST_HEARTBEAT_PATH}`,
      `https://control.roamcode.ai${CLOUD_HOST_HEARTBEAT_PATH}`,
    ]);
    expect(requests[0]!.init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${originalCredential}`,
        "content-type": "application/json",
        accept: "application/json",
      },
    });
    expect(requests[0]!.body).toEqual({
      v: 1,
      kind: "host-heartbeat",
      organizationId,
      hostId,
      instanceId: "instance-a",
      sentAt: 1_500,
      sequence: 1,
      softwareVersion: "1.2.0",
      state: "ready",
      authorizationRevision: 1,
      relayHostIdentity: { publicKey: relayIdentity.publicKey, fingerprint: relayIdentity.fingerprint },
      capabilities: ["authorization.v1", "terminal.v1"],
    });
    expect(requests[1]!.body).toMatchObject({ sentAt: 1_501, sequence: 2, state: "draining" });
    expect(Object.keys(requests[0]!.body).sort()).toEqual(
      [
        "authorizationRevision",
        "capabilities",
        "hostId",
        "instanceId",
        "kind",
        "organizationId",
        "relayHostIdentity",
        "sentAt",
        "sequence",
        "softwareVersion",
        "state",
        "v",
      ].sort(),
    );
  });

  test("polls after the durable revision, rejects replay, and fails closed after expiry while retaining LKG", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture("key-a");
    const config = configFor(key);
    let now = 1_000;
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId,
      hostId,
      trustedKeys: [key.trustedKey],
      now: () => now,
    });
    const responses = [
      signCloudAuthorizationSnapshot(snapshot(1, 1_000, 2_000), key),
      signCloudAuthorizationSnapshot(snapshot(2, 1_100, 2_100), key),
      signCloudAuthorizationSnapshot(snapshot(2, 1_100, 2_100), key),
    ];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return json(responses.shift());
    }) as typeof globalThis.fetch;
    const runtime = createCloudHostRuntime({
      config,
      authorizationStore: store,
      instanceId: "instance-a",
      softwareVersion: "1.2.0",
      capabilities: [],
      replaceAuthorizationKeyset: vi.fn(),
      fetch,
      now: () => now,
    });

    expect(await runtime.refreshAuthorizationSnapshot()).toBe(1);
    now = 1_100;
    expect(await runtime.refreshAuthorizationSnapshot()).toBe(2);
    await expect(runtime.refreshAuthorizationSnapshot()).rejects.toMatchObject({ code: "REPLAY" });
    expect(requests.map(({ url }) => url)).toEqual([
      `https://control.roamcode.ai${CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH}`,
      `https://control.roamcode.ai${CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH}?after_revision=1`,
      `https://control.roamcode.ai${CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH}?after_revision=2`,
    ]);
    expect(requests[0]!.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json", authorization: `Bearer ${config.hostCredential}` },
    });

    now = 2_100;
    expect(runtime.status().authorization).toMatchObject({ status: "expired", revision: 2 });
    expect(store.authorize("device", "device-1", "sessions:read")).toMatchObject({
      allowed: false,
      reason: "cloud-authorization-expired",
      revision: 2,
    });
    expect(store.getLastKnownGood()?.snapshot.revision).toBe(2);
  });

  test("persists a cross-signed key rotation before accepting a snapshot from the new key", async () => {
    const directory = await dataDir();
    const oldKey = cloudSigningFixture("key-old");
    const newKey = cloudSigningFixture("key-new");
    const configPath = join(directory, "cloud-host.json");
    let activeConfig = writeCloudHostConfig(configPath, configFor(oldKey));
    let trustedKeys: readonly CloudAuthorizationTrustedKey[] = cloudAuthorizationTrustedKeysFromKeyset(
      activeConfig.authorization.keyset,
    );
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId,
      hostId,
      trustedKeys: () => trustedKeys,
    });
    const rotated = cloudAuthorizationKeyset(
      [
        cloudAuthorizationKeysetKey(oldKey, { status: "previous", notAfter: 5_000 }),
        cloudAuthorizationKeysetKey(newKey, { status: "current", notBefore: 2_000 }),
      ],
      { issuedAt: 2_000, expiresAt: 12_000 },
    );
    let keysetRequest: RequestInit | undefined;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(CLOUD_AUTHORIZATION_KEYSET_PATH)) {
        keysetRequest = init;
        return json(signCloudAuthorizationKeyset(rotated, [oldKey, newKey]));
      }
      if (url.includes(CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH)) {
        return json(signCloudAuthorizationSnapshot(snapshot(1, 2_000, 4_000), newKey));
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof globalThis.fetch;
    const runtime = createCloudHostRuntime({
      config: activeConfig,
      authorizationStore: store,
      instanceId: "instance-a",
      softwareVersion: "1.2.0",
      capabilities: [],
      replaceAuthorizationKeyset: (keyset) => {
        activeConfig = replaceCloudHostAuthorizationKeyset(configPath, activeConfig, keyset);
        trustedKeys = cloudAuthorizationTrustedKeysFromKeyset(keyset);
      },
      fetch,
      now: () => 2_000,
    });

    expect(await runtime.syncAuthorization()).toBe(1);
    expect(store.getState(2_001)).toMatchObject({ status: "active", revision: 1 });
    expect(readCloudHostConfig(configPath)?.authorization.keyset).toEqual(rotated);
    expect(trustedKeys.map((key) => key.keyId)).toEqual(["key-old", "key-new"]);
    expect(keysetRequest).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
    });
    expect((keysetRequest?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("does not install an untrusted rotation but can renew under the existing valid pin", async () => {
    const directory = await dataDir();
    const oldKey = cloudSigningFixture("key-old");
    const attacker = cloudSigningFixture("key-attacker");
    const config = configFor(oldKey);
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId,
      hostId,
      trustedKeys: [oldKey.trustedKey],
    });
    const untrusted = cloudAuthorizationKeyset(
      [cloudAuthorizationKeysetKey(attacker, { status: "current", notBefore: 2_000 })],
      { issuedAt: 2_000, expiresAt: 12_000 },
    );
    const replace = vi.fn();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith(CLOUD_AUTHORIZATION_KEYSET_PATH)
        ? json(signCloudAuthorizationKeyset(untrusted, [attacker]))
        : json(signCloudAuthorizationSnapshot(snapshot(1, 2_000, 4_000), oldKey));
    }) as typeof globalThis.fetch;
    const runtime = createCloudHostRuntime({
      config,
      authorizationStore: store,
      instanceId: "instance-a",
      softwareVersion: "1.2.0",
      capabilities: [],
      replaceAuthorizationKeyset: replace,
      fetch,
      now: () => 2_000,
    });

    await expect(runtime.refreshAuthorizationKeyset()).rejects.toMatchObject({ code: "UNTRUSTED_ROTATION" });
    expect(await runtime.syncAuthorization()).toBe(1);
    expect(replace).not.toHaveBeenCalled();
  });

  test("never trusts a rotated snapshot when the verified keyset could not be persisted", async () => {
    const directory = await dataDir();
    const oldKey = cloudSigningFixture("key-old");
    const newKey = cloudSigningFixture("key-new");
    const config = configFor(oldKey);
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId,
      hostId,
      trustedKeys: [oldKey.trustedKey],
    });
    const rotated = cloudAuthorizationKeyset(
      [
        cloudAuthorizationKeysetKey(oldKey, { status: "previous", notAfter: 5_000 }),
        cloudAuthorizationKeysetKey(newKey, { status: "current", notBefore: 2_000 }),
      ],
      { issuedAt: 2_000, expiresAt: 12_000 },
    );
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith(CLOUD_AUTHORIZATION_KEYSET_PATH)
        ? json(signCloudAuthorizationKeyset(rotated, [oldKey, newKey]))
        : json(signCloudAuthorizationSnapshot(snapshot(1, 2_000, 4_000), newKey)),
    ) as typeof globalThis.fetch;
    const runtime = createCloudHostRuntime({
      config,
      authorizationStore: store,
      instanceId: "instance-a",
      softwareVersion: "1.2.0",
      capabilities: [],
      replaceAuthorizationKeyset: () => {
        throw new Error("disk unavailable");
      },
      fetch,
      now: () => 2_000,
    });

    await expect(runtime.syncAuthorization()).rejects.toMatchObject({ code: "UNKNOWN_KEY" });
    expect(store.getLastKnownGood()).toBeUndefined();
  });

  test("rejects a declared 16 MiB plus one response before parsing or changing LKG", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture("key-a");
    const config = configFor(key);
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId,
      hostId,
      trustedKeys: [key.trustedKey],
    });
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(CLOUD_HOST_MAX_SIGNED_RESPONSE_BYTES + 1) },
        }),
    ) as typeof globalThis.fetch;
    const runtime = createCloudHostRuntime({
      config,
      authorizationStore: store,
      instanceId: "instance-a",
      softwareVersion: "1.2.0",
      capabilities: [],
      replaceAuthorizationKeyset: vi.fn(),
      fetch,
      now: () => 2_000,
    });

    await expect(runtime.refreshAuthorizationSnapshot()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(store.getLastKnownGood()).toBeUndefined();
  });

  test("starts both loops immediately, retries failures with bounded backoff, and drains on stop", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture("key-a");
    const config = configFor(key);
    const store = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId,
      hostId,
      trustedKeys: [key.trustedKey],
    });
    const scheduled: Array<{ callback: () => void; delay: number; handle: { unref(): void } }> = [];
    const setTimeout = ((callback: TimerHandler, delay = 0) => {
      if (typeof callback !== "function") throw new Error("test scheduler requires a function");
      const handle = { unref: vi.fn() };
      scheduled.push({ callback: () => callback(), delay, handle });
      return handle;
    }) as unknown as typeof globalThis.setTimeout;
    const clearTimeout = vi.fn() as unknown as typeof globalThis.clearTimeout;
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as typeof globalThis.fetch;
    const runtime = createCloudHostRuntime({
      config,
      authorizationStore: store,
      instanceId: "instance-a",
      softwareVersion: "1.2.0",
      capabilities: [],
      replaceAuthorizationKeyset: vi.fn(),
      fetch,
      now: () => 2_000,
      random: () => 0.5,
      setTimeout,
      clearTimeout,
    });

    runtime.start();
    expect(scheduled.map(({ delay }) => delay)).toEqual([0, 0]);
    scheduled[0]!.callback();
    scheduled[1]!.callback();
    await vi.waitFor(() => {
      expect(runtime.status()).toMatchObject({
        heartbeatFailures: 1,
        authorizationFailures: 1,
        authorizationIssue: "connectivity",
      });
    });
    expect(scheduled.slice(2).map(({ delay }) => delay)).toEqual([1_000, 1_000]);

    await runtime.stop();
    expect(runtime.status().running).toBe(false);
    expect(clearTimeout).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalled();
  });
});
