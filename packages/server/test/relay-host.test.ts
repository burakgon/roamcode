import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { createBrowserRelayClient, type BrowserRelayClient } from "../../web/src/relay/client.js";
import {
  createBlindRelayServer,
  createRelayHostConnector,
  createServer,
  decodeRelayWireEnvelope,
  encodeRelayWireEnvelope,
  generateRelayCredential,
  generateRelayIdentity,
  openDeviceStore,
  openRelayRouteStore,
  relayCredentialHash,
  type DeviceStore,
  type RelayHttpOpener,
  type RelayHostConnector,
  type RelayIdentity,
  type RelayTerminalHandlers,
  type RelayTerminalOpener,
  type ServerRuntimeConfig,
} from "../src/index.js";
import {
  createBrowserRelayHandshakeHello,
  establishBrowserRelayChannel,
  generateBrowserRelayIdentity,
  type BrowserRelayCipherState,
  type BrowserRelayIdentity,
} from "../../web/src/relay/crypto.js";

const ROOT_TOKEN = `rrp_${"r".repeat(43)}`;
const DEVICE_TOKEN = `rcd_${"d".repeat(43)}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const apps: Array<{ close(): Promise<unknown> }> = [];
const connectors: RelayHostConnector[] = [];
const browserClients: BrowserRelayClient[] = [];
const sockets: WebSocket[] = [];
const stores: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const client of browserClients.splice(0)) client.close();
  for (const socket of sockets.splice(0)) socket.close();
  for (const connector of connectors.splice(0)) await connector.stop();
  while (apps.length > 0) await apps.pop()!.close();
  while (stores.length > 0) stores.pop()!.close();
});

function config(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: "host-api-token",
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

function nextJson(socket: WebSocket, predicate: (value: Record<string, unknown>) => boolean = () => true) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay device message timed out")), 5_000);
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const value = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!predicate(value)) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(value);
      } catch {
        /* wait for a matching broker message */
      }
    };
    socket.on("message", onMessage);
  });
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function fixture(
  openTerminal?: RelayTerminalOpener,
  openHttp?: RelayHttpOpener,
  connectorOptions: { maxStreamRequestBytes?: number } = {},
) {
  const relayStore = openRelayRouteStore({ dbPath: ":memory:", generateRouteId: () => "route-1" });
  stores.push(relayStore);
  const relay = createBlindRelayServer({ rootToken: ROOT_TOKEN, store: relayStore });
  apps.push(relay.app);
  const route = await relay.app.inject({
    method: "POST",
    url: "/v1/routes",
    headers: { authorization: `Bearer ${ROOT_TOKEN}` },
    payload: { label: "Host connector" },
  });
  const hostCredential = route.json().hostCredential as string;
  const browserIdentity = await generateBrowserRelayIdentity();
  const deviceStore = openDeviceStore({
    dbPath: ":memory:",
    generateSecret: () => `rcp_${"p".repeat(43)}`,
    generateToken: () => DEVICE_TOKEN,
    generateId: () => "device-1",
  });
  const pairing = deviceStore.issuePairing(1, ["relay"]);
  deviceStore.claimPairing(pairing.secret, "Browser device", 2, browserIdentity.publicKey);
  const deviceCredential = generateRelayCredential("rrd");
  relayStore.putDevice({
    routeId: "route-1",
    deviceId: "device-1",
    credentialHash: relayCredentialHash(deviceCredential),
  });
  const api = createServer(config(), { deviceStore, terminalAvailable: false });
  apps.push(api.app);
  const relayAddress = await relay.app.listen({ host: "127.0.0.1", port: 0 });
  const hostIdentity = generateRelayIdentity();
  const connector = createRelayHostConnector({
    relayUrl: relayAddress,
    routeId: "route-1",
    hostCredential,
    hostIdentity,
    devices: deviceStore,
    dispatchRequest: api.dispatchRelayRequest,
    ...(openTerminal ? { openTerminal } : {}),
    ...(openHttp ? { openHttp } : {}),
    ...connectorOptions,
  });
  connectors.push(connector);
  connector.start();
  await connector.waitUntilReady();
  return {
    relay,
    api,
    connector,
    deviceStore,
    browserIdentity,
    hostIdentity,
    deviceCredential,
    relayAddress,
    wsUrl: relayAddress.replace(/^http/, "ws") + "/v1/connect",
  };
}

async function brokerDeviceSocket(setup: { wsUrl: string; deviceCredential: string }): Promise<WebSocket> {
  const socket = await openSocket(setup.wsUrl);
  const ready = nextJson(socket, (message) => message.t === "ready");
  socket.send(
    JSON.stringify({
      v: 1,
      role: "device",
      routeId: "route-1",
      deviceId: "device-1",
      credential: setup.deviceCredential,
    }),
  );
  await ready;
  return socket;
}

async function connectDevice(setup: {
  wsUrl: string;
  deviceCredential: string;
  browserIdentity: BrowserRelayIdentity;
  hostIdentity: RelayIdentity;
}): Promise<{ socket: WebSocket; cipher: BrowserRelayCipherState }> {
  const socket = await brokerDeviceSocket(setup);
  const device = await createBrowserRelayHandshakeHello({
    role: "device",
    routeId: "route-1",
    deviceId: "device-1",
    identity: setup.browserIdentity,
  });
  const hostFrame = nextJson(socket, (message) => message.t === "frame");
  socket.send(
    JSON.stringify({
      t: "frame",
      payload: encodeRelayWireEnvelope({ v: 1, t: "device-hello", hello: device.hello }),
    }),
  );
  const hostEnvelope = decodeRelayWireEnvelope((await hostFrame).payload);
  if (hostEnvelope.t !== "host-hello") throw new Error("host hello missing");
  const cipher = await establishBrowserRelayChannel({
    role: "device",
    localEphemeral: device.ephemeral,
    deviceHello: device.hello,
    hostHello: hostEnvelope.hello,
    deviceIdentityPublicKey: setup.browserIdentity.publicKey,
    hostIdentityPublicKey: setup.hostIdentity.publicKey,
  });
  const authResponse = nextJson(socket, (message) => message.t === "frame");
  const authFrame = await cipher.encrypt("auth", encoder.encode(JSON.stringify({ token: DEVICE_TOKEN })));
  socket.send(
    JSON.stringify({ t: "frame", payload: encodeRelayWireEnvelope({ v: 1, t: "cipher", frame: authFrame }) }),
  );
  const encryptedAuth = decodeRelayWireEnvelope((await authResponse).payload);
  if (encryptedAuth.t !== "cipher") throw new Error("encrypted auth response missing");
  expect(JSON.parse(decoder.decode(await cipher.decrypt(encryptedAuth.frame)))).toMatchObject({
    ok: true,
    deviceId: "device-1",
    hostIdentityFingerprint: setup.hostIdentity.fingerprint,
  });
  return { socket, cipher };
}

async function rpc(
  socket: WebSocket,
  cipher: BrowserRelayCipherState,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = nextJson(socket, (message) => message.t === "frame");
  const requestFrame = await cipher.encrypt("rpc-request", encoder.encode(JSON.stringify(request)));
  socket.send(
    JSON.stringify({ t: "frame", payload: encodeRelayWireEnvelope({ v: 1, t: "cipher", frame: requestFrame }) }),
  );
  const envelope = decodeRelayWireEnvelope((await response).payload);
  if (envelope.t !== "cipher") throw new Error("encrypted RPC response missing");
  return JSON.parse(decoder.decode(await cipher.decrypt(envelope.frame))) as Record<string, unknown>;
}

describe("outbound relay host connector", () => {
  test("bootstraps a new browser through a temporary route and promotes it after the E2E claim", async () => {
    const now = Date.now();
    const relayStore = openRelayRouteStore({ dbPath: ":memory:", generateRouteId: () => "route-bootstrap" });
    stores.push(relayStore);
    const hostCredential = generateRelayCredential("rrh");
    relayStore.createRoute({
      id: "route-bootstrap",
      label: "Bootstrap",
      hostCredentialHash: relayCredentialHash(hostCredential),
    });
    const deviceCredential = generateRelayCredential("rrd");
    const deviceToken = `rcd_${"b".repeat(43)}`;
    const deviceStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => `rcp_${"b".repeat(43)}`,
      generateToken: () => deviceToken,
      generateId: () => "bootstrap-device",
    });
    const pairing = deviceStore.issueRelayPairing(now);
    relayStore.putDevice(
      {
        routeId: "route-bootstrap",
        deviceId: pairing.deviceId,
        credentialHash: relayCredentialHash(deviceCredential),
        expiresAt: pairing.expiresAt,
      },
      now,
    );
    const relay = createBlindRelayServer({ rootToken: ROOT_TOKEN, store: relayStore });
    apps.push(relay.app);
    const relayAddress = await relay.app.listen({ host: "127.0.0.1", port: 0 });
    const api = createServer(config(), { deviceStore, terminalAvailable: false, relayEnabled: true });
    apps.push(api.app);
    const hostIdentity = generateRelayIdentity();
    const promoteDevice = vi.fn(async (deviceId: string, credentialHash: string) => {
      relayStore.putDevice({ routeId: "route-bootstrap", deviceId, credentialHash });
    });
    const connector = createRelayHostConnector({
      relayUrl: relayAddress,
      routeId: "route-bootstrap",
      hostCredential,
      hostIdentity,
      devices: deviceStore,
      dispatchRequest: api.dispatchRelayRequest,
      promoteDevice,
    });
    connectors.push(connector);
    connector.start();
    await connector.waitUntilReady();

    const identity = await generateBrowserRelayIdentity();
    const paired = vi.fn();
    const client = createBrowserRelayClient({
      relayUrl: relayAddress,
      routeId: "route-bootstrap",
      deviceId: pairing.deviceId,
      deviceCredential,
      deviceToken: pairing.token,
      identity,
      hostIdentityPublicKey: hostIdentity.publicKey,
      pairing: { secret: pairing.secret, name: "Travel phone", onPaired: paired },
      webSocketFactory: (url) => {
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket as never;
      },
    });
    browserClients.push(client);
    client.start();
    await client.ready();

    expect(paired).toHaveBeenCalledOnce();
    expect(deviceStore.authenticate(deviceToken, Date.now(), "relay")).toMatchObject({
      id: "bootstrap-device",
      name: "Travel phone",
      relayIdentityFingerprint: identity.fingerprint,
    });
    expect(promoteDevice).toHaveBeenCalledWith("bootstrap-device", relayCredentialHash(deviceCredential));
    expect(relayStore.getDevice("route-bootstrap", "bootstrap-device")?.expiresAt).toBeUndefined();
    const response = await client.fetch("https://host.invalid/api/v1/capabilities");
    expect(response.status).toBe(200);
  });

  test("multiplexes terminal bytes, controls, input, resize, and ownership frames over E2E", async () => {
    let terminalHandlers: RelayTerminalHandlers | undefined;
    const localInput: string[] = [];
    const openTerminal = vi.fn<RelayTerminalOpener>(async (_token, _request, handlers) => {
      terminalHandlers = handlers;
      return {
        send: (data) => void localInput.push(data),
        close: vi.fn(),
      };
    });
    const setup = await fixture(openTerminal);
    const client = createBrowserRelayClient({
      relayUrl: setup.relayAddress,
      routeId: "route-1",
      deviceId: "device-1",
      deviceCredential: setup.deviceCredential,
      deviceToken: DEVICE_TOKEN,
      identity: setup.browserIdentity,
      hostIdentityPublicKey: setup.hostIdentity.publicKey,
      webSocketFactory: (url) => {
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket as never;
      },
    });
    browserClients.push(client);
    client.start();
    await client.ready();

    const output: number[][] = [];
    const controls: string[] = [];
    const statuses: string[] = [];
    let opened!: () => void;
    const openStatus = new Promise<void>((resolve) => (opened = resolve));
    const terminal = client.openTerminal({
      sessionId: "session-1",
      cols: 90,
      rows: 30,
      onData: (data) => output.push([...data]),
      onControl: (data) => controls.push(data),
      onStatus: (status) => {
        statuses.push(status);
        if (status === "open") opened();
      },
    });
    await openStatus;
    expect(openTerminal).toHaveBeenCalledWith(
      DEVICE_TOKEN,
      expect.objectContaining({ streamId: expect.any(String), sessionId: "session-1", cols: 90, rows: 30 }),
      expect.any(Object),
    );

    terminalHandlers!.onBinary(Uint8Array.from([0, 1, 2, 255]));
    terminalHandlers!.onControl('{"t":"lease","event":"granted"}');
    await vi.waitFor(() => expect(output).toEqual([[0, 1, 2, 255]]));
    await vi.waitFor(() => expect(controls).toEqual(['{"t":"lease","event":"granted"}']));

    terminal.sendInput("approve");
    terminal.sendResize(120, 40);
    terminal.requestInputLease("takeover", true);
    await vi.waitFor(() => expect(localInput).toHaveLength(3));
    expect(localInput.map((value) => JSON.parse(value))).toEqual([
      { t: "i", d: "approve" },
      { t: "r", c: 120, r: 40 },
      { t: "lease", action: "takeover", confirm: true },
    ]);

    terminalHandlers!.onClose(4410);
    await vi.waitFor(() => expect(statuses.at(-1)).toBe("ended"));
    terminal.close();
  });

  test("provides a browser fetch transport without putting either credential in a URL", async () => {
    const setup = await fixture();
    const openedUrls: string[] = [];
    const client = createBrowserRelayClient({
      relayUrl: setup.relayAddress,
      routeId: "route-1",
      deviceId: "device-1",
      deviceCredential: setup.deviceCredential,
      deviceToken: DEVICE_TOKEN,
      identity: setup.browserIdentity,
      hostIdentityPublicKey: setup.hostIdentity.publicKey,
      webSocketFactory: (url) => {
        openedUrls.push(url);
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket as never;
      },
    });
    browserClients.push(client);
    client.start();
    await client.ready();
    const response = await client.fetch("https://host.invalid/api/v1/capabilities", {
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ features: { relay: false, teamAuthorization: true } });
    expect(openedUrls).toEqual([setup.wsUrl]);
    expect(openedUrls[0]).not.toContain(DEVICE_TOKEN);
    expect(openedUrls[0]).not.toContain(setup.deviceCredential);
    expect(client.status()).toBe("online");
  });

  test("streams large HTTP request and response bodies with bounded flow-control credit", async () => {
    const uploaded: Buffer[] = [];
    const responseBody = Buffer.alloc(1024 * 1024 + 137, 0x5a);
    let bridgeClosed = false;
    const openHttp = vi.fn<RelayHttpOpener>(async (_token, request, handlers) => ({
      async write(data) {
        uploaded.push(Buffer.from(data));
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      end() {
        void (async () => {
          await handlers.onResponse({
            status: 201,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(responseBody.byteLength),
            },
          });
          for (let offset = 0; offset < responseBody.byteLength; offset += 91_337) {
            await handlers.onData(responseBody.subarray(offset, Math.min(responseBody.byteLength, offset + 91_337)));
          }
          await handlers.onEnd();
        })().catch((error) => handlers.onError(error as Error));
      },
      close() {
        bridgeClosed = true;
      },
    }));
    const setup = await fixture(undefined, openHttp);
    const client = createBrowserRelayClient({
      relayUrl: setup.relayAddress,
      routeId: "route-1",
      deviceId: "device-1",
      deviceCredential: setup.deviceCredential,
      deviceToken: DEVICE_TOKEN,
      identity: setup.browserIdentity,
      hostIdentityPublicKey: setup.hostIdentity.publicKey,
      webSocketFactory: (url) => {
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket as never;
      },
    });
    browserClients.push(client);
    client.start();
    await client.ready();

    const requestBody = Buffer.alloc(1024 * 1024 + 73, 0x2a);
    const progress: number[] = [];
    const transfer = client.upload(
      "https://host.invalid/files/stream",
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: requestBody,
      },
      (fraction) => progress.push(fraction),
      requestBody.byteLength,
    );
    const response = await transfer.promise;
    expect(response.status).toBe(201);
    await expect(response.arrayBuffer()).resolves.toEqual(
      responseBody.buffer.slice(responseBody.byteOffset, responseBody.byteOffset + responseBody.byteLength),
    );
    expect(Buffer.concat(uploaded)).toEqual(requestBody);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress.some((fraction) => fraction > 0 && fraction < 1)).toBe(true);
    expect(progress.every((fraction, index) => index === 0 || fraction >= progress[index - 1]!)).toBe(true);
    expect(openHttp).toHaveBeenCalledWith(
      DEVICE_TOKEN,
      expect.objectContaining({ method: "POST", path: "/files/stream" }),
      expect.any(Object),
    );
    await vi.waitFor(() =>
      expect(setup.connector.metrics()).toMatchObject({
        activeTransfers: 0,
        completedTransfers: 1,
        failedTransfers: 0,
        streamedRequestBytes: requestBody.byteLength,
        streamedResponseBytes: responseBody.byteLength,
      }),
    );
    expect(bridgeClosed).toBe(true);
  });

  test("cancels an in-flight HTTP stream at the host when the browser stops reading", async () => {
    const close = vi.fn();
    const openHttp = vi.fn<RelayHttpOpener>(async (_token, _request, handlers) => ({
      async write() {},
      end() {
        void (async () => {
          await handlers.onResponse({
            status: 200,
            headers: { "content-type": "application/octet-stream", "content-length": "1048576" },
          });
          await handlers.onData(Buffer.alloc(64 * 1024, 0x4f));
        })().catch((error) => handlers.onError(error as Error));
      },
      close,
    }));
    const setup = await fixture(undefined, openHttp);
    const client = createBrowserRelayClient({
      relayUrl: setup.relayAddress,
      routeId: "route-1",
      deviceId: "device-1",
      deviceCredential: setup.deviceCredential,
      deviceToken: DEVICE_TOKEN,
      identity: setup.browserIdentity,
      hostIdentityPublicKey: setup.hostIdentity.publicKey,
      webSocketFactory: (url) => {
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket as never;
      },
    });
    browserClients.push(client);
    client.start();
    await client.ready();

    const response = await client.fetch("https://host.invalid/fs/download?path=%2Flarge.bin");
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: expect.any(Uint8Array) });
    await reader.cancel();

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(setup.connector.metrics()).toMatchObject({ activeTransfers: 0, completedTransfers: 0, failedTransfers: 1 });
  });

  test("closes and tombstones an oversized upload before buffered chunks can reach loopback", async () => {
    const uploaded: Buffer[] = [];
    const close = vi.fn();
    const openHttp = vi.fn<RelayHttpOpener>(async () => ({
      async write(data) {
        uploaded.push(Buffer.from(data));
      },
      end() {},
      close,
    }));
    const setup = await fixture(undefined, openHttp, { maxStreamRequestBytes: 1024 * 1024 });
    const client = createBrowserRelayClient({
      relayUrl: setup.relayAddress,
      routeId: "route-1",
      deviceId: "device-1",
      deviceCredential: setup.deviceCredential,
      deviceToken: DEVICE_TOKEN,
      identity: setup.browserIdentity,
      hostIdentityPublicKey: setup.hostIdentity.publicKey,
      webSocketFactory: (url) => {
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket as never;
      },
    });
    browserClients.push(client);
    client.start();
    await client.ready();

    const requestBody = Buffer.alloc(1024 * 1024 + 128 * 1024, 0x6b);
    const transfer = client.upload(
      "https://host.invalid/files/too-large",
      { method: "POST", headers: { "content-type": "application/octet-stream" }, body: requestBody },
      () => undefined,
      requestBody.byteLength,
    );
    await expect(transfer.promise).rejects.toThrow(/ended before completion/i);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(Buffer.concat(uploaded).byteLength).toBe(1024 * 1024);
    expect(setup.connector.metrics()).toMatchObject({ activeTransfers: 0, completedTransfers: 0, failedTransfers: 1 });
  });

  test("runs an authenticated E2E API request through the blind broker", async () => {
    const setup = await fixture();
    const device = await connectDevice(setup);
    const response = await rpc(device.socket, device.cipher, {
      id: "capabilities-1",
      method: "GET",
      path: "/api/v1/capabilities",
      headers: {},
    });
    expect(response).toMatchObject({ id: "capabilities-1", status: 200 });
    const body = JSON.parse(Buffer.from(response.body as string, "base64url").toString("utf8"));
    expect(body).toMatchObject({ features: { teamAuthorization: true, inputLeases: true } });
    expect(setup.connector.metrics()).toMatchObject({
      status: "online",
      activeChannels: 1,
      acceptedChannels: 1,
      completedRequests: 1,
      rejectedChannels: 0,
    });
    expect(setup.relay.metrics().forwardedFrames).toBeGreaterThanOrEqual(6);
  });

  test("isolates a false device identity without dropping the host route", async () => {
    const setup = await fixture();
    const socket = await brokerDeviceSocket(setup);
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    const unrelated = await generateBrowserRelayIdentity();
    const hello = await createBrowserRelayHandshakeHello({
      role: "device",
      routeId: "route-1",
      deviceId: "device-1",
      identity: unrelated,
    });
    socket.send(
      JSON.stringify({
        t: "frame",
        payload: encodeRelayWireEnvelope({ v: 1, t: "device-hello", hello: hello.hello }),
      }),
    );
    await expect(closed).resolves.toBe(4400);
    expect(setup.connector.metrics()).toMatchObject({ status: "online", activeChannels: 0, rejectedChannels: 1 });

    const legitimate = await connectDevice(setup);
    expect(legitimate.cipher.sequences()).toEqual({ send: "1", receive: "1" });
    expect(setup.connector.metrics()).toMatchObject({ status: "online", activeChannels: 1, acceptedChannels: 1 });
  });

  test("revocation denies the next request and can close the live channel immediately", async () => {
    const setup = await fixture();
    const device = await connectDevice(setup);
    expect((setup.deviceStore as DeviceStore).revoke("device-1")).toBe(true);
    const denied = await rpc(device.socket, device.cipher, {
      id: "revoked-1",
      method: "GET",
      path: "/api/v1/capabilities",
      headers: {},
    });
    expect(denied).toMatchObject({ id: "revoked-1", status: 401 });
    const closed = new Promise<number>((resolve) => device.socket.once("close", (code) => resolve(code)));
    setup.connector.closeDevice("device-1");
    await expect(closed).resolves.toBe(4400);
    expect(setup.connector.metrics().activeChannels).toBe(0);
  });
});
