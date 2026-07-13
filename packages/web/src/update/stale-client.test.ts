import { describe, expect, it } from "vitest";
import { claimAutoRefresh, isClientStale, versionFromServerLabel } from "./stale-client";

function fakeStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("versionFromServerLabel", () => {
  it("normalizes stable v-prefixed SemVer labels", () => {
    expect(versionFromServerLabel("v1.4.2")).toBe("1.4.2");
    expect(versionFromServerLabel("1.4.2")).toBe("1.4.2");
  });

  it("rejects dev, prerelease and former commit labels", () => {
    expect(versionFromServerLabel("dev")).toBeUndefined();
    expect(versionFromServerLabel("v1.4.2-beta.1")).toBeUndefined();
    expect(versionFromServerLabel("v2026.06.27 · 0888250")).toBeUndefined();
  });
});

describe("isClientStale", () => {
  it("detects a different stable package version", () => {
    expect(isClientStale("1.0.0", "v1.1.0")).toBe(true);
  });

  it("accepts the same package version with or without v", () => {
    expect(isClientStale("1.1.0", "v1.1.0")).toBe(false);
  });

  it("does not guess when either side has no stable release identity", () => {
    expect(isClientStale("dev", "v1.1.0")).toBe(false);
    expect(isClientStale("1.1.0", "dev")).toBe(false);
    expect(isClientStale(undefined, "v1.1.0")).toBe(false);
  });
});

describe("claimAutoRefresh", () => {
  it("grants one automatic refresh per server release", () => {
    const storage = fakeStorage();
    expect(claimAutoRefresh("v1.1.0", storage)).toBe(true);
    expect(claimAutoRefresh("v1.1.0", storage)).toBe(false);
    expect(claimAutoRefresh("v1.2.0", storage)).toBe(true);
  });

  it("refuses a label without stable SemVer", () => {
    expect(claimAutoRefresh("dev", fakeStorage())).toBe(false);
  });
});
