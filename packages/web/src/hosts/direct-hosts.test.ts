import { describe, expect, it, vi } from "vitest";
import {
  activateDirectHost,
  addDirectHost,
  clearDirectHostToken,
  hasUsableDirectHostAfterRemoval,
  inspectDirectHost,
  loadDirectHostRegistry,
  loadDirectHostToken,
  normalizeDirectHostUrl,
  removeDirectHost,
  saveDirectHostToken,
  updateDirectHost,
  type StorageLike,
} from "./direct-hosts";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("standalone host registry", () => {
  it("accepts secure origins and loopback HTTP only", () => {
    expect(normalizeDirectHostUrl("https://host.example/")).toBe("https://host.example");
    expect(normalizeDirectHostUrl("http://127.0.0.2:4280")).toBe("http://127.0.0.2:4280");
    expect(() => normalizeDirectHostUrl("http://host.example")).toThrow(/HTTPS/);
    expect(() => normalizeDirectHostUrl("https://user:pass@host.example")).toThrow(/credentials/);
    expect(() => normalizeDirectHostUrl("https://host.example/path")).toThrow(/origin/);
  });

  it("creates a current-origin entry and migrates a legacy token into its scoped credential", () => {
    const storage = memoryStorage();
    const registry = loadDirectHostRegistry("https://host.example", "device-token", storage, false, 10);
    expect(registry.hosts).toEqual([
      expect.objectContaining({ label: "host.example", baseUrl: "https://host.example", createdAt: 10 }),
    ]);
    expect(loadDirectHostToken(registry.activeHostId, storage)).toBe("device-token");
  });

  it("discards obsolete non-direct registry records during upgrade", () => {
    const storage = memoryStorage({
      "roamcode.direct-hosts.v1": JSON.stringify({
        version: 1,
        activeHostId: "old",
        hosts: [
          {
            id: "old",
            label: "Old route",
            baseUrl: "https://app.example",
            sortOrder: 0,
            createdAt: 1,
            updatedAt: 1,
            relay: { routeId: "removed" },
          },
        ],
      }),
    });
    const registry = loadDirectHostRegistry("https://host.example", undefined, storage, false, 20);
    expect(registry.hosts).toHaveLength(1);
    expect(registry.hosts[0]?.baseUrl).toBe("https://host.example");
  });

  it("adds, renames, reorders, activates, and removes direct hosts", () => {
    const storage = memoryStorage();
    let registry = loadDirectHostRegistry("https://one.example", "one-token", storage, false, 1);
    const firstId = registry.activeHostId;
    registry = addDirectHost(
      registry,
      { label: "Build host", baseUrl: "https://two.example", token: "two-token" },
      storage,
      2,
    );
    const secondId = registry.activeHostId;
    expect(loadDirectHostToken(secondId, storage)).toBe("two-token");
    registry = updateDirectHost(registry, secondId, { label: "Studio", sortOrder: 0 }, storage, 3);
    expect(registry.hosts[0]).toMatchObject({ id: secondId, label: "Studio", sortOrder: 0 });
    registry = activateDirectHost(registry, firstId, storage);
    expect(registry.activeHostId).toBe(firstId);
    expect(hasUsableDirectHostAfterRemoval(registry, firstId, storage)).toBe(true);
    registry = removeDirectHost(registry, firstId, storage);
    expect(registry.hosts.map((host) => host.id)).toEqual([secondId]);
    expect(loadDirectHostToken(firstId, storage)).toBeUndefined();
    expect(() => removeDirectHost(registry, secondId, storage)).toThrow(/at least one host/i);
  });

  it("stores only bounded printable credentials", () => {
    const storage = memoryStorage();
    saveDirectHostToken("host_one", "token", storage);
    expect(loadDirectHostToken("host_one", storage)).toBe("token");
    clearDirectHostToken("host_one", storage);
    expect(loadDirectHostToken("host_one", storage)).toBeUndefined();
    expect(() => saveDirectHostToken("host_one", "bad\nvalue", storage)).toThrow(/invalid/i);
  });

  it("reports a missing credential as revoked without making a request", async () => {
    const storage = memoryStorage();
    const host = loadDirectHostRegistry("https://host.example", undefined, storage, false, 1).hosts[0]!;
    const fetchFn = vi.fn();
    await expect(inspectDirectHost(host, undefined, fetchFn, 10)).resolves.toMatchObject({
      state: "revoked",
      attentionCount: 0,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
