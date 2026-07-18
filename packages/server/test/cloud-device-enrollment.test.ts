import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CLOUD_DEVICE_ENROLLMENT_CONFIRM_PATH,
  CLOUD_DEVICE_ENROLLMENT_COMPLETE_PATH,
  CloudRelayDeviceEnrollmentAuthSchema,
  cloudDeviceEnrollmentAuthorizationReady,
  CloudDeviceEnrollmentError,
  createCloudDeviceEnrollmentRecoveryLoop,
  createCloudRelayDeviceEnrollmentSaga,
  createCloudDeviceEnrollmentConfirmer,
  normalizeCloudControlPlaneOrigin,
  readCloudHostCredentialFile,
  resolveCloudDeviceEnrollmentConfig,
} from "../src/cloud-device-enrollment.js";
import { openDeviceStore } from "../src/device-store.js";
import { generateRelayIdentity } from "../src/relay-crypto.js";
import { relayCredentialHash } from "../src/relay-store.js";
import { cloudAuthorizationSnapshot } from "./helpers/cloud-authorization.js";

const HOST_CREDENTIAL = `rch_${"h".repeat(64)}`;
const ENROLLMENT_ID = "11111111-1111-4111-8111-111111111111";
const CHALLENGE = `rce_${"c".repeat(43)}`;
const ACTOR_ID = "device-actor-1";
const HOST_ID = "host-1";
const CONTROL_PLANE_DEVICE_ID = "22222222-2222-4222-8222-222222222222";

const confirmation = {
  v: 1 as const,
  kind: "host-device-enrollment-confirmation" as const,
  enrollmentId: ENROLLMENT_ID,
  challenge: CHALLENGE,
  actorId: ACTOR_ID,
};

let directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

function credentialFile(mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), "roamcode-cloud-host-"));
  directories.push(directory);
  const path = join(directory, "credential");
  writeFileSync(path, `${HOST_CREDENTIAL}\n`, { mode });
  chmodSync(path, mode);
  return path;
}

