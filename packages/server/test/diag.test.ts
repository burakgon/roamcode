import { describe, expect, test, vi } from "vitest";
import { createClaudeVersionProbe, parseClaudeVersion, CLAUDE_VERSION_CACHE_MS } from "../src/index.js";

describe("parseClaudeVersion", () => {
  test("extracts a dotted version from version output", () => {
    expect(parseClaudeVersion("1.2.3 (Claude Code)")).toBe("1.2.3");
    expect(parseClaudeVersion("claude version 0.45.1\n")).toBe("0.45.1");
    expect(parseClaudeVersion("2.0.0-beta.4")).toBe("2.0.0-beta.4");
  });
  test("returns the trimmed raw string when there's no dotted-number token", () => {
    expect(parseClaudeVersion("  some-build  ")).toBe("some-build");
  });
  test("undefined for empty output", () => {
    expect(parseClaudeVersion("   ")).toBeUndefined();
  });
});

describe("createClaudeVersionProbe", () => {
  test("available + parsed version on a successful run", async () => {
    const run = vi.fn(async () => ({ stdout: "1.2.3 (Claude Code)" }));
    const probe = createClaudeVersionProbe({ run });
    expect(await probe.get()).toEqual({ available: true, version: "1.2.3" });
  });

  test("unavailable (never throws) when the spawn rejects", async () => {
    const run = vi.fn(async () => {
      throw new Error("ENOENT claude");
    });
    const probe = createClaudeVersionProbe({ run });
    expect(await probe.get()).toEqual({ available: false });
  });

  test("CACHES the result within the TTL (no re-spawn)", async () => {
    let clock = 0;
    const run = vi.fn(async () => ({ stdout: "1.0.0" }));
    const probe = createClaudeVersionProbe({ run, now: () => clock });
    await probe.get();
    clock = CLAUDE_VERSION_CACHE_MS - 1;
    await probe.get();
    expect(run).toHaveBeenCalledTimes(1);
    // Past the TTL → re-spawn.
    clock = CLAUDE_VERSION_CACHE_MS + 1;
    await probe.get();
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("collapses concurrent probes into a single spawn", async () => {
    let resolve!: (v: { stdout: string }) => void;
    const run = vi.fn(() => new Promise<{ stdout: string }>((r) => (resolve = r)));
    const probe = createClaudeVersionProbe({ run });
    const a = probe.get();
    const b = probe.get();
    resolve({ stdout: "9.9.9" });
    expect(await a).toEqual({ available: true, version: "9.9.9" });
    expect(await b).toEqual({ available: true, version: "9.9.9" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
