import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expect, test } from "vitest";
import { codexMcpTokenPathFor } from "../src/config.js";
import { buildPushPayload } from "../src/push-dispatch.js";
import { createProviderIntegrationHarness } from "./helpers/provider-integration-harness.js";

test("real tmux keeps concurrent Claude and Codex sessions isolated in the same cwd", async () => {
  const harness = await createProviderIntegrationHarness();
  try {
    const claude = await harness.createSession("claude", {
      model: "sonnet",
      effort: "high",
      permissionMode: "plan",
      addDirs: [harness.cwd],
    });
    const codex = await harness.createSession("codex", {
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      webSearch: true,
      addDirs: [harness.cwd],
    });

    const [claudeWs, codexWs] = await Promise.all([harness.attach(claude.id), harness.attach(codex.id)]);
    await expect.poll(() => claudeWs.output()).toContain(`FAKE_CLAUDE_TUI:${claude.id}`);
    await expect.poll(() => codexWs.output()).toContain(`FAKE_CODEX_TUI:${codex.id}`);
    expect(claudeWs.output()).not.toContain(`FAKE_CODEX_TUI:${codex.id}`);
    expect(codexWs.output()).not.toContain(`FAKE_CLAUDE_TUI:${claude.id}`);

    const launches = harness.launches();
    expect(launches.filter((entry) => entry.provider === "claude")).toHaveLength(1);
    expect(launches.filter((entry) => entry.provider === "codex")).toHaveLength(1);
    expect(harness.launchFor("claude").argv).toEqual(
      expect.arrayContaining(["--model", "sonnet", "--effort", "high", "--permission-mode", "plan"]),
    );
    expect(harness.launchFor("codex").argv).toEqual(
      expect.arrayContaining([
        "--model",
        "gpt-5.6-sol",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "--search",
      ]),
    );
    expect(harness.launchFor("claude").argv).not.toContain("--sandbox");
    expect(harness.launchFor("codex").argv).not.toContain("--permission-mode");
    const updateEnvironment = harness.tmuxGlobalOption("update-environment");
    for (const name of ["RC_BASE_URL", "RC_SESSION_ID", "RC_TOKEN", "RC_TOKEN_FILE"]) {
      expect(updateEnvironment.filter((entry) => entry === name)).toHaveLength(1);
    }
  } finally {
    await harness.close();
  }
});

