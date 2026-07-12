import { expect, test, vi } from "vitest";
import { createCodexProvider } from "../../src/providers/codex-provider.js";
import { ProviderError, type CodexSessionOptions, type ProviderProcessContext } from "../../src/providers/types.js";

const attach = {
  baseUrl: "http://127.0.0.1:4280",
  token: "test-roam-token",
  mcpScriptPath: "/opt/roamcode/mcp-send.js",
  dataDir: "/unused-for-codex",
};

function context(
  intent: "fresh" | "resume",
  options: CodexSessionOptions,
  providerSessionId?: string,
): ProviderProcessContext {
  return {
    roamSessionId: "roam-session-1",
    cwd: "/work/project",
    intent,
    options,
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
  };
}

const config = (key: string, value: unknown): string[] => ["-c", `${key}=${JSON.stringify(value)}`];
const profileProof = (profile = "openai-work") => ({
  profile,
  codexHome: "/canonical/codex-home",
  assertUnchanged: async () => {},
});

test("builds exact fresh argv with native Codex flags and narrow TOML-safe overrides", async () => {
  const provider = createCodexProvider({
    codexBin: "/opt/codex",
    env: { PATH: "/bin" },
    attach,
    validateProfile: async (profile) => profileProof(profile),
  });
  const spec = await provider.buildProcess(
    context("fresh", {
      provider: "codex",
      model: "gpt-5.6",
      reasoningEffort: "high",
      profile: "openai-work",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      webSearch: true,
      addDirs: ["/extra", "/another"],
    }),
  );

  expect(spec.executable).toBe("/opt/codex");
  expect(spec.args).toEqual([
    "--model",
    "gpt-5.6",
    "--profile",
    "openai-work",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "on-request",
    "--search",
    "--add-dir",
    "/extra",
    "--add-dir",
    "/another",
    ...config("model_reasoning_effort", "high"),
    ...config("mcp_servers.roamcode.command", process.execPath),
    ...config("mcp_servers.roamcode.args", ["/opt/roamcode/mcp-send.js"]),
    ...config("mcp_servers.roamcode.env_vars", ["RC_BASE_URL", "RC_SESSION_ID", "RC_TOKEN"]),
    ...config("tui.notifications", ["agent-turn-complete", "approval-requested", "plan-mode-prompt"]),
    ...config("tui.notification_method", "osc9"),
    ...config("tui.notification_condition", "always"),
  ]);
  expect(spec.cleanupPaths).toEqual([]);
  expect(spec.integration).toEqual({
    attachments: "ready",
    activity: "degraded",
    detail: "Codex activity uses display-text signals with pane fallback",
  });
});

test("puts attachment secrets only in a cloned process environment", async () => {
  const sourceEnv = { PATH: "/bin", USER_SETTING: "preserved" };
  const provider = createCodexProvider({ codexBin: "codex", env: sourceEnv, attach });
  const spec = await provider.buildProcess(context("fresh", { provider: "codex" }));

  expect(spec.env).toEqual({
    PATH: "/bin",
    USER_SETTING: "preserved",
    RC_BASE_URL: "http://127.0.0.1:4280",
    RC_SESSION_ID: "roam-session-1",
    RC_TOKEN: "test-roam-token",
  });
  expect(sourceEnv).toEqual({ PATH: "/bin", USER_SETTING: "preserved" });
  expect(JSON.stringify(spec.args)).not.toContain("test-roam-token");
  expect(JSON.stringify(spec.cleanupPaths)).not.toContain("test-roam-token");
  expect(JSON.stringify(spec.integration)).not.toContain("test-roam-token");
});

test("uses only RoamCode MCP and TUI notification overrides so user config continues to load", async () => {
  const provider = createCodexProvider({
    codexBin: "codex",
    env: {},
    attach,
    validateProfile: async (profile) => profileProof(profile),
  });
  const spec = await provider.buildProcess(context("fresh", { provider: "codex", profile: "my-profile" }));
  const overrides = spec.args.filter((_, index) => spec.args[index - 1] === "-c");

  expect(overrides.map((entry) => entry.slice(0, entry.indexOf("=")))).toEqual([
    "mcp_servers.roamcode.command",
    "mcp_servers.roamcode.args",
    "mcp_servers.roamcode.env_vars",
    "tui.notifications",
    "tui.notification_method",
    "tui.notification_condition",
  ]);
  expect(spec.args).toContain("my-profile");
  expect(spec.args.join(" ")).not.toMatch(/(?:^|\s)(?:notify|hooks|mcp_servers)(?:=|\s|$)/);
  expect(spec.args).not.toContain("--dangerously-bypass-hook-trust");
});

