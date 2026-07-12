import { describe, expect, test } from "vitest";
import { parseProviderOptions, parseLegacyClaudeArgs } from "../../src/providers/options.js";

describe("provider option schemas", () => {
  test("accepts native Codex values and rejects unknown keys", () => {
    expect(
      parseProviderOptions("codex", {
        model: "gpt-5.6",
        reasoningEffort: "high",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        webSearch: true,
        addDirs: ["/tmp/work"],
      }),
    ).toMatchObject({ provider: "codex", reasoningEffort: "high" });
    expect(() => parseProviderOptions("codex", { permissionMode: "plan" })).toThrow(/invalid provider options/i);
  });

  test("dangerous Codex bypass cannot carry ordinary safety fields", () => {
    expect(() =>
      parseProviderOptions("codex", {
        dangerouslyBypassApprovalsAndSandbox: true,
        sandbox: "workspace-write",
      }),
    ).toThrow(/mutually exclusive/i);
  });

  test("parses legacy Claude argv without accepting arbitrary new argv", () => {
    expect(parseLegacyClaudeArgs(["--model", "opus", "--effort", "max", "--add-dir", "/x"])).toEqual({
      provider: "claude",
      model: "opus",
      effort: "max",
      addDirs: ["/x"],
    });
    expect(() => parseProviderOptions("claude", { legacyArgs: ["--verbose"] })).toThrow(/invalid provider options/i);
  });

  test("bounds direct argv tokens", () => {
    expect(() => parseProviderOptions("codex", { model: "--help" })).toThrow(/invalid provider options/i);
    expect(() => parseProviderOptions("codex", { profile: "bad profile" })).toThrow(/invalid provider options/i);
    expect(() => parseProviderOptions("claude", { addDirs: ["relative/path"] })).toThrow(/invalid provider options/i);
  });

  test.each([
    ["claude", "effort"],
    ["codex", "reasoningEffort"],
  ] as const)("accepts a bounded future effort token for %s", (provider, key) => {
    expect(parseProviderOptions(provider, { [key]: "future-depth" })).toMatchObject({
      provider,
      [key]: "future-depth",
    });
  });

  test.each(["bad effort", "-leading-dash", "line\nbreak", `a${String.fromCharCode(0)}b`, "x".repeat(129)])(
    "rejects unsafe effort token %j",
    (effort) => {
      expect(() => parseProviderOptions("claude", { effort })).toThrow(/invalid provider options/i);
      expect(() => parseProviderOptions("codex", { reasoningEffort: effort })).toThrow(/invalid provider options/i);
    },
  );

  test("parses a future Claude effort as one bounded legacy argv value", () => {
    expect(parseLegacyClaudeArgs(["--effort", "future-depth"])).toEqual({
      provider: "claude",
      effort: "future-depth",
    });
  });

  test("rejects every ASCII control character in path tokens", () => {
    const asciiControlCharacters = [...Array.from({ length: 32 }, (_, code) => code), 0x7f];

    for (const code of asciiControlCharacters) {
      const path = `/tmp/before${String.fromCharCode(code)}after`;
      expect(() => parseProviderOptions("codex", { addDirs: [path] }), `ASCII control 0x${code.toString(16)}`).toThrow(
        /invalid provider options/i,
      );
    }
  });

  test("keeps bounded unknown argv only while parsing legacy Claude sessions", () => {
    expect(parseLegacyClaudeArgs(["--verbose", "--model", "sonnet"])).toEqual({
      provider: "claude",
      model: "sonnet",
      legacyArgs: ["--verbose"],
    });
  });

  test("stops parsing legacy Claude options at the first separator", () => {
    expect(parseLegacyClaudeArgs(["--", "--model", "literal", "--settings", "prompt"])).toEqual({
      provider: "claude",
      legacyArgs: ["--", "--model", "literal", "--settings", "prompt"],
    });
  });
});