test("exact Codex resume persists the discovered thread id and never generates --last", async () => {
  const harness = await createProviderIntegrationHarness();
  try {
    const codex = await harness.createSession("codex", {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
    const first = await harness.attach(codex.id);
    await expect.poll(() => first.output()).toContain(`FAKE_CODEX_TUI:${codex.id}`);
    const exactId = `thread-${codex.id}-1`;
    await expect.poll(() => harness.terminalManager.get(codex.id)?.identityState, { timeout: 5_000 }).toBe("exact");
    expect(harness.store.get(codex.id)).toMatchObject({
      provider: "codex",
      providerSessionId: exactId,
    });
    expect(harness.terminalManager.get(codex.id)).toMatchObject({ identityState: "exact", providerSessionId: exactId });

    first.send("__exit__\n");
    await expect.poll(() => harness.terminalManager.get(codex.id)?.status).toBe("ended");
    const resumed = await harness.attach(codex.id, "continue");
    await expect.poll(() => resumed.output()).toContain(`FAKE_CODEX_TUI:${codex.id}`);

    const resumeLaunch = harness.launchFor("codex", 1);
    expect(resumeLaunch.resume).toBe(exactId);
    expect(resumeLaunch.argv).toEqual(expect.arrayContaining(["resume", "--", exactId]));
    expect(resumeLaunch.argv.some((arg) => arg === "--last" || arg.startsWith("--last="))).toBe(false);
    expect(resumeLaunch.argv).toEqual(expect.arrayContaining(["--model", "gpt-5.6-sol"]));
  } finally {
    await harness.close();
  }
});

test("metadata protocol failure degrades while the live Codex tmux TUI keeps streaming", async () => {
  const harness = await createProviderIntegrationHarness();
  try {
    const codex = await harness.createSession("codex", { sandbox: "workspace-write", approvalPolicy: "on-request" });
    const terminal = await harness.attach(codex.id);
    await expect.poll(() => terminal.output()).toContain(`FAKE_CODEX_TUI:${codex.id}`);
    await expect.poll(() => harness.terminalManager.get(codex.id)?.identityState, { timeout: 5_000 }).toBe("exact");

    harness.setMetadataMode("malformed");
    const degraded = await harness.request("GET", "/providers/codex/auth/status");
    expect(degraded.statusCode).toBe(503);
    expect(degraded.json).toMatchObject({ code: "PROVIDER_METADATA_UNAVAILABLE" });

    terminal.send("still-alive\n");
    await expect.poll(() => terminal.output()).toContain("CODEX_ECHO:still-alive");
    expect(harness.terminalManager.get(codex.id)?.status).toBe("running");
  } finally {
    await harness.close();
  }
});

test("missing Claude and missing Codex remain independently actionable", async () => {
  const withoutClaude = await createProviderIntegrationHarness({ unavailableProvider: "claude" });
  try {
    const providers = await withoutClaude.request("GET", "/providers");
    expect(providers.json).toMatchObject({
      providers: {
        claude: { terminalAvailable: false },
        codex: { terminalAvailable: true },
      },
    });
    const rejected = await withoutClaude.request("POST", "/sessions", {
      provider: "claude",
      cwd: withoutClaude.cwd,
      options: {},
    });
    expect(rejected).toMatchObject({ statusCode: 503, json: { code: "PROVIDER_UNAVAILABLE" } });
    const codex = await withoutClaude.createSession("codex");
    const terminal = await withoutClaude.attach(codex.id);
    await expect.poll(() => terminal.output()).toContain(`FAKE_CODEX_TUI:${codex.id}`);
  } finally {
    await withoutClaude.close();
  }

  const withoutCodex = await createProviderIntegrationHarness({ unavailableProvider: "codex" });
  try {
    const claude = await withoutCodex.createSession("claude");
    const terminal = await withoutCodex.attach(claude.id);
    await expect.poll(() => terminal.output()).toContain(`FAKE_CLAUDE_TUI:${claude.id}`);
    const rejected = await withoutCodex.request("POST", "/sessions", {
      provider: "codex",
      cwd: withoutCodex.cwd,
      options: {},
    });
    expect(rejected).toMatchObject({ statusCode: 503, json: { code: "PROVIDER_UNAVAILABLE" } });
  } finally {
    await withoutCodex.close();
  }
});

test("secret canaries stay out of argv, fixture state, persistence, REST, and diagnostics", async () => {
  const harness = await createProviderIntegrationHarness();
  try {
    const claude = await harness.createSession("claude");
    const codex = await harness.createSession("codex");
    const terminals = await Promise.all([harness.attach(claude.id), harness.attach(codex.id)]);
    await expect.poll(() => harness.launches().length).toBe(2);
    await Promise.all(terminals.map((terminal) => expect.poll(() => terminal.output().length).toBeGreaterThan(0)));

    const surfaces = {
      events: harness.events(),
      rows: harness.store.list(),
      sessions: (await harness.request("GET", "/sessions")).json,
      providers: (await harness.request("GET", "/providers")).json,
      diagnostics: (await harness.request("GET", "/diag")).json,
    };
    const serialized = JSON.stringify(surfaces);
    expect(serialized).not.toContain("RC_TOKEN_CANARY_PROVIDER_INTEGRATION");
    expect(serialized).not.toContain("ANTHROPIC_API_KEY_CANARY_PROVIDER_INTEGRATION");
    expect(serialized).not.toContain("OPENAI_API_KEY_CANARY_PROVIDER_INTEGRATION");
    expect(harness.launchFor("claude")).toMatchObject({ hasRcToken: false, hasAnthropicApiKey: false });
    expect(harness.launchFor("codex")).toMatchObject({
      hasRcToken: false,
      hasRcTokenFile: true,
      hasOpenAiApiKey: true,
    });
    const codexTokenPath = codexMcpTokenPathFor(harness.dataDir, codex.id);
    expect(readFileSync(codexTokenPath, "utf8")).toBe(harness.token);
    expect(statSync(codexTokenPath).mode & 0o777).toBe(0o600);

    harness.command(codex.id, "exit");
    await expect.poll(() => harness.terminalManager.get(codex.id)?.status).toBe("ended");
    expect(existsSync(codexTokenPath)).toBe(false);
  } finally {
    await harness.close();
  }
});

test("production MCP deliver sends file and image through authenticated routes with replay and fsRoot confinement", async () => {
  const harness = await createProviderIntegrationHarness();
  try {
    const claude = await harness.createSession("claude");
    const codex = await harness.createSession("codex");
    const claudeWs = await harness.attach(claude.id);
    const codexWs = await harness.attach(codex.id);
    await expect.poll(() => claudeWs.output()).toContain(`FAKE_CLAUDE_TUI:${claude.id}`);
    await expect.poll(() => codexWs.output()).toContain(`FAKE_CODEX_TUI:${codex.id}`);

    const filePath = join(harness.cwd, "report.txt");
    const imagePath = join(harness.cwd, "shot.png");
    writeFileSync(filePath, "report-body", { mode: 0o600 });
    writeFileSync(imagePath, Buffer.from("89504e470d0a1a0a", "hex"), { mode: 0o600 });
    const fileResult = await harness.invokeMcpTool(claude.id, "send_file", filePath, "report");
    const imageResult = await harness.invokeMcpTool(codex.id, "send_image", imagePath, "preview");
    expect(fileResult).not.toMatchObject({ isError: true });
    expect(imageResult).not.toMatchObject({ isError: true });
    await expect
      .poll(() => claudeWs.controls())
      .toEqual([
        expect.objectContaining({ t: "attach", path: filePath, name: "report.txt", caption: "report", isImage: false }),
      ]);
    await expect
      .poll(() => codexWs.controls())
      .toEqual([
        expect.objectContaining({ t: "attach", path: imagePath, name: "shot.png", caption: "preview", isImage: true }),
      ]);

    await Promise.all([claudeWs.close(), codexWs.close()]);
    const replayedClaude = await harness.attach(claude.id);
    const replayedCodex = await harness.attach(codex.id);
    await expect.poll(() => replayedClaude.controls()).toHaveLength(1);
    await expect.poll(() => replayedCodex.controls()).toHaveLength(1);

    const outsidePath = join(dirname(harness.fsRoot), "outside.txt");
    const symlinkPath = join(harness.cwd, "outside-link.txt");
    writeFileSync(outsidePath, "outside", { mode: 0o600 });
    symlinkSync(outsidePath, symlinkPath);
    const outside = await harness.invokeMcpTool(codex.id, "send_file", outsidePath);
    const symlink = await harness.invokeMcpTool(codex.id, "send_file", symlinkPath);
    expect(outside).toMatchObject({ isError: true });
    expect(symlink).toMatchObject({ isError: true });
    expect(replayedCodex.controls()).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

test("device-code HTTP lifecycle stays exact across authenticated reauth, completion, cancel, expiry, and notFound", async () => {
  const harness = await createProviderIntegrationHarness({ loginTtlMs: 800 });
  try {
    const start = await harness.request("POST", "/providers/codex/auth/login/start");
    expect(start.statusCode).toBe(200);
    const first = start.json as {
      loginId: string;
      userCode: string;
      verificationUrl: string;
      expiresAt: number;
    };
    expect(first).toMatchObject({
      loginId: expect.stringMatching(/^fake-login-/),
      userCode: "FAKE-CODE",
      verificationUrl: "https://example.test/device",
    });
    expect(Object.keys(first).sort()).toEqual(["expiresAt", "loginId", "userCode", "verificationUrl"]);

    // account/read already reports an old authenticated ChatGPT account. Reauth must remain pending until
    // the exact login-completed notification arrives; account-wide auth can never complete it early.
    expect((await harness.request("GET", "/providers/codex/auth/status")).json).toMatchObject({
      authenticated: true,
      authMethod: "chatgpt",
    });
    expect((await harness.request("GET", `/providers/codex/auth/login/status?loginId=${first.loginId}`)).json).toEqual({
      status: "pending",
    });
    harness.completeDeviceLogin(first.loginId, true);
    await expect
      .poll(
        async () => (await harness.request("GET", `/providers/codex/auth/login/status?loginId=${first.loginId}`)).json,
      )
      .toEqual({ status: "completed" });

    const second = (await harness.request("POST", "/providers/codex/auth/login/start")).json as { loginId: string };
    expect(second.loginId).not.toBe(first.loginId);
    expect(
      (
        await harness.request("POST", "/providers/codex/auth/login/cancel", {
          loginId: second.loginId,
        })
      ).json,
    ).toEqual({ status: "canceled" });
    expect((await harness.request("GET", `/providers/codex/auth/login/status?loginId=${second.loginId}`)).json).toEqual(
      {
        status: "canceled",
      },
    );

    const third = (await harness.request("POST", "/providers/codex/auth/login/start")).json as { loginId: string };
    await expect
      .poll(
        async () => (await harness.request("GET", `/providers/codex/auth/login/status?loginId=${third.loginId}`)).json,
        { timeout: 2_000 },
      )
      .toEqual({ status: "expired" });
    await new Promise<void>((resolve) => setTimeout(resolve, 850));
    await expect
      .poll(
        async () => (await harness.request("GET", `/providers/codex/auth/login/status?loginId=${third.loginId}`)).json,
        { timeout: 2_000 },
      )
      .toEqual({ status: "notFound" });

    const serialized = JSON.stringify({
      events: harness.events(),
      rows: harness.store.list(),
      sessions: (await harness.request("GET", "/sessions")).json,
      diagnostics: (await harness.request("GET", "/diag")).json,
    });
    expect(serialized).not.toContain("FAKE-CODE");
    expect(serialized).not.toContain(first.loginId);
    expect(serialized).not.toContain(second.loginId);
    expect(serialized).not.toContain(third.loginId);
    expect(serialized).not.toContain("account/login/completed");
  } finally {
    await harness.close();
  }
});

test("detach, reconnect, and dual-provider rehydrate adopt live tmux sessions without respawning", async () => {
  const harness = await createProviderIntegrationHarness();
  try {
    const claude = await harness.createSession("claude", { model: "sonnet" });
    const codex = await harness.createSession("codex", { model: "gpt-5.6-sol", reasoningEffort: "high" });
    const claudeWs = await harness.attach(claude.id);
    const codexWs = await harness.attach(codex.id);
    await expect.poll(() => harness.terminalManager.get(codex.id)?.identityState, { timeout: 5_000 }).toBe("exact");
    const exactId = harness.terminalManager.get(codex.id)?.providerSessionId;
    expect(exactId).toMatch(/^thread-/);
    await Promise.all([claudeWs.close(), codexWs.close()]);
    expect(harness.liveTmuxNames().sort()).toEqual([`rc-${claude.id}`, `rc-${codex.id}`].sort());

    const restarted = harness.rehydrateManager();
    expect(restarted.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: claude.id, provider: "claude", status: "running" }),
        expect.objectContaining({
          id: codex.id,
          provider: "codex",
          status: "running",
          identityState: "exact",
          providerSessionId: exactId,
        }),
      ]),
    );
    const adoptedOutput: string[] = [];
    await restarted.attach(codex.id, { onData: (chunk) => adoptedOutput.push(chunk) });
    await expect.poll(() => adoptedOutput.join(""), { timeout: 5_000 }).toContain(`FAKE_CODEX_TUI:${codex.id}`);
    expect(restarted.get(codex.id)).toMatchObject({ identityState: "exact", providerSessionId: exactId });
    expect(harness.launches().filter((entry) => entry.provider === "codex")).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

test("detached Codex OSC activity emits provider-labelled waiting and finished pushes only while away", async () => {
  const harness = await createProviderIntegrationHarness();
  try {
    const codex = await harness.createSession("codex");
    const terminal = await harness.attach(codex.id);
    await expect.poll(() => terminal.output()).toContain(`FAKE_CODEX_TUI:${codex.id}`);
    await expect.poll(() => harness.terminalManager.get(codex.id)?.identityState, { timeout: 5_000 }).toBe("exact");

    harness.command(codex.id, "approval");
    await expect
      .poll(() => JSON.stringify(harness.events()))
      .toContain(`"kind":"control-handled","sessionId":"${codex.id}","action":"approval"`);
    await expect.poll(() => terminal.output()).toContain("Approval requested: integration");
    await expect.poll(() => harness.terminalManager.get(codex.id)?.activity).toBe("blocked");
    expect(harness.pushEvents).toEqual([]);
    await terminal.close();
    await expect.poll(() => harness.pushEvents).toHaveLength(1);
    expect(buildPushPayload(harness.pushEvents[0]!)).toMatchObject({
      title: "Codex is waiting",
      body: `${basename(harness.cwd)} needs your input in Codex.`,
      requireInteraction: true,
    });

    harness.command(codex.id, "complete");
    await expect.poll(() => harness.terminalManager.get(codex.id)?.activity).toBe("idle");
    expect(harness.pushEvents).toHaveLength(1);
    harness.command(codex.id, "exit");
    await expect.poll(() => harness.terminalManager.get(codex.id)?.status).toBe("ended");
    await expect.poll(() => harness.pushEvents).toHaveLength(2);
    expect(buildPushPayload(harness.pushEvents[1]!)).toMatchObject({
      title: "Codex session ended",
      body: `${basename(harness.cwd)} has ended in Codex.`,
      requireInteraction: false,
    });
  } finally {
    await harness.close();
  }
});
