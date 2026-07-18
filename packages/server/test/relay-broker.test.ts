import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import {
  generateRelayAccountCredential,
  openRelayAccountStore,
  relayAccountCredentialHash,
  relayAccountCredentialLookup,
} from "../src/relay-account-store.js";
import { createBlindRelayServer } from "../src/relay-broker.js";
import { generateRelayCredential, openRelayRouteStore, relayCredentialHash } from "../src/relay-store.js";

const opened: Array<{ app: { close(): Promise<unknown> } }> = [];

afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.app.close();
});

async function openSocket(url: string, origin?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, origin ? { origin } : undefined);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("relay socket did not open")), 5_000);
    socket.once("error", reject);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  return socket;
}

function nextJson(socket: WebSocket, predicate: (value: Record<string, unknown>) => boolean = () => true) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("relay message did not arrive"));
    }, 5_000);
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const value = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!predicate(value)) return;
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolve(value);
      } catch {
        /* wait for a valid matching frame */
      }
    };
    socket.on("message", onMessage);
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

async function fixture(
  options: {
    allowedOrigins?: string[];
    maxFrameBytes?: number;
    maxQueueBytes?: number;
    maxTotalConnections?: number;
    maxMessagesPerMinute?: number;
  } = {},
) {
  const rootToken = generateRelayCredential("rrp");
  const store = openRelayRouteStore({
    dbPath: ":memory:",
    generateRouteId: () => "route-1",
    loadDatabase: () => {
      throw new Error("memory fixture");
    },
  });
  const relay = createBlindRelayServer({ rootToken, store, ...options });
  opened.push(relay);
  const created = await relay.app.inject({
    method: "POST",
    url: "/v1/routes",
    headers: { authorization: `Bearer ${rootToken}` },
    payload: { label: "Test route" },
  });
  expect(created.statusCode).toBe(201);
  const hostCredential = created.json().hostCredential as string;
  const deviceCredential = generateRelayCredential("rrd");
  const registered = await relay.app.inject({
    method: "PUT",
    url: "/v1/routes/route-1/devices/device-1",
    headers: { authorization: `Bearer ${hostCredential}` },
    payload: { credentialHash: relayCredentialHash(deviceCredential) },
  });
  expect(registered.statusCode).toBe(200);
  const address = await relay.app.listen({ port: 0, host: "127.0.0.1" });
  const wsUrl = address.replace(/^http/, "ws") + "/v1/connect";
  return { relay, rootToken, hostCredential, deviceCredential, wsUrl };
}

async function connectHostAndDevice(config: Awaited<ReturnType<typeof fixture>>, origin?: string) {
  const host = await openSocket(config.wsUrl);
  const hostReady = nextJson(host, (value) => value.t === "ready");
  host.send(JSON.stringify({ v: 1, role: "host", routeId: "route-1", credential: config.hostCredential }));
  await expect(hostReady).resolves.toMatchObject({ role: "host", protocolVersion: 1 });

  const device = await openSocket(config.wsUrl, origin);
  const deviceReady = nextJson(device, (value) => value.t === "ready");
  const peerOpen = nextJson(host, (value) => value.t === "peer-open");
  device.send(
    JSON.stringify({
      v: 1,
      role: "device",
      routeId: "route-1",
      deviceId: "device-1",
      credential: config.deviceCredential,
    }),
  );
  const ready = await deviceReady;
  const peer = await peerOpen;
  expect(peer.channelId).toBe(ready.channelId);
  return { host, device, channelId: String(ready.channelId) };
}

