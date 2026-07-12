import { describe, expect, it, vi } from "vitest";
import {
  CODEX_VERSION_UNAVAILABLE,
  CodexLatestService,
  parseCodexVersion,
} from "../../src/providers/codex-latest-service.js";

describe("CodexLatestService", () => {
  it("parses only the exact bounded codex --version shape", () => {
    expect(parseCodexVersion("codex-cli 0.144.0-alpha.4\n")).toBe("0.144.0-alpha.4");
    expect(() => parseCodexVersion("warning\ncodex-cli 0.144.0-alpha.4")).toThrowError(
      expect.objectContaining({ code: CODEX_VERSION_UNAVAILABLE }),
    );
    expect(() => parseCodexVersion(`codex-cli 1.2.3${"x".repeat(300)}`)).toThrowError(
      expect.objectContaining({ code: CODEX_VERSION_UNAVAILABLE }),
    );
    expect(() => parseCodexVersion("codex-cli 1.2.3-01\n")).toThrowError(
      expect.objectContaining({ code: CODEX_VERSION_UNAVAILABLE }),
    );
  });

  it("compares arbitrary-length numeric prerelease identifiers without Number precision loss", async () => {
    const service = new CodexLatestService({
      runVersion: async () => ({ code: 0, stdout: "codex-cli 1.2.3-9007199254740992\n", stderr: "" }),
      detectProvenance: async () => "npm",
      fetchNpmLatest: async () => "1.2.3-9007199254740993",
      now: () => 0,
    });
    await expect(service.getVersion()).resolves.toMatchObject({
      installed: "1.2.3-9007199254740992",
      latest: "1.2.3-9007199254740993",
      updateAvailable: true,
    });
  });

  it("queries only @openai/codex for npm provenance and coalesces/caches requests", async () => {
    let now = 1_000;
    const runVersion = vi.fn(async () => ({ code: 0, stdout: "codex-cli 0.144.0-alpha.4\n", stderr: "" }));
    const detectProvenance = vi.fn(async () => "npm" as const);
    let releaseLatest!: (value: string) => void;
    const fetchNpmLatest = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseLatest = resolve;
        }),
    );
    const service = new CodexLatestService({
      runVersion,
      detectProvenance,
      fetchNpmLatest,
      now: () => now,
      cacheTtlMs: 100,
    });
    const first = service.getVersion();
    const concurrent = service.getVersion();
    await vi.waitFor(() => expect(fetchNpmLatest).toHaveBeenCalledOnce());
    expect(fetchNpmLatest).toHaveBeenCalledWith("@openai/codex", { timeoutMs: 5_000, maxResponseBytes: 16_384 });
    releaseLatest("0.144.0");
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { installed: "0.144.0-alpha.4", latest: "0.144.0", updateAvailable: true, provenance: "npm" },
      { installed: "0.144.0-alpha.4", latest: "0.144.0", updateAvailable: true, provenance: "npm" },
    ]);
    expect(runVersion).toHaveBeenCalledWith(["--version"], { timeoutMs: 5_000, maxOutputBytes: 1_024 });
    expect(runVersion).toHaveBeenCalledOnce();
    await service.getVersion();
    expect(runVersion).toHaveBeenCalledOnce();
    now += 101;
    const refreshed = service.getVersion();
    await vi.waitFor(() => expect(fetchNpmLatest).toHaveBeenCalledTimes(2));
    releaseLatest("0.144.0");
    await refreshed;
    expect(runVersion).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["chatgpt", "Update Codex through the ChatGPT app."],
    ["homebrew", "Update Codex through Homebrew."],
    ["unknown", "Update Codex through the installation source that provided it."],
  ] as const)("does not make a misleading npm comparison for %s provenance", async (provenance, updateHint) => {
    const fetchNpmLatest = vi.fn(async () => "99.0.0");
    const service = new CodexLatestService({
      runVersion: async () => ({ code: 0, stdout: "codex-cli 1.2.3\n", stderr: "" }),
      detectProvenance: async () => provenance,
      fetchNpmLatest,
      now: () => 0,
    });
    await expect(service.getVersion()).resolves.toEqual({ installed: "1.2.3", provenance, updateHint });
    expect(fetchNpmLatest).not.toHaveBeenCalled();
  });

  it("keeps installed version with a redacted hint when the compatible latest lookup fails", async () => {
    const service = new CodexLatestService({
      runVersion: async () => ({ code: 0, stdout: "codex-cli 1.2.3\n", stderr: "" }),
      detectProvenance: async () => "npm",
      fetchNpmLatest: async () => {
        throw new Error("Bearer network-secret");
      },
      now: () => 0,
    });
    const result = await service.getVersion();
    expect(result).toEqual({
      installed: "1.2.3",
      provenance: "npm",
      updateHint: "Latest npm version is temporarily unavailable.",
    });
    expect(JSON.stringify(result)).not.toMatch(/Bearer|network-secret/i);
  });

  it("rejects failed, malformed, or oversized version runner output without leaking it", async () => {
    const service = new CodexLatestService({
      runVersion: async () => ({
        code: 1,
        stdout: `codex-cli 1.2.3 ${"secret".repeat(300)}`,
        stderr: "Bearer raw-token",
      }),
      detectProvenance: async () => "unknown",
      fetchNpmLatest: async () => "1.2.3",
      now: () => 0,
    });
    const result = service.getVersion();
    await expect(result).rejects.toMatchObject({
      code: CODEX_VERSION_UNAVAILABLE,
      message: "Codex version is unavailable",
    });
    await expect(result).rejects.not.toThrow(/Bearer|raw-token|secret/i);
  });
});