function successResponse(
  actorId = ACTOR_ID,
  browser?: { publicKey: string; fingerprint: string; temporaryCredentialHash: string },
): Response {
  return new Response(
    JSON.stringify({
      device: {
        id: "22222222-2222-4222-8222-222222222222",
        organizationId: "33333333-3333-4333-8333-333333333333",
        hostId: "44444444-4444-4444-8444-444444444444",
        actorId,
        label: "Browser",
        pairedBy: "owner-user",
        pairedAt: "2026-07-17T12:00:00.000Z",
        lastSeenAt: null,
        revokedAt: null,
      },
      ...(browser
        ? {
            temporary_relay_credential_hash: browser.temporaryCredentialHash,
            device_identity: { public_key: browser.publicKey, fingerprint: browser.fingerprint },
          }
        : {}),
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

describe("cloud device enrollment client", () => {
  test("pins the exact control-plane route and sends only the host-attested canonical actor contract", async () => {
    const fetch = vi.fn(async () => successResponse());
    const client = createCloudDeviceEnrollmentConfirmer({
      controlPlaneOrigin: "https://control.example.test",
      hostCredential: HOST_CREDENTIAL,
      fetch,
    });

    await expect(client.confirm(confirmation)).resolves.toEqual({
      actorId: ACTOR_ID,
      deviceId: "22222222-2222-4222-8222-222222222222",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://control.example.test${CLOUD_DEVICE_ENROLLMENT_CONFIRM_PATH}`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init.headers).toEqual({
      authorization: `Bearer ${HOST_CREDENTIAL}`,
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual(confirmation);
  });

  test("maps stable upstream outcomes without reflecting credentials or challenges", async () => {
    const rejected = createCloudDeviceEnrollmentConfirmer({
      controlPlaneOrigin: "https://control.example.test",
      hostCredential: HOST_CREDENTIAL,
      fetch: vi.fn(async () => new Response(JSON.stringify({ error: CHALLENGE }), { status: 401 })),
    });
    const unavailable = createCloudDeviceEnrollmentConfirmer({
      controlPlaneOrigin: "https://control.example.test",
      hostCredential: HOST_CREDENTIAL,
      fetch: vi.fn(async () => new Response("temporary", { status: 503 })),
    });

    const rejectedError = await rejected.confirm(confirmation).catch((error: unknown) => error);
    expect(rejectedError).toMatchObject({ code: "REJECTED", retryable: false });
    expect(String(rejectedError)).not.toContain(CHALLENGE);
    expect(String(rejectedError)).not.toContain(HOST_CREDENTIAL);
    const unavailableError = await unavailable.confirm(confirmation).catch((error: unknown) => error);
    expect(unavailableError).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });

  test("reports the exact durable completion binding and validates the versioned response", async () => {
    const temporaryRelayCredentialHash = `sha256:${"t".repeat(43)}`;
    const durableRelayCredentialHash = `sha256:${"d".repeat(43)}`;
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ v: 1, state: "active", deviceId: CONTROL_PLANE_DEVICE_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createCloudDeviceEnrollmentConfirmer({
      controlPlaneOrigin: "https://control.example.test",
      hostCredential: HOST_CREDENTIAL,
      fetch,
    });
    const completion = {
      v: 1 as const,
      kind: "host-device-enrollment-completion" as const,
      enrollmentId: ENROLLMENT_ID,
      actorId: ACTOR_ID,
      temporaryRelayCredentialHash,
      durableRelayCredentialHash,
    };

    await expect(client.complete(completion)).resolves.toEqual({
      state: "active",
      deviceId: CONTROL_PLANE_DEVICE_ID,
      v: 1,
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://control.example.test${CLOUD_DEVICE_ENROLLMENT_COMPLETE_PATH}`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(completion), redirect: "error" }),
    );
  });

  test("fails closed when the response does not bind the requested actor", async () => {
    const client = createCloudDeviceEnrollmentConfirmer({
      controlPlaneOrigin: "https://control.example.test",
      hostCredential: HOST_CREDENTIAL,
      fetch: vi.fn(async () => successResponse("different-actor")),
    });
    await expect(client.confirm(confirmation)).rejects.toMatchObject<Partial<CloudDeviceEnrollmentError>>({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });

  test("binds browser confirmation to the signed P-256 hello and requires the temporary relay hash", async () => {
    const identity = generateRelayIdentity();
    const temporaryCredentialHash = `sha256:${"t".repeat(43)}`;
    const browserConfirmation = { ...confirmation, deviceIdentityPublicKey: identity.publicKey };
    const fetch = vi.fn(async () =>
      successResponse(ACTOR_ID, {
        publicKey: identity.publicKey,
        fingerprint: identity.fingerprint,
        temporaryCredentialHash,
      }),
    );
    const client = createCloudDeviceEnrollmentConfirmer({
      controlPlaneOrigin: "https://control.example.test",
      hostCredential: HOST_CREDENTIAL,
      fetch,
    });

    await expect(client.confirm(browserConfirmation)).resolves.toMatchObject({
      actorId: ACTOR_ID,
      temporaryRelayCredentialHash: temporaryCredentialHash,
      deviceIdentity: { publicKey: identity.publicKey, fingerprint: identity.fingerprint },
    });
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual(browserConfirmation);

    const legacyResponse = createCloudDeviceEnrollmentConfirmer({
      controlPlaneOrigin: "https://control.example.test",
      hostCredential: HOST_CREDENTIAL,
      fetch: vi.fn(async () => successResponse()),
    });
    await expect(legacyResponse.confirm(browserConfirmation)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const changedIdentity = generateRelayIdentity();
    const mismatched = createCloudDeviceEnrollmentConfirmer({
      controlPlaneOrigin: "https://control.example.test",
      hostCredential: HOST_CREDENTIAL,
      fetch: vi.fn(async () =>
        successResponse(ACTOR_ID, {
          publicKey: changedIdentity.publicKey,
          fingerprint: changedIdentity.fingerprint,
          temporaryCredentialHash,
        }),
      ),
    });
    await expect(mismatched.confirm(browserConfirmation)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("bounds untrusted response bodies before parsing them", async () => {
    const client = createCloudDeviceEnrollmentConfirmer({
      controlPlaneOrigin: "https://control.example.test",
      hostCredential: HOST_CREDENTIAL,
      fetch: vi.fn(
        async () =>
          new Response("not-read", {
            status: 201,
            headers: { "content-length": String(64 * 1024 + 1) },
          }),
      ),
    });
    await expect(client.confirm(confirmation)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });

  test("rejects redirect-capable origins, paths, and cleartext non-loopback endpoints", () => {
    expect(normalizeCloudControlPlaneOrigin("https://control.example.test/")).toBe("https://control.example.test");
    expect(normalizeCloudControlPlaneOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(() => normalizeCloudControlPlaneOrigin("http://control.example.test")).toThrow("must use HTTPS");
    expect(() => normalizeCloudControlPlaneOrigin("https://control.example.test/callback")).toThrow("origin");
    expect(() => normalizeCloudControlPlaneOrigin("https://user@control.example.test")).toThrow("origin");
  });
});

describe("cloud relay enrollment saga", () => {
  test("accepts exactly the three E2E auth keys and byte-matches duplicated credentials", () => {
    const token = `rcd_${"l".repeat(43)}`;
    const relayCredential = `rrd_${"d".repeat(43)}`;
    const cloudEnrollment = {
      v: 1 as const,
      kind: "cloud-device-enrollment" as const,
      enrollmentId: ENROLLMENT_ID,
      challenge: CHALLENGE,
      name: "Managed browser",
      localDeviceToken: token,
      durableRelayCredential: relayCredential,
    };
    const valid = { token, relayCredential, cloudEnrollment };

    expect(CloudRelayDeviceEnrollmentAuthSchema.safeParse(valid).success).toBe(true);
    expect(CloudRelayDeviceEnrollmentAuthSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(CloudRelayDeviceEnrollmentAuthSchema.safeParse({ ...valid, token: `rcd_${"x".repeat(43)}` }).success).toBe(
      false,
    );
    expect(
      CloudRelayDeviceEnrollmentAuthSchema.safeParse({
        ...valid,
        relayCredential: `rrd_${"x".repeat(43)}`,
      }).success,
    ).toBe(false);
    expect(
      CloudRelayDeviceEnrollmentAuthSchema.safeParse({
        ...valid,
        cloudEnrollment: { ...cloudEnrollment, extra: true },
      }).success,
    ).toBe(false);
  });

  test("resumes broker promotion after a crash without repeating confirmation or storing raw credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "roamcode-cloud-relay-enrollment-"));
    directories.push(directory);
    const dbPath = join(directory, "devices.db");
    const identity = generateRelayIdentity();
    const temporaryCredentialHash = `sha256:${"t".repeat(43)}`;
    const durableRelayCredential = `rrd_${"d".repeat(43)}`;
    const localDeviceToken = `rcd_${"l".repeat(43)}`;
    const cloudEnrollment = {
      v: 1 as const,
      kind: "cloud-device-enrollment" as const,
      enrollmentId: ENROLLMENT_ID,
      challenge: CHALLENGE,
      name: "Work browser",
      localDeviceToken,
      durableRelayCredential,
    };
    const confirmer = {
      confirm: vi.fn(async () => ({
        actorId: ACTOR_ID,
        deviceId: "22222222-2222-4222-8222-222222222222",
        temporaryRelayCredentialHash: temporaryCredentialHash,
        deviceIdentity: { publicKey: identity.publicKey, fingerprint: identity.fingerprint },
      })),
      complete: vi.fn(async () => ({ v: 1 as const, state: "active" as const, deviceId: CONTROL_PLANE_DEVICE_ID })),
    };
    const firstStore = openDeviceStore({ dbPath });
    const firstPromotion = vi.fn(async () => {
      throw new Error("simulated response loss");
    });
    const refreshAuthorization = vi.fn(async () => 1);
    const firstSaga = createCloudRelayDeviceEnrollmentSaga({
      devices: firstStore,
      confirmer,
      provisioner: { putDevice: vi.fn(), promoteDevice: firstPromotion, revokeDevice: vi.fn() },
      refreshAuthorization,
      now: () => 1_000,
    });

    await expect(
      firstSaga.enroll({ actorId: ACTOR_ID, deviceIdentityPublicKey: identity.publicKey, cloudEnrollment }),
    ).rejects.toThrow("simulated response loss");
    expect(confirmer.confirm).toHaveBeenCalledWith({
      v: 1,
      kind: "host-device-enrollment-confirmation",
      enrollmentId: ENROLLMENT_ID,
      challenge: CHALLENGE,
      actorId: ACTOR_ID,
      deviceIdentityPublicKey: identity.publicKey,
    });
    expect(firstStore.authenticate(localDeviceToken, 1_001, "relay")).toBeUndefined();
    expect(firstStore.cloudDeviceEnrollmentPending(ACTOR_ID)).toBe(true);
    expect(firstStore.pendingCloudDevicePromotions(1_001)).toHaveLength(1);
    expect(refreshAuthorization).not.toHaveBeenCalled();
    firstStore.close();

    const recoveredStore = openDeviceStore({ dbPath });
    const replayPromotion = vi.fn(async () => undefined);
    const shouldNotConfirm = {
      confirm: vi.fn(async () => Promise.reject(new Error("unexpected confirmation"))),
      complete: vi.fn(async () => ({ v: 1 as const, state: "active" as const, deviceId: CONTROL_PLANE_DEVICE_ID })),
    };
    const recoveredSaga = createCloudRelayDeviceEnrollmentSaga({
      devices: recoveredStore,
      confirmer: shouldNotConfirm,
      provisioner: { putDevice: vi.fn(), promoteDevice: replayPromotion, revokeDevice: vi.fn() },
      refreshAuthorization,
      now: () => 2_000,
    });
    await expect(recoveredSaga.recover()).resolves.toEqual({ completed: 1, failed: 0 });
    expect(refreshAuthorization).toHaveBeenCalledOnce();
    expect(replayPromotion).toHaveBeenCalledWith(ACTOR_ID, temporaryCredentialHash, expect.stringMatching(/^sha256:/));
    await expect(
      recoveredSaga.enroll({ actorId: ACTOR_ID, deviceIdentityPublicKey: identity.publicKey, cloudEnrollment }),
    ).resolves.toMatchObject({
      token: localDeviceToken,
      device: { id: ACTOR_ID, scopes: ["relay"], relayIdentityFingerprint: identity.fingerprint },
    });
    expect(shouldNotConfirm.confirm).not.toHaveBeenCalled();
    recoveredStore.close();

    const bytes = readFileSync(dbPath).toString("latin1");
    expect(bytes).not.toContain(CHALLENGE);
    expect(bytes).not.toContain(localDeviceToken);
    expect(bytes).not.toContain(durableRelayCredential);
    expect(bytes).not.toContain(identity.privateKey);
  });

  test("does not repeat broker promotion when the control-plane completion response is lost", async () => {
    const identity = generateRelayIdentity();
    const temporaryCredentialHash = `sha256:${"t".repeat(43)}`;
    const durableRelayCredential = `rrd_${"d".repeat(43)}`;
    const localDeviceToken = `rcd_${"l".repeat(43)}`;
    const cloudEnrollment = {
      v: 1 as const,
      kind: "cloud-device-enrollment" as const,
      enrollmentId: ENROLLMENT_ID,
      challenge: CHALLENGE,
      name: "Response-loss browser",
      localDeviceToken,
      durableRelayCredential,
    };
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new CloudDeviceEnrollmentError("UNAVAILABLE", true))
      .mockResolvedValue({ v: 1 as const, state: "active" as const, deviceId: CONTROL_PLANE_DEVICE_ID });
    const promoteDevice = vi.fn(async () => undefined);
    const refreshAuthorization = vi.fn(async () => 9);
    const store = openDeviceStore({ dbPath: ":memory:" });
    const saga = createCloudRelayDeviceEnrollmentSaga({
      devices: store,
      confirmer: {
        confirm: vi.fn(async () => ({
          actorId: ACTOR_ID,
          deviceId: CONTROL_PLANE_DEVICE_ID,
          temporaryRelayCredentialHash: temporaryCredentialHash,
          deviceIdentity: { publicKey: identity.publicKey, fingerprint: identity.fingerprint },
        })),
        complete,
      },
      provisioner: { putDevice: vi.fn(), promoteDevice, revokeDevice: vi.fn() },
      refreshAuthorization,
      now: () => 1_000,
    });

    await expect(
      saga.enroll({ actorId: ACTOR_ID, deviceIdentityPublicKey: identity.publicKey, cloudEnrollment }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(store.pendingCloudDevicePromotions(1_001)).toEqual([
      expect.objectContaining({ brokerPromoted: true, controlPlaneDeviceId: CONTROL_PLANE_DEVICE_ID }),
    ]);
    await expect(saga.recover()).resolves.toEqual({ completed: 1, failed: 0 });
    expect(promoteDevice).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(refreshAuthorization).toHaveBeenCalledOnce();
    expect(store.authenticate(localDeviceToken, 1_002, "relay")?.id).toBe(ACTOR_ID);
    store.close();
  });

  test("CAS-revokes a promoted broker credential when the control plane says the device was revoked", async () => {
    const identity = generateRelayIdentity();
    const temporaryCredentialHash = `sha256:${"t".repeat(43)}`;
    const durableRelayCredential = `rrd_${"d".repeat(43)}`;
    const durableRelayCredentialHash = relayCredentialHash(durableRelayCredential);
    const localDeviceToken = `rcd_${"l".repeat(43)}`;
    const cloudEnrollment = {
      v: 1 as const,
      kind: "cloud-device-enrollment" as const,
      enrollmentId: ENROLLMENT_ID,
      challenge: CHALLENGE,
      name: "Revoked browser",
      localDeviceToken,
      durableRelayCredential,
    };
    const revokeDevice = vi.fn(async () => undefined);
    const store = openDeviceStore({ dbPath: ":memory:" });
    const saga = createCloudRelayDeviceEnrollmentSaga({
      devices: store,
      confirmer: {
        confirm: vi.fn(async () => ({
          actorId: ACTOR_ID,
          deviceId: CONTROL_PLANE_DEVICE_ID,
          temporaryRelayCredentialHash: temporaryCredentialHash,
          deviceIdentity: { publicKey: identity.publicKey, fingerprint: identity.fingerprint },
        })),
        complete: vi.fn(async () => ({
          v: 1 as const,
          state: "revoked" as const,
          deviceId: CONTROL_PLANE_DEVICE_ID,
        })),
      },
      provisioner: { putDevice: vi.fn(), promoteDevice: vi.fn(async () => undefined), revokeDevice },
      refreshAuthorization: vi.fn(async () => 1),
      now: () => 1_000,
    });

    await expect(
      saga.enroll({ actorId: ACTOR_ID, deviceIdentityPublicKey: identity.publicKey, cloudEnrollment }),
    ).rejects.toMatchObject({ code: "REJECTED", retryable: false });
    expect(revokeDevice).toHaveBeenCalledWith(ACTOR_ID, durableRelayCredentialHash);
    expect(store.authenticate(localDeviceToken, 1_001, "relay")).toBeUndefined();
    expect(store.cloudDeviceEnrollmentPending(ACTOR_ID)).toBe(false);
    expect(store.pendingCloudDevicePromotions(1_002)).toEqual([]);
    store.close();
  });

  test("fails closed when completion is bound to a different control-plane device", async () => {
    const identity = generateRelayIdentity();
    const temporaryCredentialHash = `sha256:${"t".repeat(43)}`;
    const durableRelayCredential = `rrd_${"d".repeat(43)}`;
    const localDeviceToken = `rcd_${"l".repeat(43)}`;
    const store = openDeviceStore({ dbPath: ":memory:" });
    const promoteDevice = vi.fn(async () => undefined);
    const saga = createCloudRelayDeviceEnrollmentSaga({
      devices: store,
      confirmer: {
        confirm: vi.fn(async () => ({
          actorId: ACTOR_ID,
          deviceId: CONTROL_PLANE_DEVICE_ID,
          temporaryRelayCredentialHash: temporaryCredentialHash,
          deviceIdentity: { publicKey: identity.publicKey, fingerprint: identity.fingerprint },
        })),
        complete: vi.fn(async () => ({
          v: 1 as const,
          state: "active" as const,
          deviceId: "99999999-9999-4999-8999-999999999999",
        })),
      },
      provisioner: { putDevice: vi.fn(), promoteDevice, revokeDevice: vi.fn() },
      refreshAuthorization: vi.fn(async () => 1),
      now: () => 1_000,
    });
    const cloudEnrollment = {
      v: 1 as const,
      kind: "cloud-device-enrollment" as const,
      enrollmentId: ENROLLMENT_ID,
      challenge: CHALLENGE,
      name: "Mismatched browser",
      localDeviceToken,
      durableRelayCredential,
    };

    await expect(
      saga.enroll({ actorId: ACTOR_ID, deviceIdentityPublicKey: identity.publicKey, cloudEnrollment }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: false });
    await expect(saga.recover()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(promoteDevice).toHaveBeenCalledOnce();
    expect(store.authenticate(localDeviceToken, 1_001, "relay")).toBeUndefined();
    expect(store.cloudDeviceEnrollmentPending(ACTOR_ID)).toBe(true);
    store.close();
  });

  test("keeps a promoted actor pending until a fresh signed authorization snapshot contains it", async () => {
    const identity = generateRelayIdentity();
    const temporaryCredentialHash = `sha256:${"t".repeat(43)}`;
    const durableRelayCredential = `rrd_${"d".repeat(43)}`;
    const localDeviceToken = `rcd_${"l".repeat(43)}`;
    const cloudEnrollment = {
      v: 1 as const,
      kind: "cloud-device-enrollment" as const,
      enrollmentId: ENROLLMENT_ID,
      challenge: CHALLENGE,
      name: "Managed browser",
      localDeviceToken,
      durableRelayCredential,
    };
    const store = openDeviceStore({ dbPath: ":memory:" });
    let snapshotGrant: "relay-use" | "device-governance" | "device-view" | "device-use" | undefined;
    const authorizationStore = {
      getActiveSnapshot: () =>
        snapshotGrant
          ? cloudAuthorizationSnapshot({
              grants: [
                snapshotGrant === "relay-use"
                  ? {
                      principalType: "relay" as const,
                      principalId: ACTOR_ID,
                      permissions: ["sessions:operate" as const],
                      scope: { type: "host" as const, id: HOST_ID },
                    }
                  : snapshotGrant === "device-governance"
                    ? {
                        principalType: "device" as const,
                        principalId: ACTOR_ID,
                        permissions: ["members:manage" as const],
                        scope: { type: "organization" as const },
                      }
                    : snapshotGrant === "device-view"
                      ? {
                          principalType: "device" as const,
                          principalId: ACTOR_ID,
                          permissions: ["sessions:read" as const],
                          scope: { type: "host" as const, id: HOST_ID },
                        }
                      : {
                          principalType: "device" as const,
                          principalId: ACTOR_ID,
                          permissions: ["sessions:operate" as const],
                          scope: { type: "host" as const, id: HOST_ID },
                        },
              ],
            })
          : undefined,
    };
    const promoteDevice = vi.fn(async () => undefined);
    const refreshAuthorization = vi.fn(async () => 7);
    const deferPromotion = vi.spyOn(store, "deferCloudDevicePromotion");
    const saga = createCloudRelayDeviceEnrollmentSaga({
      devices: store,
      confirmer: {
        confirm: vi.fn(async () => ({
          actorId: ACTOR_ID,
          deviceId: "22222222-2222-4222-8222-222222222222",
          temporaryRelayCredentialHash: temporaryCredentialHash,
          deviceIdentity: { publicKey: identity.publicKey, fingerprint: identity.fingerprint },
        })),
        complete: vi.fn(async () => ({
          v: 1 as const,
          state: "active" as const,
          deviceId: CONTROL_PLANE_DEVICE_ID,
        })),
      },
      provisioner: { putDevice: vi.fn(), promoteDevice, revokeDevice: vi.fn() },
      refreshAuthorization,
      authorizationReady: (actorId) => cloudDeviceEnrollmentAuthorizationReady(authorizationStore, actorId),
      now: () => 1_000,
    });

    await expect(
      saga.enroll({ actorId: ACTOR_ID, deviceIdentityPublicKey: identity.publicKey, cloudEnrollment }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(promoteDevice).toHaveBeenCalledOnce();
    expect(refreshAuthorization).toHaveBeenCalledOnce();
    expect(store.cloudDeviceEnrollmentPending(ACTOR_ID)).toBe(true);
    expect(store.authenticate(localDeviceToken, 1_001, "relay")).toBeUndefined();

    snapshotGrant = "relay-use";
    await expect(saga.recover()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(store.cloudDeviceEnrollmentPending(ACTOR_ID)).toBe(true);
    expect(store.authenticate(localDeviceToken, 1_001, "relay")).toBeUndefined();

    snapshotGrant = "device-governance";
    await expect(saga.recover()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(store.cloudDeviceEnrollmentPending(ACTOR_ID)).toBe(true);

    snapshotGrant = "device-view";
    await expect(saga.recover()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(store.cloudDeviceEnrollmentPending(ACTOR_ID)).toBe(true);

    snapshotGrant = "device-use";
    await expect(saga.recover()).resolves.toEqual({ completed: 1, failed: 0 });
    expect(promoteDevice).toHaveBeenCalledOnce();
    expect(refreshAuthorization).toHaveBeenCalledTimes(5);
    expect(deferPromotion).toHaveBeenCalledTimes(3);
    expect(store.cloudDeviceEnrollmentPending(ACTOR_ID)).toBe(false);
    expect(store.authenticate(localDeviceToken, 1_001, "relay")?.id).toBe(ACTOR_ID);
    store.close();
  });

  test("runs recovery at startup and retries periodically without overlapping a slow pass", async () => {
    vi.useFakeTimers();
    try {
      let finishFirst!: (result: { completed: number; failed: number }) => void;
      const first = new Promise<{ completed: number; failed: number }>((resolve) => {
        finishFirst = resolve;
      });
      const recover = vi
        .fn<() => Promise<{ completed: number; failed: number }>>()
        .mockImplementationOnce(() => first)
        .mockResolvedValue({ completed: 1, failed: 0 });
      const results: Array<{ completed: number; failed: number }> = [];
      const loop = createCloudDeviceEnrollmentRecoveryLoop({
        saga: { recover },
        intervalMs: 1_000,
        onResult: (result) => results.push(result),
      });

      loop.start();
      expect(recover).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(3_000);
      expect(recover).toHaveBeenCalledOnce();

      finishFirst({ completed: 0, failed: 1 });
      await vi.waitFor(() => expect(results).toEqual([{ completed: 0, failed: 1 }]));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(recover).toHaveBeenCalledTimes(2);
      expect(results).toEqual([
        { completed: 0, failed: 1 },
        { completed: 1, failed: 0 },
      ]);
      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cloud host credential file", () => {
  test("requires an owned, regular, non-symlink mode-0600 file and enables startup only when configured", () => {
    const path = credentialFile();
    expect(readCloudHostCredentialFile(path)).toBe(HOST_CREDENTIAL);
    expect(resolveCloudDeviceEnrollmentConfig({})).toBeUndefined();
    expect(
      resolveCloudDeviceEnrollmentConfig({ ROAMCODE_CLOUD_CONTROL_PLANE_URL: "https://other.example" }),
    ).toBeUndefined();
    expect(
      resolveCloudDeviceEnrollmentConfig({
        ROAMCODE_CLOUD_CONTROL_PLANE_URL: "https://control.example.test",
        ROAMCODE_CLOUD_HOST_CREDENTIAL_FILE: path,
      }),
    ).toEqual({ controlPlaneOrigin: "https://control.example.test", hostCredential: HOST_CREDENTIAL });
    expect(resolveCloudDeviceEnrollmentConfig({ ROAMCODE_CLOUD_HOST_CREDENTIAL_FILE: path })).toEqual({
      controlPlaneOrigin: "https://roamcode.ai",
      hostCredential: HOST_CREDENTIAL,
    });
  });

  test("refuses permissive files and symbolic links", () => {
    const permissive = credentialFile(0o644);
    expect(() => readCloudHostCredentialFile(permissive)).toThrow("mode 0600");

    const directory = mkdtempSync(join(tmpdir(), "roamcode-cloud-host-link-"));
    directories.push(directory);
    const target = join(directory, "target");
    writeFileSync(target, HOST_CREDENTIAL, { mode: 0o600 });
    const link = join(directory, "credential-link");
    symlinkSync(target, link);
    expect(() => readCloudHostCredentialFile(link)).toThrow("regular file");
  });

  test("rejects malformed credential bytes without returning them in the error", () => {
    const path = credentialFile();
    writeFileSync(path, "rch_not-a-real-host-capability\n", { mode: 0o600 });
    const error = (() => {
      try {
        readCloudHostCredentialFile(path);
      } catch (caught) {
        return caught;
      }
    })();
    expect(String(error)).toContain("is invalid");
    expect(String(error)).not.toContain("rch_not-a-real-host-capability");
  });
});
