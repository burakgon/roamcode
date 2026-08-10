import { describe, expect, it } from "vitest";
import { currentOriginScopeId, loadLegacyCurrentOriginToken, type StorageLike } from "./current-origin";

function memoryStorage(values: Record<string, string> = {}): StorageLike {
  const items = new Map(Object.entries(values));
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key),
  };
}

describe("current-origin browser state", () => {
  it("uses a stable scope per origin", () => {
    expect(currentOriginScopeId("https://example.test/path")).toBe(currentOriginScopeId("https://example.test"));
    expect(currentOriginScopeId("https://example.test")).not.toBe(currentOriginScopeId("https://other.test"));
  });

  it("recovers only the exact current origin's legacy token", () => {
    const storage = memoryStorage({
      "roamcode.direct-hosts.v1": JSON.stringify({
        version: 1,
        activeHostId: "remote",
        hosts: [
          { id: "malformed", baseUrl: "not a URL" },
          { id: "remote", baseUrl: "https://remote.test" },
          { id: "current", baseUrl: "https://current.test" },
        ],
      }),
      "roamcode.direct-host-token.remote": "remote-token",
      "roamcode.direct-host-token.current": "current-token",
    });

    expect(loadLegacyCurrentOriginToken("https://current.test", storage)).toBe("current-token");
    expect(loadLegacyCurrentOriginToken("https://unknown.test", storage)).toBeUndefined();
  });

  it("ignores malformed registry state and credentials", () => {
    expect(
      loadLegacyCurrentOriginToken("https://current.test", memoryStorage({ "roamcode.direct-hosts.v1": "not-json" })),
    ).toBeUndefined();
  });
});
