import { describe, expect, test } from "vitest";
import { normalizeSessionDefaults } from "../src/session-defaults.js";

describe("normalizeSessionDefaults", () => {
  test("returns safe defaults for an absent document", () => {
    expect(normalizeSessionDefaults(undefined)).toEqual({
      effort: "medium",
      dangerouslySkip: false,
    });
  });

  test("defaults missing effort and dangerous fields without arming danger", () => {
    expect(normalizeSessionDefaults({ model: "claude-opus-4-1" })).toEqual({
      effort: "medium",
      model: "claude-opus-4-1",
      dangerouslySkip: false,
    });
    expect(() => normalizeSessionDefaults({ dangerouslySkip: "true" })).toThrow();
    expect(() => normalizeSessionDefaults({ codex: { dangerouslyBypassApprovalsAndSandbox: 1 } })).toThrow();
  });

  test("accepts valid bounded Claude and Codex defaults", () => {
    expect(
      normalizeSessionDefaults({
        effort: "future.high",
        model: "vendor/claude-next:preview",
        permissionMode: "plan",
        dangerouslySkip: false,
        codex: {
          model: "vendor/gpt-next:preview",
          reasoningEffort: "future_high",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          profile: "team.default",
          webSearch: true,
          addDirs: ["/work/one", "/work/two"],
          dangerouslyBypassApprovalsAndSandbox: false,
        },
      }),
    ).toEqual({
      effort: "future.high",
      model: "vendor/claude-next:preview",
      permissionMode: "plan",
      dangerouslySkip: false,
      codex: {
        model: "vendor/gpt-next:preview",
        reasoningEffort: "future_high",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        profile: "team.default",
        webSearch: true,
        addDirs: ["/work/one", "/work/two"],
        dangerouslyBypassApprovalsAndSandbox: false,
      },
    });
  });

  test("dangerous modes remove mutually exclusive ordinary permission fields", () => {
    expect(
      normalizeSessionDefaults({
        effort: "high",
        dangerouslySkip: true,
        permissionMode: "acceptEdits",
        codex: {
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          dangerouslyBypassApprovalsAndSandbox: true,
        },
      }),
    ).toEqual({
      effort: "high",
      dangerouslySkip: true,
      codex: { dangerouslyBypassApprovalsAndSandbox: true },
    });
  });

  test("rejects unknown outer and nested keys", () => {
    expect(() => normalizeSessionDefaults({ provider: "codex" })).toThrow();
    expect(() => normalizeSessionDefaults({ codex: { provider: "codex" } })).toThrow();
  });

  test("bounds safe model, effort, profile, and absolute path tokens", () => {
    const validDirs = Array.from({ length: 32 }, (_, index) => `/work/${index}`);
    expect(normalizeSessionDefaults({ codex: { addDirs: validDirs } }).codex?.addDirs).toEqual(validDirs);

    for (const invalid of [
      { effort: `e${"x".repeat(128)}` },
      { effort: "bad effort" },
      { model: `m${"x".repeat(128)}` },
      { model: "bad model" },
      { codex: { model: `m${"x".repeat(128)}` } },
      { codex: { profile: `p${"x".repeat(128)}` } },
      { codex: { profile: "bad profile" } },
      { codex: { addDirs: [...validDirs, "/work/overflow"] } },
      { codex: { addDirs: ["relative/path"] } },
      { codex: { addDirs: [`/${"x".repeat(4096)}`] } },
      { codex: { addDirs: ["/work\nother"] } },
    ]) {
      expect(() => normalizeSessionDefaults(invalid)).toThrow();
    }
  });

  test("defensively clones nested arrays", () => {
    const source = { codex: { addDirs: ["/work/one"] } };
    const normalized = normalizeSessionDefaults(source);

    source.codex.addDirs[0] = "/source-mutated";
    expect(normalized.codex?.addDirs).toEqual(["/work/one"]);

    normalized.codex!.addDirs![0] = "/result-mutated";
    expect(source.codex.addDirs).toEqual(["/source-mutated"]);
  });
});
