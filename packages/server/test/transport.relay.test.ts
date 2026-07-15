import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createServer,
  generateRelayIdentity,
  openDeviceStore,
  parseRelayRpcRequest,
  WsTicketStore,
} from "../src/index.js";
import type { CreateServerResult, ServerRuntimeConfig } from "../src/index.js";

const HOST_TOKEN = "relay-host-token";
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
    dataDir: process.cwd(),
    maxUploadBytes: 1024,
    allowedOrigins: [],
    rateLimitRpm: 0,
    rateLimitBurst: 120,
    maxSessions: 25,
    codexBin: process.execPath,
    claude: { claudeBin: process.execPath },
  };
}

function decodeBody(body: string | undefined): unknown {
  return body ? JSON.parse(Buffer.from(body, "base64url").toString("utf8")) : undefined;
}

describe("internal relay transport", () => {
  test("authenticates relay-only devices through normal API and terminal ticket hooks", async () => {
    const deviceStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => `rcp_${"p".repeat(43)}`,
      generateToken: () => `rcd_${"d".repeat(43)}`,
      generateId: () => "relay-device",
    });
    const identity = generateRelayIdentity();
    const pairing = deviceStore.issuePairing(1, ["relay"]);
    const enrollment = deviceStore.claimPairing(pairing.secret, "Relay browser", 2, identity.publicKey)!;
    const tickets = new WsTicketStore({ now: () => 10 });
    result = createServer(config(), { deviceStore, wsTickets: tickets, terminalAvailable: false });

    const direct = await result.app.inject({
      method: "GET",
      url: "/api/v1/capabilities",
      headers: { authorization: `Bearer ${enrollment.token}` },
    });
    expect(direct.statusCode).toBe(401);

    const relayed = await result.dispatchRelayRequest(
      enrollment.token,
      parseRelayRpcRequest({ id: "capabilities-1", method: "GET", path: "/api/v1/capabilities" }),
    );
    expect(relayed.status).toBe(200);
    expect(decodeBody(relayed.body)).toMatchObject({ features: { teamAuthorization: true } });

    const ticket = await result.issueRelayTerminalTicket(enrollment.token);
    expect(tickets.consumeWithContext(ticket)?.context).toMatchObject({
      actorType: "relay",
      actorId: "relay-device",
      label: "Relay browser",
    });
  });

  test("applies team default-deny and revocation to relayed requests", async () => {
    const deviceStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => `rcp_${"q".repeat(43)}`,
      generateToken: () => `rcd_${"e".repeat(43)}`,
      generateId: () => "unbound-relay-device",
    });
    const pairing = deviceStore.issuePairing(1, ["relay"]);
    const enrollment = deviceStore.claimPairing(pairing.secret, "Unbound relay", 2, generateRelayIdentity().publicKey)!;
    result = createServer(config(), { deviceStore, terminalAvailable: false });
    const authorization = { authorization: `Bearer ${HOST_TOKEN}` };
    const created = await result.app.inject({
      method: "POST",
      url: "/api/v1/team",
      headers: authorization,
      payload: { name: "Relay team", ownerName: "Owner" },
    });
    expect(created.statusCode).toBe(201);
    const revision = created.json().team.revision as number;
    const enabled = await result.app.inject({
      method: "PATCH",
      url: "/api/v1/team",
      headers: authorization,
      payload: { authorizationEnabled: true, expectedRevision: revision, confirm: true },
    });
    expect(enabled.statusCode).toBe(200);

    const denied = await result.dispatchRelayRequest(
      enrollment.token,
      parseRelayRpcRequest({ id: "denied-1", method: "GET", path: "/api/v1/capabilities" }),
    );
    expect(denied.status).toBe(403);
    expect(decodeBody(denied.body)).toMatchObject({ code: "TEAM_PERMISSION_DENIED" });

    expect(deviceStore.revoke("unbound-relay-device")).toBe(true);
    const revoked = await result.dispatchRelayRequest(
      enrollment.token,
      parseRelayRpcRequest({ id: "revoked-1", method: "GET", path: "/api/v1/capabilities" }),
    );
    expect(revoked.status).toBe(401);
    await expect(result.issueRelayTerminalTicket(enrollment.token)).rejects.toThrow("not authorized");
  });

  test("creates an authenticated no-store remote pairing package and temporary broker route", async () => {
    const deviceStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => `rcp_${"s".repeat(43)}`,
      generateToken: () => `rcd_${"t".repeat(43)}`,
      generateId: () => "bootstrap-device",
    });
    const hostIdentity = generateRelayIdentity();
    const putDevice = vi.fn().mockResolvedValue(undefined);
    result = createServer(config(), {
      deviceStore,
      terminalAvailable: false,
      relayEnabled: true,
      relayPairing: {
        appUrl: "https://app.roamcode.example",
        label: "Studio",
        relayUrl: "wss://relay.roamcode.example/v1/connect",
        routeId: "route-studio",
        hostIdentityPublicKey: hostIdentity.publicKey,
        hostIdentityFingerprint: hostIdentity.fingerprint,
        provisioner: { putDevice, revokeDevice: vi.fn() },
        generateDeviceCredential: () => `rrd_${"r".repeat(43)}`,
      },
    });

    const denied = await result.app.inject({ method: "POST", url: "/api/v1/relay/pairing" });
    expect(denied.statusCode).toBe(401);
    const response = await result.app.inject({
      method: "POST",
      url: "/api/v1/relay/pairing",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(putDevice).toHaveBeenCalledWith("bootstrap-device", expect.stringMatching(/^sha256:/), expect.any(Number));
    const body = response.json();
    expect(body.pairing).toMatchObject({
      v: 1,
      label: "Studio",
      deviceId: "bootstrap-device",
      deviceCredential: `rrd_${"r".repeat(43)}`,
      deviceToken: `rcd_${"t".repeat(43)}`,
      pairingSecret: `rcp_${"s".repeat(43)}`,
      hostIdentityFingerprint: hostIdentity.fingerprint,
    });
    const url = new URL(body.url as string);
    expect(url.origin).toBe("https://app.roamcode.example");
    expect(url.search).toBe("");
    const encoded = new URLSearchParams(url.hash.slice(1)).get("relay-pair")!;
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual(body.pairing);
  });
});
