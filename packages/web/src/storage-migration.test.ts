import { describe, expect, it } from "vitest";
import { migrateLegacyStorage } from "./storage-migration";

/** Minimal in-memory Storage double (jsdom's localStorage persists across tests; this stays isolated). */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    snapshot: () => Object.fromEntries(map),
  };
}

describe("migrateLegacyStorage (remote-coder → roamcode rename)", () => {
  it("moves every legacy-prefixed key to the new prefix and removes the old one", () => {
    const s = fakeStorage({
      "remote-coder.token": "tok",
      "remote-coder.theme": "oled",
      "remote-coder.dir-branches": "{}",
      unrelated: "keep",
    });
    migrateLegacyStorage(s);
    expect(s.snapshot()).toEqual({
      "roamcode.token": "tok",
      "roamcode.theme": "oled",
      "roamcode.dir-branches": "{}",
      unrelated: "keep",
    });
  });

  it("never clobbers an existing new-prefix value (newer data wins), but still clears the legacy key", () => {
    const s = fakeStorage({ "remote-coder.token": "old", "roamcode.token": "new" });
    migrateLegacyStorage(s);
    expect(s.snapshot()).toEqual({ "roamcode.token": "new" });
  });

  it("is a no-op when nothing legacy exists (idempotent on second boot)", () => {
    const s = fakeStorage({ "roamcode.token": "tok" });
    migrateLegacyStorage(s);
    migrateLegacyStorage(s);
    expect(s.snapshot()).toEqual({ "roamcode.token": "tok" });
  });

  it("swallows storage errors (private mode) instead of breaking boot", () => {
    const s = {
      get length(): number {
        throw new Error("denied");
      },
      key: () => null,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    expect(() => migrateLegacyStorage(s)).not.toThrow();
  });
});
