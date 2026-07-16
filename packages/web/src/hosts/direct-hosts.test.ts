import { describe, expect, test, vi } from "vitest";
import {
  activateDirectHost,
  addDirectHost,
  addRelayHost,
  inspectDirectHost,
  listGlobalDirectAttention,
  loadDirectHostRegistry,
  loadDirectHostToken,
  loadRelayHostCredential,
  normalizeDirectHostUrl,
  removeDirectHost,
  saveDirectHostRegistry,
  searchDirectHosts,
  sortGlobalAttentionHosts,
  updateDirectHost,
  type StorageLike,
} from "./direct-hosts";

function memoryStorage(): StorageLike & { entries(): Record<string, string> } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    entries: () => Object.fromEntries(values),
  };
}

describe("direct host registry", () => {
  test("stores relay routing as public metadata while isolating both device secrets", () => {
    const storage = memoryStorage();
    let registry = loadDirectHostRegistry("https://app.roamcode.example", "direct-token", storage, false, 1);
    registry = addRelayHost(
      registry,
      {
        label: "Cloud workstation",
        appBaseUrl: "https://app.roamcode.example",
        token: "relay-device-token",
        deviceCredential: `rrd_${"d".repeat(43)}`,
        relay: {
          relayUrl: "https://relay.roamcode.example",
          routeId: "route-cloud",
          deviceId: "device-phone",
          hostIdentityPublicKey: "A".repeat(122),
          hostIdentityFingerprint: `sha256:${"h".repeat(43)}`,
          deviceIdentityFingerprint: `sha256:${"i".repeat(43)}`,
        },
      },
      storage,
      2,
    );
    const relay = registry.hosts.find((host) => host.relay)!;
    expect(registry.activeHostId).toBe(relay.id);
    expect(loadDirectHostToken(relay.id, storage)).toBe("relay-device-token");
    expect(loadRelayHostCredential(relay.id, storage)).toBe(`rrd_${"d".repeat(43)}`);
    const registryBytes = Object.entries(storage.entries()).find(([key]) => key.includes("direct-hosts"))?.[1] ?? "";
    expect(registryBytes).toContain("route-cloud");
    expect(registryBytes).not.toContain("relay-device-token");
    expect(registryBytes).not.toContain(`rrd_${"d".repeat(43)}`);

    registry = activateDirectHost(registry, registry.hosts.find((host) => !host.relay)!.id, storage);
    registry = removeDirectHost(registry, relay.id, storage);
    expect(loadDirectHostToken(relay.id, storage)).toBeUndefined();
    expect(loadRelayHostCredential(relay.id, storage)).toBeUndefined();
  });

  test("migrates the current origin and keeps each credential outside registry metadata", () => {
    const storage = memoryStorage();
    const registry = loadDirectHostRegistry("https://host-a.example", "token-a", storage, false, 1);
    expect(registry.hosts).toEqual([
      expect.objectContaining({ label: "host-a.example", baseUrl: "https://host-a.example", sortOrder: 0 }),
    ]);
    expect(loadDirectHostToken(registry.activeHostId, storage)).toBe("token-a");
    const registryBytes = Object.entries(storage.entries()).find(([key]) => key.includes("direct-hosts"))?.[1];
    expect(registryBytes).not.toContain("token-a");
  });

  test("adds, activates, renames, reorders, and removes secure hosts without credential crossover", () => {
    const storage = memoryStorage();
    let registry = loadDirectHostRegistry("https://host-a.example", "token-a", storage, false, 1);
    registry = addDirectHost(
      registry,
      { label: "Build host", baseUrl: "https://host-b.example", token: "token-b" },
      storage,
      2,
    );
    const hostB = registry.hosts.find((host) => host.baseUrl.includes("host-b"))!;
    const hostA = registry.hosts.find((host) => host.baseUrl.includes("host-a"))!;
    expect(registry.activeHostId).toBe(hostB.id);
    expect(loadDirectHostToken(hostA.id, storage)).toBe("token-a");
    expect(loadDirectHostToken(hostB.id, storage)).toBe("token-b");

    registry = updateDirectHost(registry, hostB.id, { label: "CI", sortOrder: 0 }, storage, 3);
    expect(registry.hosts[0]).toMatchObject({ id: hostB.id, label: "CI" });
    registry = activateDirectHost(registry, hostA.id, storage);
    expect(registry.activeHostId).toBe(hostA.id);
    registry = removeDirectHost(registry, hostB.id, storage);
    expect(registry.hosts).toHaveLength(1);
    expect(loadDirectHostToken(hostB.id, storage)).toBeUndefined();
  });

  test("requires HTTPS remotely and rejects credential-bearing or path URLs", () => {
    expect(normalizeDirectHostUrl("http://127.0.0.1:4280")).toBe("http://127.0.0.1:4280");
    expect(normalizeDirectHostUrl("http://[::1]:4280")).toBe("http://[::1]:4280");
    for (const value of [
      "http://host.example",
      "https://user:pass@host.example",
      "https://host.example/path",
      "https://host.example/?token=secret",
    ]) {
      expect(() => normalizeDirectHostUrl(value)).toThrow();
    }
    const storage = memoryStorage();
    expect(() =>
      addDirectHost(
        loadDirectHostRegistry("https://host-a.example", "token-a", storage),
        { label: "B", baseUrl: "https://host-b.example", token: "Bearer token-b" },
        storage,
      ),
    ).toThrow("Credential is invalid");
    expect(() =>
      addDirectHost(
        loadDirectHostRegistry("https://host-a.example", "token-a", storage),
        { label: "Studio\u202Etxt.exe", baseUrl: "https://host-c.example", token: "token-c" },
        storage,
      ),
    ).toThrow("printable characters");
  });

  test("rejects duplicate registry identities and isolates credentials across a real hash collision", () => {
    const storage = memoryStorage();
    const original = loadDirectHostRegistry("https://host-a.example", "token-a", storage, false, 1);
    const duplicate = {
      ...original,
      hosts: [original.hosts[0]!, { ...original.hosts[0]!, baseUrl: "https://host-b.example" }],
    };
    expect(() => saveDirectHostRegistry(duplicate, storage)).toThrow("Invalid direct host registry");

    const collidingStorage = memoryStorage();
    let colliding = loadDirectHostRegistry(
      "https://1n1sto-6oflii.example",
      "collision-token-a",
      collidingStorage,
      false,
      1,
    );
    colliding = addDirectHost(
      colliding,
      {
        label: "Collision B",
        baseUrl: "https://t1dd8o-ulvxbj.example",
        token: "collision-token-b",
      },
      collidingStorage,
      2,
    );
    expect(new Set(colliding.hosts.map((host) => host.id)).size).toBe(2);
    const [collisionA, collisionB] = colliding.hosts;
    expect(loadDirectHostToken(collisionA!.id, collidingStorage)).toBe("collision-token-a");
    expect(loadDirectHostToken(collisionB!.id, collidingStorage)).toBe("collision-token-b");
  });

  test("inspects each host with only its own credential and classifies revoked/protocol/offline states", async () => {
    const storage = memoryStorage();
    let registry = loadDirectHostRegistry("https://host-a.example", "token-a", storage, false, 1);
    registry = addDirectHost(registry, { label: "B", baseUrl: "https://host-b.example", token: "token-b" }, storage, 2);
    const seen: Array<{ url: string; authorization: string }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const authorization = (init?.headers as Record<string, string>).authorization!;
      seen.push({ url, authorization });
      if (url.includes("host-b") && url.endsWith("capabilities")) {
        return new Response(JSON.stringify({ protocolVersion: 2 }), { status: 200 });
      }
      if (url.includes("host-b")) return new Response(JSON.stringify({ items: [], unreadCount: 0 }), { status: 200 });
      if (url.endsWith("capabilities")) {
        return new Response(JSON.stringify({ protocolVersion: 1, serverVersion: "1.2.3", host: { label: "A" } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ items: [{ urgency: 100, state: "open" }], unreadCount: 1 }), {
        status: 200,
      });
    });

    const summaries = await Promise.all(
      registry.hosts.map((host) => inspectDirectHost(host, loadDirectHostToken(host.id, storage), fetch, 10)),
    );
    expect(summaries.map((summary) => summary.state).sort()).toEqual(["online", "protocol-mismatch"]);
    for (const request of seen) {
      expect(request.authorization).toBe(request.url.includes("host-a") ? "Bearer token-a" : "Bearer token-b");
    }
    expect(
      sortGlobalAttentionHosts(registry, Object.fromEntries(summaries.map((summary) => [summary.hostId, summary])))[0]
        ?.summary?.urgency,
    ).toBe(100);

    expect((await inspectDirectHost(registry.hosts[0]!, undefined, fetch, 11)).state).toBe("revoked");
    const offlineFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("certificate rejected");
    });
    expect((await inspectDirectHost(registry.hosts[0]!, "token", offlineFetch, 12)).state).toBe("certificate-error");
  });

  test("classifies clock skew and stale versions with actionable states", async () => {
    const storage = memoryStorage();
    const registry = loadDirectHostRegistry("https://host-a.example", "token-a", storage, false, 1);
    const host = registry.hosts[0]!;
    const attention = { items: [], unreadCount: 0 };
    const responseFor = (capabilities: object) =>
      vi.fn<typeof globalThis.fetch>(
        async (input) =>
          new Response(JSON.stringify(String(input).endsWith("capabilities") ? capabilities : attention), {
            status: 200,
          }),
      );
    expect(
      (
        await inspectDirectHost(
          host,
          "token-a",
          responseFor({ protocolVersion: 1, serverVersion: "1.2.3", serverTime: 1 + 10 * 60_000 }),
          1,
          "1.2.3",
        )
      ).state,
    ).toBe("clock-skew");
    expect(
      (
        await inspectDirectHost(
          host,
          "token-a",
          responseFor({ protocolVersion: 1, serverVersion: "1.2.2", serverTime: 1 }),
          1,
          "1.2.3",
        )
      ).state,
    ).toBe("stale-version");
  });

  test("routes relay inspection, global attention, and search through the host-owned transport", async () => {
    const storage = memoryStorage();
    let registry = loadDirectHostRegistry("https://app.roamcode.example", "direct-token", storage, false, 1);
    registry = addRelayHost(
      registry,
      {
        label: "Relay",
        appBaseUrl: "https://app.roamcode.example",
        token: "relay-token",
        deviceCredential: `rrd_${"d".repeat(43)}`,
        relay: {
          relayUrl: "wss://relay.roamcode.example/v1/connect",
          routeId: "route-relay",
          deviceId: "device-browser",
          hostIdentityPublicKey: "A".repeat(122),
          hostIdentityFingerprint: `sha256:${"h".repeat(43)}`,
          deviceIdentityFingerprint: `sha256:${"i".repeat(43)}`,
        },
      },
      storage,
      2,
    );
    const relay = registry.hosts.find((host) => host.relay)!;
    const nativeFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("native fetch must not own relay routing");
    });
    const routed = vi.fn(async (host: typeof relay, input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      expect((init?.headers as Record<string, string>).authorization).toBe(
        `Bearer ${loadDirectHostToken(host.id, storage)}`,
      );
      if (path.endsWith("/capabilities")) {
        return new Response(JSON.stringify({ protocolVersion: 1, serverVersion: "1.0.23", serverTime: 10 }), {
          status: 200,
        });
      }
      if (path.endsWith("/search")) {
        return new Response(
          JSON.stringify({
            results: [{ kind: "session", id: `session-${host.id}`, label: host.label, score: 10, updatedAt: 10 }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [], unreadCount: 0 }), { status: 200 });
    });

    await expect(inspectDirectHost(relay, "relay-token", nativeFetch, 10, "1.0.23", routed)).resolves.toMatchObject({
      state: "online",
    });
    await expect(listGlobalDirectAttention(registry, storage, nativeFetch, routed)).resolves.toEqual([]);
    await expect(searchDirectHosts(registry, "session", storage, nativeFetch, routed)).resolves.toHaveLength(2);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(routed.mock.calls.some(([host]) => host.id === relay.id)).toBe(true);
  });

  test("merges attention and search deterministically while every request keeps its host token", async () => {
    const storage = memoryStorage();
    let registry = loadDirectHostRegistry("https://host-a.example", "token-a", storage, false, 1);
    registry = addDirectHost(registry, { label: "B", baseUrl: "https://host-b.example", token: "token-b" }, storage, 2);
    const seen: Array<{ url: string; authorization: string }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      seen.push({ url, authorization: (init?.headers as Record<string, string>).authorization! });
      const b = url.includes("host-b");
      if (url.includes("/search?")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                kind: "session",
                id: b ? "sb" : "sa",
                label: b ? "Beta" : "Alpha",
                sessionId: b ? "sb" : "sa",
                score: b ? 240 : 200,
                updatedAt: b ? 5 : 9,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: b ? "ib" : "ia",
              workspaceId: "w",
              sessionId: b ? "sb" : "sa",
              agentId: "agent",
              kind: "blocked",
              state: "open",
              title: b ? "B" : "A",
              urgency: b ? 100 : 90,
              occurrenceCount: 1,
              createdAt: 1,
              updatedAt: b ? 2 : 3,
            },
          ],
        }),
        { status: 200 },
      );
    });

    const attention = await listGlobalDirectAttention(registry, storage, fetch);
    const search = await searchDirectHosts(registry, "agent", storage, fetch);
    expect(attention.map((item) => item.id)).toEqual(["ib", "ia"]);
    expect(search.map((item) => item.id)).toEqual(["sb", "sa"]);
    for (const request of seen) {
      expect(request.authorization).toBe(request.url.includes("host-a") ? "Bearer token-a" : "Bearer token-b");
    }
  });

  test("drops malformed host payloads and bounds oversized JSON before it reaches the command center", async () => {
    const storage = memoryStorage();
    const registry = loadDirectHostRegistry("https://host-a.example", "token-a", storage, false, 1);
    const malformed = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).includes("/search?")) {
        return new Response(JSON.stringify({ results: [{ kind: "session", id: "x", label: "x", score: NaN }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ items: [{ id: "x", title: "incomplete" }] }), { status: 200 });
    });
    await expect(listGlobalDirectAttention(registry, storage, malformed)).resolves.toEqual([]);
    await expect(searchDirectHosts(registry, "x", storage, malformed)).resolves.toEqual([]);

    const oversized = vi.fn<typeof globalThis.fetch>(
      async () => new Response(`{"padding":"${"x".repeat(512 * 1024)}"}`, { status: 200 }),
    );
    await expect(listGlobalDirectAttention(registry, storage, oversized)).resolves.toEqual([]);
  });
});
