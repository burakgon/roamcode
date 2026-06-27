import { describe, expect, it } from "vitest";
import { claimAutoRefresh, isClientStale, shaFromVersionLabel } from "./stale-client";

/** A minimal in-memory Storage stand-in for claimAutoRefresh (getItem/setItem only). */
function fakeStorage(): Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("shaFromVersionLabel", () => {
  it("extracts the short sha after the middot separator", () => {
    expect(shaFromVersionLabel("v2026.06.27 · 0888250")).toBe("0888250");
  });

  it("returns undefined when there is no sha segment", () => {
    expect(shaFromVersionLabel("v2026.06.27")).toBeUndefined();
    expect(shaFromVersionLabel("")).toBeUndefined();
    expect(shaFromVersionLabel(undefined)).toBeUndefined();
  });

  it("tolerates the bare '· <sha>' form the label builder emits with no date", () => {
    expect(shaFromVersionLabel("· abc1234")).toBe("abc1234");
  });
});

describe("isClientStale", () => {
  it("is TRUE when the running bundle's sha differs from the server's current sha", () => {
    // The exact scenario behind "you fixed nothing": a phone on an old precached bundle while the
    // server is several commits ahead — undetectable until now.
    expect(isClientStale("70b8131", "v2026.06.27 · 0888250")).toBe(true);
  });

  it("is FALSE when the bundle sha matches the server's current sha", () => {
    expect(isClientStale("0888250", "v2026.06.27 · 0888250")).toBe(false);
  });

  it("matches by prefix so differing abbreviation lengths are not false positives", () => {
    // git may abbreviate to >7 chars for uniqueness; a longer sha that extends the other is the SAME commit.
    expect(isClientStale("0888250", "v2026.06.27 · 0888250a9")).toBe(false);
    expect(isClientStale("0888250a9", "v2026.06.27 · 0888250")).toBe(false);
  });

  it("is FALSE (cannot decide) when the build sha is unknown — a dev build with no git stamp", () => {
    expect(isClientStale(undefined, "v2026.06.27 · 0888250")).toBe(false);
    expect(isClientStale("", "v2026.06.27 · 0888250")).toBe(false);
    expect(isClientStale("dev", "v2026.06.27 · 0888250")).toBe(false);
  });

  it("is FALSE (cannot decide) when the server label carries no sha", () => {
    expect(isClientStale("0888250", "v2026.06.27")).toBe(false);
    expect(isClientStale("0888250", undefined)).toBe(false);
  });
});

describe("claimAutoRefresh", () => {
  it("grants ONE auto-refresh per server version, then refuses (so a refresh that didn't take never loops)", () => {
    const s = fakeStorage();
    // First detection for this version → claim it (auto-refresh now).
    expect(claimAutoRefresh("v2026.06.27 · 0888250", s)).toBe(true);
    // Still stale for the SAME version after the reload → refuse (caller shows a manual banner instead).
    expect(claimAutoRefresh("v2026.06.27 · 0888250", s)).toBe(false);
  });

  it("grants a fresh auto-refresh when the server moves to a NEW version", () => {
    const s = fakeStorage();
    expect(claimAutoRefresh("v2026.06.27 · 0888250", s)).toBe(true);
    expect(claimAutoRefresh("v2026.06.28 · 99aa bb0", s)).toBe(true);
  });

  it("refuses when the server label carries no sha (nothing to key on)", () => {
    expect(claimAutoRefresh("v2026.06.27", fakeStorage())).toBe(false);
    expect(claimAutoRefresh(undefined, fakeStorage())).toBe(false);
  });
});
