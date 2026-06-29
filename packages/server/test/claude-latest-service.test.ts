import { describe, expect, it, vi } from "vitest";
import { ClaudeLatestService, parseNpmLatest } from "../src/index.js";

describe("parseNpmLatest", () => {
  it("pulls version out of an npm dist-tag doc", () => {
    expect(parseNpmLatest({ name: "@anthropic-ai/claude-code", version: "2.1.195" })).toBe("2.1.195");
  });
  it("returns undefined for a malformed doc", () => {
    expect(parseNpmLatest({})).toBeUndefined();
    expect(parseNpmLatest("nope")).toBeUndefined();
    expect(parseNpmLatest(null)).toBeUndefined();
  });
});

describe("ClaudeLatestService", () => {
  it("caches within the TTL (one fetch) and refreshes after it", async () => {
    let t = 0;
    const fetchLatest = vi.fn(async () => "2.1.195");
    const svc = new ClaudeLatestService({ fetchLatest, now: () => t, ttlMs: 1000 });

    expect(await svc.getLatest()).toBe("2.1.195");
    expect(await svc.getLatest()).toBe("2.1.195"); // within TTL → cached
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    t = 1500; // past TTL
    await svc.getLatest();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good value when a refresh fails (degrades, never throws)", async () => {
    let t = 0;
    const fetchLatest = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("2.1.195")
      .mockRejectedValueOnce(new Error("offline"));
    const svc = new ClaudeLatestService({ fetchLatest, now: () => t, ttlMs: 1000 });

    expect(await svc.getLatest()).toBe("2.1.195");
    t = 2000;
    expect(await svc.getLatest()).toBe("2.1.195"); // failed refresh → last good value
  });

  it("returns undefined when there is no value yet and the fetch fails", async () => {
    const svc = new ClaudeLatestService({ fetchLatest: async () => undefined, now: () => 0 });
    expect(await svc.getLatest()).toBeUndefined();
  });
});