test("reasoning effort is encoded as a quoted one-run TOML value", async () => {
  const provider = createCodexProvider({ codexBin: "codex", env: {} });
  const spec = await provider.buildProcess(context("fresh", { provider: "codex", reasoningEffort: "xhigh" }));

  expect(spec.args.slice(0, 2)).toEqual(["-c", 'model_reasoning_effort="xhigh"']);
  expect(spec.args).not.toContain("--reasoning-effort");
});

test("dangerous bypass is exclusive and never emits ordinary safety flags", async () => {
  const provider = createCodexProvider({ codexBin: "codex", env: {} });
  const spec = await provider.buildProcess(
    context("fresh", {
      provider: "codex",
      dangerouslyBypassApprovalsAndSandbox: true,
      sandbox: "read-only",
      approvalPolicy: "untrusted",
    }),
  );

  expect(spec.args[0]).toBe("--dangerously-bypass-approvals-and-sandbox");
  expect(spec.args).not.toContain("--sandbox");
  expect(spec.args).not.toContain("--ask-for-approval");
});

test("resume emits actual Codex CLI usage shape with every option before -- and the exact id last", async () => {
  const provider = createCodexProvider({
    codexBin: "codex",
    env: {},
    attach,
    validateProfile: async (profile) => profileProof(profile),
  });
  const exactId = "thread opaque-123";
  const spec = await provider.buildProcess(
    context(
      "resume",
      {
        provider: "codex",
        model: "gpt-5.6",
        reasoningEffort: "high",
        profile: "openai-work",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        webSearch: true,
        addDirs: ["/extra"],
      },
      exactId,
    ),
  );

  expect(spec.args).toEqual([
    "resume",
    "--model",
    "gpt-5.6",
    "--profile",
    "openai-work",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "on-request",
    "--search",
    "--add-dir",
    "/extra",
    ...config("model_reasoning_effort", "high"),
    ...config("mcp_servers.roamcode.command", process.execPath),
    ...config("mcp_servers.roamcode.args", ["/opt/roamcode/mcp-send.js"]),
    ...config("mcp_servers.roamcode.env_vars", ["RC_BASE_URL", "RC_SESSION_ID", "RC_TOKEN"]),
    ...config("tui.notifications", ["agent-turn-complete", "approval-requested", "plan-mode-prompt"]),
    ...config("tui.notification_method", "osc9"),
    ...config("tui.notification_condition", "always"),
    "--",
    exactId,
  ]);
  expect(spec.args.filter((value) => value === exactId)).toHaveLength(1);
  expect(spec.args).not.toContain("--last");
  expect(spec.args).not.toContain("--no-alt-screen");
});

test.each([
  ["missing", undefined],
  ["empty", ""],
  ["blank", "   "],
  ["control character", "thread\u001bunsafe"],
  ["C1 next-line control", "thread\u0085unsafe"],
  ["C1 control-sequence introducer", "thread\u009bunsafe"],
  ["Unicode line separator", "thread\u2028unsafe"],
  ["Unicode paragraph separator", "thread\u2029unsafe"],
  ["--last", "--last"],
  ["other leading dash", "-thread-123"],
  ["whitespace before leading dash", "  --last"],
  ["oversized", "x".repeat(2049)],
] as const)("resume rejects an unsafe $0 exact id", async (_name, id) => {
  const provider = createCodexProvider({ codexBin: "codex", env: {} });
  await expect(provider.buildProcess(context("resume", { provider: "codex" }, id))).rejects.toMatchObject({
    code: "RESUME_IDENTITY_UNAVAILABLE",
  } satisfies Partial<ProviderError>);
});

test("fresh launch never accepts or emits a persisted resume id", async () => {
  const provider = createCodexProvider({ codexBin: "codex", env: {} });
  await expect(
    provider.buildProcess(context("fresh", { provider: "codex" }, "thread-must-not-leak")),
  ).rejects.toMatchObject({ code: "INVALID_PROVIDER_OPTIONS" } satisfies Partial<ProviderError>);
});

test("forbidden non-TUI and local-provider flags are absent", async () => {
  const provider = createCodexProvider({ codexBin: "codex", env: {}, attach });
  const spec = await provider.buildProcess(context("fresh", { provider: "codex" }));

  for (const forbidden of [
    "--last",
    "--oss",
    "--local-provider",
    "--remote",
    "exec",
    "--dangerously-bypass-hook-trust",
    "--no-alt-screen",
  ]) {
    expect(spec.args).not.toContain(forbidden);
  }
});

test("reports attachment degradation explicitly when no MCP attachment context is available", async () => {
  const provider = createCodexProvider({ codexBin: "codex", env: {} });
  const spec = await provider.buildProcess(context("fresh", { provider: "codex" }));

  expect(spec.integration).toEqual({
    attachments: "degraded",
    activity: "degraded",
    detail: "RoamCode attachment MCP is not configured; Codex activity uses display-text signals with pane fallback",
  });
  expect(spec.args.join(" ")).not.toContain("mcp_servers.roamcode");
});

