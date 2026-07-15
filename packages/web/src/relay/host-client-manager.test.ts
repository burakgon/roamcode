import { describe, expect, test, vi } from "vitest";
import type { DirectHostRecord } from "../hosts/direct-hosts";
import type { BrowserRelayClient, BrowserRelayClientOptions, BrowserRelayStatus } from "./client";
import type { BrowserRelayIdentityRecord } from "./identity-store";
import { createRelayHostClientManager } from "./host-client-manager";

function relayHost(): DirectHostRecord {
  return {
    id: "host-relay",
    label: "Cloud workstation",
    baseUrl: "https://app.roamcode.example",
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    relay: {
      relayUrl: "wss://relay.roamcode.example/v1/connect",
      routeId: "route-cloud",
      deviceId: "device-browser",
      hostIdentityPublicKey: "host-public-key",
      hostIdentityFingerprint: "host-fingerprint",
      deviceIdentityFingerprint: "device-fingerprint",
    },
  };
}

function identityRecord(): BrowserRelayIdentityRecord {
  return {
    identity: {
      publicKey: "device-public-key",
      privateKey: {} as CryptoKey,
      fingerprint: "device-fingerprint",
    },
    createdAt: 1,
    generated: false,
  };
}

function fakeClient(options: BrowserRelayClientOptions) {
  let status: BrowserRelayStatus = "idle";
  const client: BrowserRelayClient = {
    start: vi.fn(() => {
      status = "connecting";
      options.onStatus?.(status);
    }),
    ready: vi.fn(async () => undefined),
    fetch: vi.fn(async () => new Response("ok")),
    upload: vi.fn(() => ({
      abort: vi.fn(),
      promise: Promise.resolve(new Response("ok")),
    })),
    openTerminal: vi.fn(() => {
      throw new Error("not used");
    }),
    reconnect: vi.fn(() => {
      status = "reconnecting";
      options.onStatus?.(status);
    }),
    close: vi.fn(() => {
      status = "closed";
      options.onStatus?.(status);
    }),
    status: () => status,
  };
  return client;
}

function testOptions(overrides: Parameters<typeof createRelayHostClientManager>[0] = {}) {
  return {
    loadDeviceCredential: () => `rrd_${"d".repeat(43)}`,
    loadDeviceToken: () => "device-token",
    loadIdentity: async () => identityRecord(),
    fingerprint: async (publicKey: string) =>
      publicKey === "device-public-key" ? "device-fingerprint" : "host-fingerprint",
    ...overrides,
  };
}

describe("relay host client manager", () => {
  test("deduplicates concurrent owners so active traffic and background requests share one socket", async () => {
    let releaseIdentity!: (record: BrowserRelayIdentityRecord) => void;
    const loadIdentity = vi.fn(
      () =>
        new Promise<BrowserRelayIdentityRecord>((resolve) => {
          releaseIdentity = resolve;
        }),
    );
    const created: BrowserRelayClient[] = [];
    const createClient = vi.fn((options: BrowserRelayClientOptions) => {
      const client = fakeClient(options);
      created.push(client);
      return client;
    });
    const manager = createRelayHostClientManager(testOptions({ loadIdentity, createClient }));
    const host = relayHost();

    const active = manager.clientFor(host);
    const background = manager.clientFor(host);
    expect(loadIdentity).toHaveBeenCalledTimes(1);
    releaseIdentity(identityRecord());

    const [activeClient, backgroundClient] = await Promise.all([active, background]);
    expect(activeClient).toBe(backgroundClient);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(created[0]!.start).toHaveBeenCalledTimes(1);
    await expect(manager.fetch(host, `${host.baseUrl}/api/v1/attention`)).resolves.toMatchObject({ status: 200 });
    expect(created[0]!.fetch).toHaveBeenCalledTimes(1);
    manager.close();
  });

  test("fails closed when either pinned identity no longer matches", async () => {
    const createClient = vi.fn(fakeClient);
    const manager = createRelayHostClientManager(
      testOptions({
        createClient,
        fingerprint: async (publicKey) => (publicKey === "device-public-key" ? "wrong-device" : "host-fingerprint"),
      }),
    );

    await expect(manager.clientFor(relayHost())).rejects.toThrow("will not silently replace it");
    expect(createClient).not.toHaveBeenCalled();
    manager.close();
  });

  test("rotates a client when local credentials change and never leaves the old owner connected", async () => {
    let token = "device-token-1";
    const created: BrowserRelayClient[] = [];
    const createClient = vi.fn((options: BrowserRelayClientOptions) => {
      const client = fakeClient(options);
      created.push(client);
      return client;
    });
    const manager = createRelayHostClientManager(
      testOptions({
        createClient,
        loadDeviceToken: () => token,
      }),
    );
    const host = relayHost();
    const first = await manager.clientFor(host);

    token = "device-token-2";
    manager.reconcile([host]);
    expect(first.close).toHaveBeenCalledTimes(1);
    const second = await manager.clientFor(host);
    expect(second).not.toBe(first);
    expect(createClient).toHaveBeenCalledTimes(2);
    manager.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  test("cancels an identity load without creating a zombie client after the host is removed", async () => {
    let releaseIdentity!: (record: BrowserRelayIdentityRecord) => void;
    const createClient = vi.fn(fakeClient);
    const manager = createRelayHostClientManager(
      testOptions({
        createClient,
        loadIdentity: () =>
          new Promise((resolve) => {
            releaseIdentity = resolve;
          }),
      }),
    );
    const opening = manager.clientFor(relayHost());
    manager.reconcile([]);
    releaseIdentity(identityRecord());

    await expect(opening).rejects.toThrow("changed while it was starting");
    expect(createClient).not.toHaveBeenCalled();
    manager.close();
  });

  test("reports status and reconnects the same owned client", async () => {
    const statuses: BrowserRelayStatus[] = [];
    const manager = createRelayHostClientManager(testOptions({ createClient: fakeClient }));
    const unsubscribe = manager.subscribe((_hostId, status) => statuses.push(status));
    const client = await manager.clientFor(relayHost());

    expect(manager.status("host-relay")).toBe("connecting");
    expect(manager.reconnect("host-relay")).toBe(true);
    expect(client.reconnect).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["connecting", "reconnecting"]);
    unsubscribe();
    manager.close();
  });
});
