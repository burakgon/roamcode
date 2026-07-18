import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE,
  CloudDeviceEnrollmentError,
  createServer,
  generateRelayIdentity,
  openDeviceStore,
  parseRelayRpcRequest,
} from "../src/index.js";
import type { CloudDeviceEnrollmentConfirmer, CreateServerResult, ServerRuntimeConfig } from "../src/index.js";

const HOST_TOKEN = "local-host-administrator";
const DEVICE_TOKEN = `rcd_${"d".repeat(43)}`;
const PAIRING_SECRET = `rcp_${"p".repeat(43)}`;
const ENROLLMENT_ID = "11111111-1111-4111-8111-111111111111";
const CHALLENGE = `rce_${"c".repeat(43)}`;
const REQUEST = { v: 1, enrollmentId: ENROLLMENT_ID, challenge: CHALLENGE } as const;
const complete = vi.fn(async () => ({
  v: 1 as const,
  state: "active" as const,
  deviceId: "22222222-2222-4222-8222-222222222222",
}));

const servers: CreateServerResult[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.app.close()));
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

function decodeRelayBody(body: string | undefined): unknown {
  return body ? JSON.parse(Buffer.from(body, "base64url").toString("utf8")) : undefined;
}

describe("host-attested cloud device enrollment", () => {
  test("derives the outbound actor from the authenticated DeviceStore principal and rejects client actor fields", async () => {
    const deviceStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => PAIRING_SECRET,
      generateToken: () => DEVICE_TOKEN,
      generateId: () => "canonical-device-actor",
    });
    const pairing = deviceStore.issuePairing(1);
    const enrollment = deviceStore.claimPairing(pairing.secret, "Browser", 2)!;
    const confirm = vi.fn(async (input) => ({ actorId: input.actorId, deviceId: "cloud-device-record" }));
    const cloudDeviceEnrollmentConfirmer: CloudDeviceEnrollmentConfirmer = { confirm, complete };
    const server = createServer(config(), {
      deviceStore,
      cloudDeviceEnrollmentConfirmer,
      terminalAvailable: false,
    });
    servers.push(server);

    const createdTeam = await server.app.inject({
      method: "POST",
      url: "/api/v1/team",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: { name: "Cloud team", ownerName: "Owner" },
    });
    const enabled = await server.app.inject({
      method: "PATCH",
      url: "/api/v1/team",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: {
        authorizationEnabled: true,
        expectedRevision: createdTeam.json().team.revision,
        confirm: true,
      },
    });
    expect(enabled.statusCode).toBe(200);

    const injectedActor = await server.app.inject({
      method: "POST",
      url: CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE,
      headers: { authorization: `Bearer ${enrollment.token}` },
      payload: {
        ...REQUEST,
        actorId: "client-chosen-actor",
        confirmationUrl: "https://attacker.example/collect-host-credential",
      },
    });
    expect(injectedActor.statusCode).toBe(400);
    expect(confirm).not.toHaveBeenCalled();

    const confirmed = await server.app.inject({
      method: "POST",
      url: CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE,
      headers: { authorization: `Bearer ${enrollment.token}` },
      payload: REQUEST,
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.headers["cache-control"]).toBe("no-store");
    expect(confirmed.json()).toEqual({ enrolled: true, actorId: "canonical-device-actor" });
    expect(JSON.stringify(confirmed.json())).not.toContain(CHALLENGE);
    expect(confirm).toHaveBeenCalledWith({
      v: 1,
      kind: "host-device-enrollment-confirmation",
      enrollmentId: ENROLLMENT_ID,
      challenge: CHALLENGE,
      actorId: "canonical-device-actor",
    });

    const hostPrincipal = await server.app.inject({
      method: "POST",
      url: CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE,
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
      payload: REQUEST,
    });
    expect(hostPrincipal.statusCode).toBe(403);
    expect(hostPrincipal.json().code).toBe("CLOUD_DEVICE_ENROLLMENT_DEVICE_REQUIRED");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("uses the same canonical DeviceStore actor through the encrypted relay request path", async () => {
    const deviceStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => PAIRING_SECRET,
      generateToken: () => DEVICE_TOKEN,
      generateId: () => "relay-canonical-actor",
    });
    const pairing = deviceStore.issuePairing(1, ["relay"]);
    const enrollment = deviceStore.claimPairing(pairing.secret, "Relay browser", 2, generateRelayIdentity().publicKey)!;
    const confirm = vi.fn(async (input) => ({ actorId: input.actorId, deviceId: "cloud-relay-device" }));
    const server = createServer(config(), {
      deviceStore,
      cloudDeviceEnrollmentConfirmer: { confirm, complete },
      terminalAvailable: false,
    });
    servers.push(server);

    const response = await server.dispatchRelayRequest(
      enrollment.token,
      parseRelayRpcRequest({
        id: "cloud-enrollment-1",
        method: "POST",
        path: CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(REQUEST), "utf8").toString("base64url"),
      }),
    );
    expect(response.status).toBe(201);
    expect(decodeRelayBody(response.body)).toEqual({ enrolled: true, actorId: "relay-canonical-actor" });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ actorId: "relay-canonical-actor" }));
  });

  test("keeps self-hosted mode unchanged and maps retryable versus terminal upstream outcomes", async () => {
    const deviceStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => PAIRING_SECRET,
      generateToken: () => DEVICE_TOKEN,
      generateId: () => "device-without-cloud",
    });
    const enrollment = deviceStore.claimPairing(deviceStore.issuePairing(1).secret, "Browser", 2)!;
    const selfHosted = createServer(config(), { deviceStore, terminalAvailable: false });
    servers.push(selfHosted);
    const unavailable = await selfHosted.app.inject({
      method: "POST",
      url: CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE,
      headers: { authorization: `Bearer ${enrollment.token}` },
      payload: REQUEST,
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json().code).toBe("CLOUD_DEVICE_ENROLLMENT_UNAVAILABLE");

    const rejectionStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => `rcp_${"q".repeat(43)}`,
      generateToken: () => `rcd_${"e".repeat(43)}`,
      generateId: () => "rejected-device",
    });
    const rejectedEnrollment = rejectionStore.claimPairing(
      rejectionStore.issuePairing(1).secret,
      "Rejected browser",
      2,
    )!;
    const reject = vi.fn(async () => {
      throw new CloudDeviceEnrollmentError("REJECTED", false);
    });
    const rejectedServer = createServer(config(), {
      deviceStore: rejectionStore,
      cloudDeviceEnrollmentConfirmer: { confirm: reject, complete },
      terminalAvailable: false,
    });
    servers.push(rejectedServer);
    const rejected = await rejectedServer.app.inject({
      method: "POST",
      url: CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE,
      headers: { authorization: `Bearer ${rejectedEnrollment.token}` },
      payload: REQUEST,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("CLOUD_DEVICE_ENROLLMENT_REJECTED");
    expect(rejected.body).not.toContain(CHALLENGE);

    reject.mockImplementationOnce(async () => {
      throw new CloudDeviceEnrollmentError("UNAVAILABLE", true);
    });
    const retryable = await rejectedServer.app.inject({
      method: "POST",
      url: CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE,
      headers: { authorization: `Bearer ${rejectedEnrollment.token}` },
      payload: REQUEST,
    });
    expect(retryable.statusCode).toBe(502);
    expect(retryable.headers["retry-after"]).toBe("2");
    expect(retryable.body).not.toContain(CHALLENGE);
  });
});