test("degrades instead of advertising attachments when the supplied MCP context is incomplete", async () => {
  const sourceEnv = { PATH: "/bin" };
  const provider = createCodexProvider({
    codexBin: "codex",
    env: sourceEnv,
    attach: { ...attach, mcpScriptPath: "", token: "must-not-be-installed" },
  });
  const spec = await provider.buildProcess(context("fresh", { provider: "codex" }));

  expect(spec.integration?.attachments).toBe("degraded");
  expect(spec.args.join(" ")).not.toContain("mcp_servers.roamcode");
  expect(spec.env).toEqual(sourceEnv);
});

test("supports an injected OpenAI-profile capability check without parsing user profile files", async () => {
  const validateProfile = vi.fn(async (profile: string) => profileProof(profile));
  const provider = createCodexProvider({ codexBin: "codex", env: {}, validateProfile });
  await provider.buildProcess(context("fresh", { provider: "codex", profile: "openai-work" }));

  expect(validateProfile).toHaveBeenCalledWith("openai-work", "/work/project");

  const rejected = createCodexProvider({
    codexBin: "codex",
    env: {},
    validateProfile: () => Promise.reject(new Error("OSS_PROVIDER_DEFERRED")),
  });
  await expect(
    rejected.buildProcess(context("fresh", { provider: "codex", profile: "local-profile" })),
  ).rejects.toMatchObject({
    code: "OSS_PROVIDER_DEFERRED",
    message: "Codex profile capability proof is unavailable",
  });

  const throwingGetter = createCodexProvider({
    codexBin: "codex",
    env: {},
    get validateProfile() {
      throw new ProviderError("OSS_PROVIDER_DEFERRED", "raw profile getter secret");
    },
  });
  const failed = throwingGetter.buildProcess(context("fresh", { provider: "codex", profile: "local-profile" }));
  await expect(failed).rejects.toMatchObject({
    code: "OSS_PROVIDER_DEFERRED",
    message: "Codex profile capability proof is unavailable",
  });
  await expect(failed).rejects.not.toThrow(/raw profile getter secret/);
});

test("carries canonical profile proof into the final process environment and pre-spawn check", async () => {
  const assertUnchanged = vi.fn(async () => {});
  const validateProfile = vi.fn(async () => ({
    profile: "openai-work",
    codexHome: "/canonical/codex-home",
    assertUnchanged,
  }));
  const provider = createCodexProvider({
    codexBin: "codex",
    env: { PATH: "/bin", CODEX_HOME: "/untrusted/home" },
    validateProfile,
  });
  const spec = await provider.buildProcess(context("fresh", { provider: "codex", profile: "openai-work" }));

  expect(spec.env).toEqual({ PATH: "/bin", CODEX_HOME: "/canonical/codex-home" });
  expect(spec.preSpawnCheck).toEqual(expect.any(Function));
  await spec.preSpawnCheck?.();
  expect(assertUnchanged).toHaveBeenCalledOnce();

  const rejected = createCodexProvider({
    codexBin: "codex",
    env: {},
    validateProfile: async () => ({
      profile: "openai-work",
      codexHome: "/canonical/codex-home",
      assertUnchanged: async () => {
        throw new ProviderError("OSS_PROVIDER_DEFERRED", "raw final profile secret");
      },
    }),
  });
  const rejectedSpec = await rejected.buildProcess(context("fresh", { provider: "codex", profile: "openai-work" }));
  const finalCheck = rejectedSpec.preSpawnCheck!();
  await expect(finalCheck).rejects.toMatchObject({
    code: "OSS_PROVIDER_DEFERRED",
    message: "Codex profile capability proof is unavailable",
  });
  await expect(finalCheck).rejects.not.toThrow(/raw final profile secret/);
});

test("fails closed when a profile is supplied without effective-provider capability proof", async () => {
  const provider = createCodexProvider({ codexBin: "codex", env: {} });
  await expect(
    provider.buildProcess(context("fresh", { provider: "codex", profile: "unproven-profile" })),
  ).rejects.toMatchObject({ code: "OSS_PROVIDER_DEFERRED" });
});

test("rejects non-Codex options at the provider boundary", async () => {
  const provider = createCodexProvider({ codexBin: "codex", env: {} });
  await expect(
    provider.buildProcess({
      roamSessionId: "x",
      cwd: "/work",
      intent: "fresh",
      options: { provider: "claude" },
    }),
  ).rejects.toMatchObject({ code: "INVALID_PROVIDER_OPTIONS" } satisfies Partial<ProviderError>);
});
