import { beforeEach, describe, expect, test, vi } from "vitest";
import { browserRelayIdentityFingerprint } from "../relay/crypto";
import {
  cancelManagedBrowserEnrollment,
  clearManagedEnrollment,
  consumeOrResumeManagedEnrollment,
  createManagedBrowserEnrollment,
  relayCredentialHash,
  saveManagedEnrollment,
  type ManagedEnrollmentAttempt,
} from "./managed-enrollment";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const ENROLLMENT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function publicIdentity(): Promise<{ publicKey: string; fingerprint: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  return { publicKey, fingerprint: await browserRelayIdentityFingerprint(publicKey) };
}

function responseBody(identity: { publicKey: string; fingerprint: string }) {
  return {
    enrollment_id: ENROLLMENT_ID,
    challenge: `rce_${"c".repeat(43)}`,
    relay_url: "https://relay.example.test",
    route_id: "route-1",
    temporary_device_id: "33333333-3333-4333-8333-333333333333",
    host_identity: { public_key: identity.publicKey, fingerprint: identity.fingerprint },
    host_label: "Build Node",
    expires_at: new Date(NOW + 5 * 60_000).toISOString(),
  };
}

describe("managed browser enrollment", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/terminal/sessions");
  });

  test("consumes a non-secret Node selector and resumes tab-scoped credentials after reload", () => {
    window.history.replaceState({}, "", `/terminal/sessions?enroll=${HOST_ID}&view=active`);
    const first = consumeOrResumeManagedEnrollment(NOW)!;
    expect(window.location.href).not.toContain("enroll=");
    expect(window.location.search).toBe("?view=active");
    expect(first).toMatchObject({ v: 1, hostId: HOST_ID, createdAt: NOW });
    expect(first.temporaryRelayCredential).toMatch(/^rrd_[A-Za-z0-9_-]{43}$/);
    expect(first.durableRelayCredential).toMatch(/^rrd_[A-Za-z0-9_-]{43}$/);
    expect(first.deviceToken).toMatch(/^rcd_[A-Za-z0-9_-]{43}$/);
    expect(consumeOrResumeManagedEnrollment(NOW + 1_000)).toEqual(first);
  });

  test("drops an expired tab-scoped attempt instead of replaying stale credentials", () => {
    window.history.replaceState({}, "", `/terminal/sessions?enroll=${HOST_ID}`);
    consumeOrResumeManagedEnrollment(NOW);

    expect(consumeOrResumeManagedEnrollment(NOW + 16 * 60_000)).toBeUndefined();
    expect(sessionStorage.length).toBe(0);
  });

  test("sends only a temporary credential hash to the account service and validates host identity", async () => {
    window.history.replaceState({}, "", `/terminal/sessions?enroll=${HOST_ID}`);
    const initial = consumeOrResumeManagedEnrollment(NOW)!;
    const attempt: ManagedEnrollmentAttempt = {
      ...initial,
      temporaryDeviceId: "33333333-3333-4333-8333-333333333333",
    };
    const browser = await publicIdentity();
    const host = await publicIdentity();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const raw = String(init?.body);
      expect(raw).not.toContain(attempt.temporaryRelayCredential);
      expect(raw).not.toContain(attempt.durableRelayCredential);
      expect(raw).not.toContain(attempt.deviceToken);
      expect(init?.credentials).toBe("include");
      expect(JSON.parse(raw)).toEqual({
        idempotency_key: attempt.idempotencyKey,
        label: "Work browser",
        device_fingerprint: browser.fingerprint,
        public_key: browser.publicKey,
        temporary_device_id: attempt.temporaryDeviceId,
        temporary_relay_credential_hash: await relayCredentialHash(attempt.temporaryRelayCredential),
      });
      return new Response(JSON.stringify(responseBody(host)), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    await expect(
      createManagedBrowserEnrollment(
        attempt,
        { label: "Work browser", publicKey: browser.publicKey, fingerprint: browser.fingerprint },
        { fetchImpl, now: NOW },
      ),
    ).resolves.toMatchObject({
      enrollmentId: ENROLLMENT_ID,
      hostLabel: "Build Node",
      temporaryDeviceId: attempt.temporaryDeviceId,
      hostIdentityFingerprint: host.fingerprint,
    });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/v1/hosts/${HOST_ID}/browser-enrollments`, expect.any(Object));
  });

  test("uses the relay protocol credential-hash domain", async () => {
    await expect(relayCredentialHash(`rrd_${"d".repeat(43)}`)).resolves.toBe(
      "sha256:Hv-vzR_m3kAkti2CAuZBg7QRcd-W1masFv5t8t6Xel8",
    );
  });

  test("preserves a forbidden enrollment status so the shell can offer an access request", async () => {
    window.history.replaceState(
      {},
      "",
      `/terminal/sessions?enroll=${HOST_ID}&context=44444444-4444-4444-8444-444444444444`,
    );
    const attempt = consumeOrResumeManagedEnrollment(NOW)!;
    const browser = await publicIdentity();
    await expect(
      createManagedBrowserEnrollment(
        attempt,
        { label: "Browser", publicKey: browser.publicKey, fingerprint: browser.fingerprint },
        {
          now: NOW,
          fetchImpl: async () =>
            new Response(JSON.stringify({ error: "forbidden", error_description: "Node access is required." }), {
              status: 403,
              headers: { "content-type": "application/json" },
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden", status: 403, message: "Node access is required." });
    expect(window.location.search).toBe("?context=44444444-4444-4444-8444-444444444444");
  });

  test("rejects inconsistent host public material before opening a relay", async () => {
    window.history.replaceState({}, "", `/terminal/sessions?enroll=${HOST_ID}`);
    const initial = consumeOrResumeManagedEnrollment(NOW)!;
    const attempt = { ...initial, temporaryDeviceId: "33333333-3333-4333-8333-333333333333" };
    const browser = await publicIdentity();
    const host = await publicIdentity();
    await expect(
      createManagedBrowserEnrollment(
        attempt,
        { label: "Browser", publicKey: browser.publicKey, fingerprint: browser.fingerprint },
        {
          now: NOW,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                ...responseBody(host),
                host_identity: { public_key: host.publicKey, fingerprint: `sha256:${"x".repeat(43)}` },
              }),
              { status: 201, headers: { "content-type": "application/json" } },
            ),
        },
      ),
    ).rejects.toMatchObject({ code: "host_identity_mismatch" });
  });

  test("cancels a provisioned temporary device without placing credentials in the request", async () => {
    window.history.replaceState({}, "", `/terminal/sessions?enroll=${HOST_ID}`);
    const initial = consumeOrResumeManagedEnrollment(NOW)!;
    const host = await publicIdentity();
    const attempt: ManagedEnrollmentAttempt = {
      ...initial,
      temporaryDeviceId: "33333333-3333-4333-8333-333333333333",
      bootstrap: {
        enrollmentId: ENROLLMENT_ID,
        challenge: `rce_${"c".repeat(43)}`,
        relayUrl: "wss://relay.example.test/v1/connect",
        routeId: "route-1",
        temporaryDeviceId: "33333333-3333-4333-8333-333333333333",
        hostIdentityPublicKey: host.publicKey,
        hostIdentityFingerprint: host.fingerprint,
        hostLabel: "Build Node",
        expiresAt: NOW + 5 * 60_000,
      },
    };
    saveManagedEnrollment(attempt, sessionStorage, NOW);
    expect(consumeOrResumeManagedEnrollment(NOW + 1_000)).toEqual(attempt);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).not.toContain(attempt.temporaryRelayCredential);
      expect(init?.body).toBeUndefined();
      return new Response(null, { status: 204 });
    });
    await cancelManagedBrowserEnrollment(attempt, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/v1/hosts/${HOST_ID}/browser-enrollments/${ENROLLMENT_ID}`,
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    );
    clearManagedEnrollment();
    expect(sessionStorage.length).toBe(0);
  });
});
