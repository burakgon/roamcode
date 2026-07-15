import { describe, expect, test } from "vitest";
import { normalizeSessionDefaults, sessionDefaultsForLaunch } from "../src/session-defaults.js";

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
        provider: "codex",
        effort: "future.high",
        model: "vendor/claude-next:preview",
        permissionMode: "plan",
        dangerouslySkip: false,
        addDirs: ["/claude/one"],
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
      provider: "codex",
      effort: "future.high",
      model: "vendor/claude-next:preview",
      permissionMode: "plan",
      dangerouslySkip: false,
      addDirs: ["/claude/one"],
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
    expect(() => normalizeSessionDefaults({ provider: "other" })).toThrow();
    expect(() => normalizeSessionDefaults({ unknown: true })).toThrow();
    expect(() => normalizeSessionDefaults({ codex: { provider: "codex" } })).toThrow();
  });

  test("bounds safe model, effort, profile, and absolute path tokens", () => {
    const validDirs = Array.from({ length: 32 }, (_, index) => `/work/${index}`);
    expect(normalizeSessionDefaults({ addDirs: validDirs }).addDirs).toEqual(validDirs);
    expect(normalizeSessionDefaults({ codex: { addDirs: validDirs } }).codex?.addDirs).toEqual(validDirs);

    for (const invalid of [
      { effort: `e${"x".repeat(128)}` },
      { effort: "bad effort" },
      { model: `m${"x".repeat(128)}` },
      { model: "bad model" },
      { codex: { model: `m${"x".repeat(128)}` } },
      { codex: { profile: `p${"x".repeat(128)}` } },
      { codex: { profile: "bad profile" } },
      { addDirs: [...validDirs, "/work/overflow"] },
      { addDirs: ["relative/path"] },
      { codex: { addDirs: [...validDirs, "/work/overflow"] } },
      { codex: { addDirs: ["relative/path"] } },
      { codex: { addDirs: [`/${"x".repeat(4096)}`] } },
      { codex: { addDirs: ["/work\nother"] } },
    ]) {
      expect(() => normalizeSessionDefaults(invalid)).toThrow();
    }
  });

  test("defensively clones nested arrays", () => {
    const source = { addDirs: ["/claude/one"], codex: { addDirs: ["/work/one"] } };
    const normalized = normalizeSessionDefaults(source);

    source.addDirs[0] = "/claude/source-mutated";
    source.codex.addDirs[0] = "/source-mutated";
    expect(normalized.addDirs).toEqual(["/claude/one"]);
    expect(normalized.codex?.addDirs).toEqual(["/work/one"]);

    normalized.addDirs![0] = "/claude/result-mutated";
    normalized.codex!.addDirs![0] = "/result-mutated";
    expect(source.addDirs).toEqual(["/claude/source-mutated"]);
    expect(source.codex.addDirs).toEqual(["/source-mutated"]);
  });
});

describe("sessionDefaultsForLaunch", () => {
  test("remembers a successful Claude launch and retains the previous Codex choices", () => {
    expect(
      sessionDefaultsForLaunch(
        {
          provider: "codex",
          effort: "low",
          model: "old-claude",
          dangerouslySkip: true,
          codex: { model: "gpt-last", reasoningEffort: "xhigh" },
        },
        {
          provider: "claude",
          model: "claude-new",
          effort: "high",
          permissionMode: "plan",
          addDirs: ["/work/shared"],
        },
      ),
    ).toEqual({
      provider: "claude",
      effort: "high",
      model: "claude-new",
      dangerouslySkip: false,
      permissionMode: "plan",
      addDirs: ["/work/shared"],
      codex: { model: "gpt-last", reasoningEffort: "xhigh" },
    });
  });

  test("remembers a successful Codex launch and drops mutually exclusive ordinary safety fields", () => {
    expect(
      sessionDefaultsForLaunch(
        { provider: "claude", effort: "high", model: "opus", dangerouslySkip: false, permissionMode: "plan" },
        {
          provider: "codex",
          model: "gpt-next",
          reasoningEffort: "future",
          profile: "work",
          webSearch: true,
          addDirs: ["/work/extra"],
          dangerouslyBypassApprovalsAndSandbox: true,
        },
      ),
    ).toEqual({
      provider: "codex",
      effort: "high",
      model: "opus",
      dangerouslySkip: false,
      permissionMode: "plan",
      codex: {
        model: "gpt-next",
        reasoningEffort: "future",
        profile: "work",
        webSearch: true,
        addDirs: ["/work/extra"],
        dangerouslyBypassApprovalsAndSandbox: true,
      },
    });
  });
});