describe("blind relay broker", () => {
  test("rejects malformed allowlist entries instead of silently disabling browser-origin policy", () => {
    const rootToken = generateRelayCredential("rrp");
    for (const origin of [
      "not-an-origin",
      "https://app.example/path",
      "https://user@app.example",
      "http://app.example",
    ]) {
      expect(() => createBlindRelayServer({ rootToken, allowedOrigins: [origin] })).toThrow(
        "invalid relay allowed origin",
      );
    }
    const loopback = createBlindRelayServer({ rootToken, allowedOrigins: ["http://127.0.0.1:5173"] });
    opened.push(loopback);
  });

  test("bounds total upgraded sockets before unauthenticated handshakes can exhaust the relay", async () => {
    const config = await fixture({ maxTotalConnections: 1 });
    const first = await openSocket(config.wsUrl);
    expect(config.relay.metrics().activeConnections).toBe(1);

    const rejected = new WebSocket(config.wsUrl);
    const rejectedClosed = closed(rejected);
    await new Promise<void>((resolve, reject) => {
      rejected.once("open", resolve);
      rejected.once("error", reject);
    });
    await expect(rejectedClosed).resolves.toBe(4429);
    expect(config.relay.metrics()).toMatchObject({ activeConnections: 1, rejectedConnections: 1 });

    const firstClosed = closed(first);
    first.close();
    await firstClosed;
    await expect.poll(() => config.relay.metrics().activeConnections).toBe(0);

    const recovered = await openSocket(config.wsUrl);
    expect(config.relay.metrics().activeConnections).toBe(1);
    recovered.close();
  });

  test("keeps message-rate state across reconnects and counts authentication and ping traffic", async () => {
    const config = await fixture({ maxMessagesPerMinute: 11 });
    const { host, device } = await connectHostAndDevice(config);
    for (let index = 0; index < 10; index += 1) {
      const pong = nextJson(device, (value) => value.t === "pong");
      device.send(JSON.stringify({ t: "ping" }));
      await pong;
    }

    const limited = closed(device);
    device.send(JSON.stringify({ t: "ping" }));
    await expect(limited).resolves.toBe(4429);

    const retry = await openSocket(config.wsUrl);
    const retryLimited = closed(retry);
    retry.send(
      JSON.stringify({
        v: 1,
        role: "device",
        routeId: "route-1",
        deviceId: "device-1",
        credential: config.deviceCredential,
      }),
    );
    await expect(retryLimited).resolves.toBe(4429);
    host.close();
  });

  test("closes a host whose saturated send queue cannot accept a pong", async () => {
    const config = await fixture({ maxQueueBytes: 1_024 });
    const host = await openSocket(config.wsUrl);
    const hostReady = nextJson(host, (value) => value.t === "ready");
    host.send(JSON.stringify({ v: 1, role: "host", routeId: "route-1", credential: config.hostCredential }));
    await hostReady;

    const getter = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount")?.get;
    expect(getter).toBeTypeOf("function");
    const clients = new WeakSet<WebSocket>([host]);
    let saturated = false;
    const bufferedAmount = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockImplementation(function (
      this: WebSocket,
    ) {
      return saturated && !clients.has(this) ? 2_048 : getter!.call(this);
    });
    try {
      const hostClosed = closed(host);
      saturated = true;
      host.send(JSON.stringify({ t: "ping" }));
      await expect(hostClosed).resolves.toBe(4408);
      await expect.poll(() => config.relay.metrics().activeHosts).toBe(0);
      expect(config.relay.metrics().droppedFrames).toBe(1);
    } finally {
      bufferedAmount.mockRestore();
    }
  });

  test("resets the host transport when device backpressure prevents peer-close delivery", async () => {
    const config = await fixture({ maxQueueBytes: 1_024 });
    const { host, device } = await connectHostAndDevice(config);
    const getter = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount")?.get;
    expect(getter).toBeTypeOf("function");
    const clients = new WeakSet<WebSocket>([host, device]);
    let saturated = false;
    const bufferedAmount = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockImplementation(function (
      this: WebSocket,
    ) {
      return saturated && !clients.has(this) ? 2_048 : getter!.call(this);
    });
    try {
      const hostClosed = closed(host);
      const deviceClosed = closed(device);
      saturated = true;
      device.send(JSON.stringify({ t: "ping" }));
      await expect(deviceClosed).resolves.toBe(4408);
      await expect(hostClosed).resolves.toBe(4408);
      await expect.poll(() => config.relay.metrics().activeDevices).toBe(0);
      await expect.poll(() => config.relay.metrics().activeHosts).toBe(0);
      expect(config.relay.metrics().droppedFrames).toBe(2);
    } finally {
      bufferedAmount.mockRestore();
    }
  });

  test("gives each hosted account isolated, quota-bound route management", async () => {
    const rootToken = generateRelayCredential("rrp");
    let accountSequence = 0;
    let routeSequence = 0;
    const accountStore = openRelayAccountStore({
      dbPath: ":memory:",
      generateAccountId: () => `rra_account000000000${++accountSequence}`,
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const store = openRelayRouteStore({
      dbPath: ":memory:",
      generateRouteId: () => `route-account-${++routeSequence}`,
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const relay = createBlindRelayServer({ rootToken, store, accountStore });
    opened.push(relay);

    const createAccount = async (label: string) => {
      const response = await relay.app.inject({
        method: "POST",
        url: "/v1/accounts",
        headers: { authorization: `Bearer ${rootToken}` },
        payload: { label, plan: "free", maxRoutes: 1, maxDevicesPerRoute: 1 },
      });
      expect(response.statusCode).toBe(201);
      return response.json() as { account: { id: string; revision: number }; accountCredential: string };
    };
    const first = await createAccount("First account");
    const second = await createAccount("Second account");
    expect(first.accountCredential).not.toBe(second.accountCredential);

    const hostCredential = generateRelayCredential("rrh");
    const createPayload = {
      id: "route-account-1",
      label: "Primary host",
      credentialHash: relayCredentialHash(hostCredential),
    };
    const created = await relay.app.inject({
      method: "POST",
      url: "/v1/account/routes",
      headers: { authorization: `Bearer ${first.accountCredential}` },
      payload: createPayload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      route: { id: "route-account-1", label: "Primary host", deviceCount: 0, hostOnline: false },
      connection: { path: "/v1/connect", protocolVersion: 1 },
    });
    expect(created.body).not.toContain(first.accountCredential);
    expect(created.body).not.toContain(rootToken);
    expect(created.body).not.toContain(hostCredential);
    expect(store.authenticateHost("route-account-1", hostCredential)).toBe(true);

    const idempotentReplay = await relay.app.inject({
      method: "POST",
      url: "/v1/account/routes",
      headers: { authorization: `Bearer ${first.accountCredential}` },
      payload: createPayload,
    });
    expect(idempotentReplay.statusCode).toBe(200);
    expect(idempotentReplay.json()).toMatchObject({ route: { id: "route-account-1" } });

    const conflictingReplay = await relay.app.inject({
      method: "POST",
      url: "/v1/account/routes",
      headers: { authorization: `Bearer ${first.accountCredential}` },
      payload: { ...createPayload, credentialHash: relayCredentialHash(generateRelayCredential("rrh")) },
    });
    expect(conflictingReplay.statusCode).toBe(409);

    const overQuota = await relay.app.inject({
      method: "POST",
      url: "/v1/account/routes",
      headers: { authorization: `Bearer ${first.accountCredential}` },
      payload: {
        id: "route-account-2",
        label: "Too many",
        credentialHash: relayCredentialHash(generateRelayCredential("rrh")),
      },
    });
    expect(overQuota.statusCode).toBe(429);
    expect(overQuota.json()).toMatchObject({ code: "RELAY_ROUTE_LIMIT" });

    const isolatedList = await relay.app.inject({
      method: "GET",
      url: "/v1/account/routes",
      headers: { authorization: `Bearer ${second.accountCredential}` },
    });
    expect(isolatedList.json()).toEqual({ routes: [] });
    const crossAccountDelete = await relay.app.inject({
      method: "DELETE",
      url: "/v1/account/routes/route-account-1",
      headers: { authorization: `Bearer ${second.accountCredential}` },
    });
    expect(crossAccountDelete.statusCode).toBe(404);
    expect(store.authenticateHost("route-account-1", hostCredential)).toBe(true);

    const nextHostCredential = generateRelayCredential("rrh");
    const rotatedHost = await relay.app.inject({
      method: "POST",
      url: "/v1/account/routes/route-account-1/credential",
      headers: { authorization: `Bearer ${first.accountCredential}` },
      payload: { credentialHash: relayCredentialHash(nextHostCredential) },
    });
    expect(rotatedHost.statusCode).toBe(204);
    expect(store.authenticateHost("route-account-1", hostCredential)).toBe(false);
    expect(store.authenticateHost("route-account-1", nextHostCredential)).toBe(true);

    const invalidRotation = await relay.app.inject({
      method: "POST",
      url: "/v1/account/routes/route-account-1/credential",
      headers: { authorization: `Bearer ${first.accountCredential}` },
      payload: { credentialHash: "not-a-hash" },
    });
    expect(invalidRotation.statusCode).toBe(400);
    const crossAccountRotation = await relay.app.inject({
      method: "POST",
      url: "/v1/account/routes/route-account-1/credential",
      headers: { authorization: `Bearer ${second.accountCredential}` },
      payload: { credentialHash: relayCredentialHash(generateRelayCredential("rrh")) },
    });
    expect(crossAccountRotation.statusCode).toBe(404);

    const inventory = await relay.app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: { authorization: `Bearer ${rootToken}` },
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.body).not.toContain(first.accountCredential);
    expect(inventory.body).not.toContain(second.accountCredential);
    expect(inventory.json().accounts).toHaveLength(2);
    accountStore.close();
  });

  test("account suspension closes live routes, deletion purges them, and rotation invalidates the old key", async () => {
    const rootToken = generateRelayCredential("rrp");
    const accountStore = openRelayAccountStore({
      dbPath: ":memory:",
      generateAccountId: () => "rra_account0000000001",
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const store = openRelayRouteStore({
      dbPath: ":memory:",
      generateRouteId: () => "route-account-1",
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const relay = createBlindRelayServer({ rootToken, store, accountStore });
    opened.push(relay);
    const accountResponse = await relay.app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { label: "Suspend me" },
    });
    const initial = accountResponse.json() as {
      account: { id: string; revision: number };
      accountCredential: string;
    };
    const rotatedResponse = await relay.app.inject({
      method: "POST",
      url: `/v1/accounts/${initial.account.id}/credential`,
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { expectedRevision: initial.account.revision },
    });
    expect(rotatedResponse.statusCode).toBe(200);
    const rotated = rotatedResponse.json() as {
      account: { revision: number };
      accountCredential: string;
    };
    const deniedOld = await relay.app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${initial.accountCredential}` },
    });
    expect(deniedOld.statusCode).toBe(401);

    const hostCredential = generateRelayCredential("rrh");
    const routeResponse = await relay.app.inject({
      method: "POST",
      url: "/v1/account/routes",
      headers: { authorization: `Bearer ${rotated.accountCredential}` },
      payload: {
        id: "route-account-1",
        label: "Live host",
        credentialHash: relayCredentialHash(hostCredential),
      },
    });
    expect(routeResponse.statusCode).toBe(201);
    expect(routeResponse.body).not.toContain(hostCredential);
    const address = await relay.app.listen({ port: 0, host: "127.0.0.1" });
    const host = await openSocket(address.replace(/^http/, "ws") + "/v1/connect");
    const ready = nextJson(host, (value) => value.t === "ready");
    host.send(JSON.stringify({ v: 1, role: "host", routeId: "route-account-1", credential: hostCredential }));
    await ready;
    const hostClosed = closed(host);

    const suspended = await relay.app.inject({
      method: "PATCH",
      url: `/v1/accounts/${initial.account.id}`,
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { status: "suspended", expectedRevision: rotated.account.revision },
    });
    expect(suspended.statusCode).toBe(200);
    await expect(hostClosed).resolves.toBe(4403);
    const deniedAccount = await relay.app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${rotated.accountCredential}` },
    });
    expect(deniedAccount.statusCode).toBe(401);
    const recoverableAccount = await relay.app.inject({
      method: "GET",
      url: "/v1/account/recovery",
      headers: { authorization: `Bearer ${rotated.accountCredential}` },
    });
    expect(recoverableAccount.statusCode).toBe(200);
    expect(recoverableAccount.json()).toMatchObject({ account: { status: "suspended" } });

    const retry = await openSocket(address.replace(/^http/, "ws") + "/v1/connect");
    const retryClosed = closed(retry);
    retry.send(JSON.stringify({ v: 1, role: "host", routeId: "route-account-1", credential: hostCredential }));
    await expect(retryClosed).resolves.toBe(4401);

    const deleted = await relay.app.inject({
      method: "PATCH",
      url: `/v1/accounts/${initial.account.id}`,
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { status: "deleted", expectedRevision: suspended.json().account.revision },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ account: { status: "deleted" }, usage: { routes: 0 } });
    expect(store.getRoute("route-account-1")).toBeUndefined();
    expect(
      (
        await relay.app.inject({
          method: "GET",
          url: "/v1/account/recovery",
          headers: { authorization: `Bearer ${rotated.accountCredential}` },
        })
      ).statusCode,
    ).toBe(401);
    accountStore.close();
  });

  test("reconciles routes for deleted or missing owner accounts when the relay starts", () => {
    const rootToken = generateRelayCredential("rrp");
    const accountStore = openRelayAccountStore({
      dbPath: ":memory:",
      generateAccountId: () => "rra_account0000000001",
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const store = openRelayRouteStore({
      dbPath: ":memory:",
      generateRouteId: () => "route-orphaned-1",
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const account = accountStore.createAccount({
      label: "Deleted account",
      credential: generateRelayAccountCredential(),
    });
    store.createRoute({
      label: "Orphaned route",
      hostCredentialHash: relayCredentialHash(generateRelayCredential("rrh")),
      ownerAccountId: account.id,
    });
    store.createRoute({
      id: "route-missing-owner",
      label: "Missing owner",
      hostCredentialHash: relayCredentialHash(generateRelayCredential("rrh")),
      ownerAccountId: "rra_missing0000000001",
    });
    accountStore.updateAccount(account.id, { status: "deleted" }, account.revision);

    const relay = createBlindRelayServer({ rootToken, store, accountStore });
    opened.push(relay);
    expect(store.getRoute("route-orphaned-1")).toBeUndefined();
    expect(store.getRoute("route-missing-owner")).toBeUndefined();
    accountStore.close();
  });

  test("accepts pre-hashed account credentials without returning or learning the capability", async () => {
    const rootToken = generateRelayCredential("rrp");
    const accountStore = openRelayAccountStore({
      dbPath: ":memory:",
      generateAccountId: () => "rra_account0000000001",
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const relay = createBlindRelayServer({ rootToken, accountStore });
    opened.push(relay);
    const first = generateRelayAccountCredential();
    const created = await relay.app.inject({
      method: "POST",
      url: "/v1/accounts/client-hashed",
      headers: { authorization: `Bearer ${rootToken}` },
      payload: {
        label: "Locally provisioned",
        credentialHash: relayAccountCredentialHash(first),
        credentialLookup: relayAccountCredentialLookup(first),
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ account: { id: "rra_account0000000001", revision: 1 } });
    expect(created.json()).not.toHaveProperty("accountCredential");
    expect(created.body).not.toContain(first);
    const authenticated = await relay.app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${first}` },
    });
    expect(authenticated.statusCode).toBe(200);

    const next = generateRelayAccountCredential();
    const rotated = await relay.app.inject({
      method: "POST",
      url: "/v1/accounts/rra_account0000000001/credential/client-hashed",
      headers: { authorization: `Bearer ${rootToken}` },
      payload: {
        expectedRevision: 1,
        credentialHash: relayAccountCredentialHash(next),
        credentialLookup: relayAccountCredentialLookup(next),
      },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).not.toHaveProperty("accountCredential");
    expect(rotated.body).not.toContain(next);
    expect(
      (
        await relay.app.inject({
          method: "GET",
          url: "/v1/account",
          headers: { authorization: `Bearer ${first}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await relay.app.inject({
          method: "GET",
          url: "/v1/account",
          headers: { authorization: `Bearer ${next}` },
        })
      ).statusCode,
    ).toBe(200);

    const partialMaterial = await relay.app.inject({
      method: "POST",
      url: "/v1/accounts/client-hashed",
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { label: "Incomplete", credentialHash: relayAccountCredentialHash(first) },
    });
    expect(partialMaterial.statusCode).toBe(400);
    accountStore.close();
  });

  test("provisions hashed route capabilities and exposes no credential in inventory", async () => {
    const config = await fixture();
    const unauthorized = await config.relay.app.inject({ method: "GET", url: "/v1/routes" });
    expect(unauthorized.statusCode).toBe(401);
    const inventory = await config.relay.app.inject({
      method: "GET",
      url: "/v1/routes",
      headers: { authorization: `Bearer ${config.rootToken}` },
    });
    expect(inventory.json()).toEqual({
      routes: [expect.objectContaining({ id: "route-1", label: "Test route", deviceCount: 1 })],
    });
    expect(inventory.body).not.toContain(config.rootToken);
    expect(inventory.body).not.toContain(config.hostCredential);
    expect(inventory.body).not.toContain(config.deviceCredential);
    const health = await config.relay.app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toEqual({ status: "ok", protocolVersion: 1 });
    expect(health.headers).toMatchObject({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    });
    const ready = await config.relay.app.inject({ method: "GET", url: "/ready" });
    expect(ready.json()).toEqual({ status: "ready", protocolVersion: 1 });
    const hiddenMetrics = await config.relay.app.inject({ method: "GET", url: "/v1/metrics" });
    expect(hiddenMetrics.statusCode).toBe(401);
    const metrics = await config.relay.app.inject({
      method: "GET",
      url: "/v1/metrics",
      headers: { authorization: `Bearer ${config.rootToken}` },
    });
    expect(metrics.json()).toMatchObject({
      protocolVersion: 1,
      metrics: { activeHosts: 0, activeDevices: 0, acceptedConnections: 0 },
    });
  });

  test("accepts a previous root capability only during an explicit rotation window", async () => {
    const current = generateRelayCredential("rrp");
    const previous = generateRelayCredential("rrp");
    const relay = createBlindRelayServer({ rootToken: current, previousRootTokens: [previous] });
    opened.push(relay);

    const oldAccess = await relay.app.inject({
      method: "GET",
      url: "/v1/routes",
      headers: { authorization: `Bearer ${previous}` },
    });
    expect(oldAccess.statusCode).toBe(200);
    const unknown = await relay.app.inject({
      method: "GET",
      url: "/v1/routes",
      headers: { authorization: `Bearer ${generateRelayCredential("rrp")}` },
    });
    expect(unknown.statusCode).toBe(401);
  });

  test("forwards opaque envelopes bidirectionally and keeps channels isolated", async () => {
    const config = await fixture();
    const { host, device, channelId } = await connectHostAndDevice(config);
    const opaque = randomBytes(128).toString("base64url");
    const fromDevice = nextJson(host, (value) => value.t === "frame");
    device.send(JSON.stringify({ t: "frame", payload: opaque }));
    await expect(fromDevice).resolves.toEqual({ t: "frame", channelId, payload: opaque });

    const reply = randomBytes(96).toString("base64url");
    const fromHost = nextJson(device, (value) => value.t === "frame");
    host.send(JSON.stringify({ t: "frame", channelId, payload: reply }));
    await expect(fromHost).resolves.toEqual({ t: "frame", payload: reply });
    expect(config.relay.metrics()).toMatchObject({
      activeHosts: 1,
      activeDevices: 1,
      forwardedFrames: 2,
      forwardedBytes: 224,
    });
    host.close();
    device.close();
  });

  test("rejects wrong credentials and an untrusted browser origin without route enumeration", async () => {
    const config = await fixture({ allowedOrigins: ["https://app.example"] });
    const wrong = await openSocket(config.wsUrl);
    const wrongClosed = closed(wrong);
    wrong.send(
      JSON.stringify({
        v: 1,
        role: "host",
        routeId: "route-1",
        credential: generateRelayCredential("rrh"),
      }),
    );
    await expect(wrongClosed).resolves.toBe(4401);

    const host = await openSocket(config.wsUrl);
    const hostReady = nextJson(host, (value) => value.t === "ready");
    host.send(JSON.stringify({ v: 1, role: "host", routeId: "route-1", credential: config.hostCredential }));
    await hostReady;
    const denied = await openSocket(config.wsUrl, "https://evil.example");
    const deniedClosed = closed(denied);
    denied.send(
      JSON.stringify({
        v: 1,
        role: "device",
        routeId: "route-1",
        deviceId: "device-1",
        credential: config.deviceCredential,
      }),
    );
    await expect(deniedClosed).resolves.toBe(4403);

    const invalidOrigin = await openSocket(config.wsUrl, "null");
    const invalidOriginClosed = closed(invalidOrigin);
    invalidOrigin.send(
      JSON.stringify({
        v: 1,
        role: "device",
        routeId: "route-1",
        deviceId: "device-1",
        credential: config.deviceCredential,
      }),
    );
    await expect(invalidOriginClosed).resolves.toBe(4403);
    host.close();
  });

  test("device revocation closes the live channel and blocks reconnect", async () => {
    const config = await fixture();
    const { host, device } = await connectHostAndDevice(config);
    const deviceClosed = closed(device);
    const revoked = await config.relay.app.inject({
      method: "DELETE",
      url: "/v1/routes/route-1/devices/device-1",
      headers: { authorization: `Bearer ${config.hostCredential}` },
    });
    expect(revoked.statusCode).toBe(204);
    await expect(deviceClosed).resolves.toBe(4403);

    const retry = await openSocket(config.wsUrl);
    const retryClosed = closed(retry);
    retry.send(
      JSON.stringify({
        v: 1,
        role: "device",
        routeId: "route-1",
        deviceId: "device-1",
        credential: config.deviceCredential,
      }),
    );
    await expect(retryClosed).resolves.toBe(4401);
    host.close();
  });

  test("compare-and-swap revocation is conflict-safe and idempotent for an absent exact target", async () => {
    const config = await fixture();
    const endpoint = "/v1/routes/route-1/devices/device-1";
    const headers = { authorization: `Bearer ${config.hostCredential}` };
    const wrong = await config.relay.app.inject({
      method: "DELETE",
      url: endpoint,
      headers,
      payload: { expectedCredentialHash: relayCredentialHash(generateRelayCredential("rrd")) },
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().code).toBe("RELAY_DEVICE_CREDENTIAL_CONFLICT");

    const expectedCredentialHash = relayCredentialHash(config.deviceCredential);
    const exact = await config.relay.app.inject({
      method: "DELETE",
      url: endpoint,
      headers,
      payload: { expectedCredentialHash },
    });
    expect(exact.statusCode).toBe(204);
    const replay = await config.relay.app.inject({
      method: "DELETE",
      url: endpoint,
      headers,
      payload: { expectedCredentialHash },
    });
    expect(replay.statusCode).toBe(204);

    const legacyAbsent = await config.relay.app.inject({ method: "DELETE", url: endpoint, headers });
    expect(legacyAbsent.statusCode).toBe(404);
  });

  test("superseding a host drops old E2E channels and oversized frames fail closed", async () => {
    const config = await fixture({ maxFrameBytes: 1024 });
    const first = await connectHostAndDevice(config);
    const oldHostClosed = closed(first.host);
    const deviceClosed = closed(first.device);
    const nextHost = await openSocket(config.wsUrl);
    const nextReady = nextJson(nextHost, (value) => value.t === "ready");
    nextHost.send(JSON.stringify({ v: 1, role: "host", routeId: "route-1", credential: config.hostCredential }));
    await nextReady;
    await expect(oldHostClosed).resolves.toBe(4409);
    await expect(deviceClosed).resolves.toBe(4412);

    const nextDevice = await openSocket(config.wsUrl);
    const ready = nextJson(nextDevice, (value) => value.t === "ready");
    nextDevice.send(
      JSON.stringify({
        v: 1,
        role: "device",
        routeId: "route-1",
        deviceId: "device-1",
        credential: config.deviceCredential,
      }),
    );
    await ready;
    const tooLargeClosed = closed(nextDevice);
    nextDevice.send(JSON.stringify({ t: "frame", payload: randomBytes(1025).toString("base64url") }));
    await expect(tooLargeClosed).resolves.toBe(4400);

    const transportBoundDevice = await openSocket(config.wsUrl);
    const transportReady = nextJson(transportBoundDevice, (value) => value.t === "ready");
    transportBoundDevice.send(
      JSON.stringify({
        v: 1,
        role: "device",
        routeId: "route-1",
        deviceId: "device-1",
        credential: config.deviceCredential,
      }),
    );
    await transportReady;
    const transportBoundClosed = closed(transportBoundDevice);
    transportBoundDevice.send("x".repeat(20_000));
    await expect(transportBoundClosed).resolves.toBe(1009);
    nextHost.close();
  });
});
