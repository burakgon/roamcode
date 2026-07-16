import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer, generateRelayIdentity, openDeviceStore } from "../src/index.js";
import type { CreateServerResult, PushStore, ServerRuntimeConfig } from "../src/index.js";

const HOST_TOKEN = "host-token";
const PAIR_SECRET = `rcp_${"p".repeat(43)}`;
const DEVICE_TOKEN = `rcd_${"d".repeat(43)}`;

let result: CreateServerResult | undefined;
afterEach(async () => {
  await result?.app.close();
  result = undefined;
});

function config(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: HOST_TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 1024,
    dataDir: process.cwd(),
    allowedOrigins: [],
    rateLimitRpm: 0,
    rateLimitBurst: 120,
    maxSessions: 25,
    codexBin: process.execPath,
    claude: { claudeBin: process.execPath },
  };
}

function makeServer(pushStore?: PushStore): CreateServerResult {
  const deviceStore = openDeviceStore({
    dbPath: ":memory:",
    generateSecret: () => PAIR_SECRET,
    generateToken: () => DEVICE_TOKEN,
    generateId: () => "device-1",
  });
  return createServer(config(), { deviceStore, terminalAvailable: false, ...(pushStore ? { pushStore } : {}) });
}

describe("device pairing transport", () => {
  test("two independent hosts reject each other's device credentials", async () => {
    const hostA = createServer(config(), {
      terminalAvailable: false,
      deviceStore: openDeviceStore({
        dbPath: ":memory:",
        generateSecret: () => `rcp_${"a".repeat(43)}`,
        generateToken: () => `rcd_${"a".repeat(43)}`,
        generateId: () => "device-a",
      }),
    });
    const hostB = createServer(config(), {
      terminalAvailable: false,
      deviceStore: openDeviceStore({
        dbPath: ":memory:",
        generateSecret: () => `rcp_${"b".repeat(43)}`,
        generateToken: () => `rcd_${"b".repeat(43)}`,
        generateId: () => "device-b",
      }),
    });
    try {
      const pairA = hostA.issuePairing();
      const pairB = hostB.issuePairing();
      const claimA = await hostA.app.inject({
        method: "POST",
        url: "/pairing/claim",
        payload: { secret: pairA.secret, name: "Browser A" },
      });
      const claimB = await hostB.app.inject({
        method: "POST",
        url: "/pairing/claim",
        payload: { secret: pairB.secret, name: "Browser B" },
      });
      const tokenA = claimA.json().token as string;
      const tokenB = claimB.json().token as string;

      expect(
        (
          await hostA.app.inject({
            method: "GET",
            url: "/api/v1/capabilities",
            headers: { authorization: `Bearer ${tokenA}` },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hostB.app.inject({
            method: "GET",
            url: "/api/v1/capabilities",
            headers: { authorization: `Bearer ${tokenB}` },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hostA.app.inject({
            method: "GET",
            url: "/api/v1/capabilities",
            headers: { authorization: `Bearer ${tokenB}` },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await hostB.app.inject({
            method: "GET",
            url: "/api/v1/capabilities",
            headers: { authorization: `Bearer ${tokenA}` },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await Promise.all([hostA.app.close(), hostB.app.close()]);
    }
  });

  test("exchanges a one-use pairing capability for an independently revocable credential", async () => {
    result = makeServer();
    const unauthenticatedStart = await result.app.inject({ method: "POST", url: "/pairing/start" });
    expect(unauthenticatedStart.statusCode).toBe(401);

    const started = await result.app.inject({
      method: "POST",
      url: "/pairing/start",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toEqual({ secret: PAIR_SECRET, expiresAt: expect.any(Number), scopes: ["direct"] });
    expect(started.headers["cache-control"]).toBe("no-store");

    const claimed = await result.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { secret: PAIR_SECRET, name: "RoamCode on iPhone" },
    });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json()).toEqual({
      token: DEVICE_TOKEN,
      device: {
        id: "device-1",
        name: "RoamCode on iPhone",
        createdAt: expect.any(Number),
        lastSeenAt: expect.any(Number),
        scopes: ["direct"],
      },
    });

    const duplicate = await result.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { secret: PAIR_SECRET, name: "Second browser" },
    });
    expect(duplicate.statusCode).toBe(410);

    const sessions = await result.app.inject({
      method: "GET",
      url: "/sessions",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    expect(sessions.statusCode).toBe(200);

    const devices = await result.app.inject({
      method: "GET",
      url: "/devices",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    expect(devices.json()).toMatchObject({ currentDeviceId: "device-1", devices: [{ id: "device-1" }] });

    const renamed = await result.app.inject({
      method: "PATCH",
      url: "/devices/device-1",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
      payload: { name: "Travel phone" },
    });
    expect(renamed.json().device).toMatchObject({ id: "device-1", name: "Travel phone", scopes: ["direct"] });
  });

  test("authenticates cancellation and makes a hidden direct pairing link unusable immediately", async () => {
    result = makeServer();
    const started = await result.app.inject({
      method: "POST",
      url: "/pairing/start",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(started.statusCode).toBe(201);

    const denied = await result.app.inject({
      method: "POST",
      url: "/pairing/cancel",
      payload: { secret: PAIR_SECRET },
    });
    expect(denied.statusCode).toBe(401);
    const cancelled = await result.app.inject({
      method: "POST",
      url: "/pairing/cancel",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: { secret: PAIR_SECRET },
    });
    expect(cancelled.statusCode).toBe(204);
    expect(cancelled.headers["cache-control"]).toBe("no-store");

    const claim = await result.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { secret: PAIR_SECRET, name: "Cancelled browser" },
    });
    expect(claim.statusCode).toBe(410);
    const repeated = await result.app.inject({
      method: "POST",
      url: "/pairing/cancel",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: { secret: PAIR_SECRET },
    });
    expect(repeated.statusCode).toBe(404);
  });

  test("issues explicitly scoped credentials and refuses relay-only keys on the direct API", async () => {
    const identity = generateRelayIdentity();
    result = makeServer();
    const started = await result.app.inject({
      method: "POST",
      url: "/pairing/start",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: { scopes: ["relay"] },
    });
    expect(started.json().scopes).toEqual(["relay"]);
    const missingIdentity = await result.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { secret: PAIR_SECRET, name: "Relay client" },
    });
    expect(missingIdentity.statusCode).toBe(400);
    expect(missingIdentity.json().code).toBe("INVALID_RELAY_IDENTITY");
    const claimed = await result.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { secret: PAIR_SECRET, name: "Relay client", relayIdentityPublicKey: identity.publicKey },
    });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json().device).toMatchObject({
      scopes: ["relay"],
      relayIdentityFingerprint: identity.fingerprint,
    });
    const direct = await result.app.inject({
      method: "GET",
      url: "/sessions",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    expect(direct.statusCode).toBe(401);

    const relayedInventory = await result.dispatchRelayRequest(DEVICE_TOKEN, {
      id: "relay-devices",
      method: "GET",
      path: "/api/v1/devices",
      headers: {},
    });
    expect(relayedInventory.status).toBe(200);
    expect(JSON.parse(Buffer.from(relayedInventory.body!, "base64url").toString("utf8"))).toMatchObject({
      currentDeviceId: "device-1",
      devices: [{ id: "device-1", scopes: ["relay"] }],
    });
  });

  test("revocation invalidates API access and removes the device's push channels", async () => {
    const removeForDevice = vi.fn();
    const pushStore: PushStore = {
      upsert: vi.fn(),
      list: vi.fn(() => []),
      remove: vi.fn(),
      removeForDevice,
      close: vi.fn(),
    };
    result = makeServer(pushStore);
    result.issuePairing();
    await result.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { secret: PAIR_SECRET, name: "Phone" },
    });

    const revoked = await result.app.inject({
      method: "DELETE",
      url: "/devices/device-1",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    expect(revoked.statusCode).toBe(204);
    expect(removeForDevice).toHaveBeenCalledWith("device-1");

    const denied = await result.app.inject({
      method: "GET",
      url: "/sessions",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    expect(denied.statusCode).toBe(401);
    const hostStillWorks = await result.app.inject({
      method: "GET",
      url: "/sessions",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(hostStillWorks.statusCode).toBe(200);
  });

  test("the public exception is exact and still enforces browser origin", async () => {
    result = makeServer();
    result.issuePairing();
    const crossOrigin = await result.app.inject({
      method: "POST",
      url: "/pairing/claim",
      headers: { origin: "https://evil.example", host: "roamcode.example" },
      payload: { secret: PAIR_SECRET, name: "Phone" },
    });
    expect(crossOrigin.statusCode).toBe(403);
    const devices = await result.app.inject({ method: "GET", url: "/devices" });
    expect(devices.statusCode).toBe(401);
  });

  test("admits exactly one winner when the same pairing capability is claimed concurrently", async () => {
    result = makeServer();
    result.issuePairing();

    const [first, second] = await Promise.all(
      ["Phone A", "Phone B"].map((name) =>
        result!.app.inject({
          method: "POST",
          url: "/pairing/claim",
          payload: { secret: PAIR_SECRET, name },
        }),
      ),
    );

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 410]);
    expect(result.app).toBeDefined();
    const inventory = await result.app.inject({
      method: "GET",
      url: "/devices",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(inventory.json().devices).toHaveLength(1);
  });

  test("rate-limits repeated malformed public claims before they can become unbounded work", async () => {
    result = makeServer();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const malformed = await result.app.inject({
        method: "POST",
        url: "/pairing/claim",
        payload: { secret: "not-a-capability", name: "Phone" },
      });
      expect(malformed.statusCode).toBe(400);
    }

    const limited = await result.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { secret: "still-not-a-capability", name: "Phone" },
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });
});
