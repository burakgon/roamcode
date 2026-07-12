import { afterEach, describe, expect, test, vi } from "vitest";
import type { ZodType } from "zod";
import type {
  ClaudeAuthService,
  ClaudeLatestService,
  ClaudeMetadataService,
  ClaudeVersionProbe,
  CodexMetadataRpc,
  CodexLatestService,
  UsageService,
  SessionStore,
  PushStore,
  AgentProvider,
} from "../src/index.js";
import {
  CodexMetadataService,
  createClaudeProvider,
  createServer,
  loadServerConfig,
  ProviderError,
  ProviderRegistry,
} from "../src/index.js";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

const auth = { authorization: "Bearer test-token" };
let current: TestServer | undefined;

function metadataWithHealthyCatalog(models: unknown[]): CodexMetadataService {
  const rpc: CodexMetadataRpc = {
    request: async <T>(method: string, _params: unknown, schema: ZodType<T>): Promise<T> => {
      if (method !== "model/list") throw new Error("unexpected metadata method");
      return schema.parse({ data: models, nextCursor: null });
    },
    onNotification: () => () => {},
  };
  return new CodexMetadataService(rpc);
}

const knownCatalogModel = {
  id: "id-known-model",
  model: "known-model",
  displayName: "Known model",
  description: "Known model description",
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Low" },
    { reasoningEffort: "high", description: "High" },
  ],
  defaultReasoningEffort: "low",
};

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

describe("provider-aware transport", () => {
  test("POST /sessions treats an omitted legacy provider as Claude", async () => {
    current = await buildTestServer({ terminalAvailable: true });
    const res = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: {
        cwd: process.cwd(),
        model: "opus",
        effort: "max",
        permissionMode: "plan",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().session).toMatchObject({
      provider: "claude",
      model: "opus",
      effort: "max",
      permissionMode: "plan",
    });
  });

  test("POST /sessions still rejects an explicitly invalid provider", async () => {
    current = await buildTestServer({ terminalAvailable: true });
    const res = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { provider: "unknown", cwd: process.cwd() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_PROVIDER" });
  });

  test("POST /sessions rejects an explicitly null provider", async () => {
    current = await buildTestServer({ terminalAvailable: true });
    const res = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { provider: null, cwd: process.cwd() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_PROVIDER" });
  });

  test("creates and lists provider-native Codex sessions", async () => {
    current = await buildTestServer({ terminalAvailable: true });
    const created = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: {
        provider: "codex",
        cwd: process.cwd(),
        options: { sandbox: "workspace-write", approvalPolicy: "on-request", reasoningEffort: "high" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().session).toMatchObject({
      provider: "codex",
      mode: "terminal",
      effort: "high",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });

    const listed = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
    expect(listed.json().sessions).toEqual([
      expect.objectContaining({
        provider: "codex",
        mode: "terminal",
        identityState: "pending",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      }),
    ]);
  });

  test("POST /sessions rejects only the selected provider when its terminal binary is unavailable", async () => {
    const unavailableCodex: AgentProvider = {
      id: "codex",
      displayName: "Codex",
      resumeIdentity: "required",
      probe: async () => ({ terminalAvailable: false, metadataAvailable: false, detail: "/secret/bin" }),
      buildProcess: async () => {
        throw new Error("must not build");
      },
      runtimeSignals: () => [],
      classifyPane: () => "idle",
      cleanup: () => {},
    };
    current = await buildTestServer({
      terminalAvailable: true,
      deps: {
        providers: new ProviderRegistry([createClaudeProvider({ claudeBin: process.execPath }), unavailableCodex]),
      },
    });

    const response = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { provider: "codex", cwd: process.cwd(), options: {} },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "PROVIDER_UNAVAILABLE", error: "Provider terminal unavailable" });
    expect(response.body).not.toContain("secret");

    const claude = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { provider: "claude", cwd: process.cwd(), options: {} },
    });
    expect(claude.statusCode).toBe(201);
  });

  test("POST /sessions rejects an incompatible explicit Codex model/reasoning pair when catalog is available", async () => {
    current = await buildTestServer({
      terminalAvailable: true,
      deps: { codexMetadata: metadataWithHealthyCatalog([knownCatalogModel]) },
    });

    const response = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: {
        provider: "codex",
        cwd: process.cwd(),
        options: { model: "known-model", reasoningEffort: "minimal" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "INVALID_PROVIDER_OPTIONS",
      error: "Invalid Codex model or reasoning selection",
    });
  });

  test("POST /sessions accepts a bounded unknown custom Codex model with a healthy catalog", async () => {
    current = await buildTestServer({
      terminalAvailable: true,
      deps: { codexMetadata: metadataWithHealthyCatalog([knownCatalogModel]) },
    });

    const response = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: {
        provider: "codex",
        cwd: process.cwd(),
        options: { model: "safe-custom-model", reasoningEffort: "high" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().session).toMatchObject({ provider: "codex", model: "safe-custom-model" });
    expect(response.json()).not.toHaveProperty("warnings");
  });

  test("POST /sessions rejects non-baseline reasoning for an unknown custom Codex model with a healthy catalog", async () => {
    current = await buildTestServer({
      terminalAvailable: true,
      deps: { codexMetadata: metadataWithHealthyCatalog([knownCatalogModel]) },
    });

    const response = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: {
        provider: "codex",
        cwd: process.cwd(),
        options: { model: "safe-custom-model", reasoningEffort: "future-depth" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "INVALID_PROVIDER_OPTIONS",
      error: "Invalid Codex model or reasoning selection",
    });
  });

  test("POST /sessions rejects an unsafe custom model before metadata validation", async () => {
    const validateModelSelection = vi.fn();
    current = await buildTestServer({
      terminalAvailable: true,
      deps: { codexMetadata: { validateModelSelection } as unknown as CodexMetadataService },
    });

    const response = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { provider: "codex", cwd: process.cwd(), options: { model: "unsafe custom model" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_PROVIDER_OPTIONS" });
    expect(validateModelSelection).not.toHaveBeenCalled();
  });

  test("POST /sessions allows an explicit custom Codex model when metadata is degraded with a stable warning", async () => {
    const validateModelSelection = vi.fn(async () => {
      throw new Error("raw protocol/catalog frame");
    });
    current = await buildTestServer({
      terminalAvailable: true,
      deps: { codexMetadata: { validateModelSelection } as unknown as CodexMetadataService },
    });

    const response = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: {
        provider: "codex",
        cwd: process.cwd(),
        options: { model: "custom-model", reasoningEffort: "future-depth" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().warnings).toEqual([
      {
        code: "PROVIDER_METADATA_UNAVAILABLE",
        message: "Codex model compatibility could not be verified",
      },
    ]);
    expect(response.body).not.toMatch(/raw protocol|catalog frame/i);
  });

  test("POST /sessions rejects an incompatible explicit Claude model/effort pair when catalog is available", async () => {
    const claudeMetadata = {
      getModels: vi.fn(),
      validateModelSelection: vi.fn(async () => {
        throw new ProviderError("INVALID_PROVIDER_OPTIONS", "Invalid Claude model and effort selection");
      }),
      dispose: vi.fn(),
    } as unknown as ClaudeMetadataService;
    current = await buildTestServer({ terminalAvailable: true, deps: { claudeMetadata } });

    const response = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: {
        provider: "claude",
        cwd: process.cwd(),
        options: { model: "sonnet", effort: "future-depth" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "INVALID_PROVIDER_OPTIONS",
      error: "Invalid Claude model or effort selection",
    });
    expect(claudeMetadata.validateModelSelection).toHaveBeenCalledWith("sonnet", "future-depth");
  });

  test("POST /sessions keeps Claude terminal creation available when compatibility metadata fails", async () => {
    const claudeMetadata = {
      getModels: vi.fn(),
      validateModelSelection: vi.fn(async () => {
        throw new Error("raw Claude metadata containing secret");
      }),
      dispose: vi.fn(),
    } as unknown as ClaudeMetadataService;
    current = await buildTestServer({ terminalAvailable: true, deps: { claudeMetadata } });

    const response = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: {
        provider: "claude",
        cwd: process.cwd(),
        options: { model: "sonnet", effort: "future-depth" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().warnings).toEqual([
      {
        code: "PROVIDER_METADATA_UNAVAILABLE",
        message: "Claude model compatibility could not be verified",
      },
    ]);
    expect(response.body).not.toMatch(/raw Claude metadata|secret/i);
  });

  test("provider metadata failure does not disable either terminal provider", async () => {
    const codexMetadata = {
      getAccount: vi.fn(async () => ({ authenticated: true, authMethod: "chatgpt" })),
    } as unknown as CodexMetadataService;
    const codexCapabilityProbe = {
      get: vi.fn(async () => {
        throw new Error("protocol frame containing secret");
      }),
    };
    current = await buildTestServer({
      terminalAvailable: true,
      deps: { codexMetadata, codexCapabilityProbe },
    });

    const res = await current.app.inject({ method: "GET", url: "/providers", headers: auth });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().providers).toMatchObject({
      claude: { terminalAvailable: true },
      codex: { terminalAvailable: true, metadataAvailable: false },
    });
    expect(JSON.stringify(res.json())).not.toContain("secret");

    const diag = await current.app.inject({ method: "GET", url: "/diag", headers: auth });
    expect(diag.statusCode, diag.body).toBe(200);
    expect(diag.json().providers).toMatchObject({
      claude: { terminalAvailable: true },
      codex: { terminalAvailable: true, metadataAvailable: false },
    });
    expect(JSON.stringify(diag.json())).not.toContain("secret");
  });

  test("exposes Codex metadata routes with stable shapes", async () => {
    const codexMetadata = {
      getAccount: vi.fn(async () => ({ authenticated: true, authMethod: "chatgpt", plan: "plus" })),
      startDeviceLogin: vi.fn(async () => ({
        loginId: "login-1",
        userCode: "ABCD",
        verificationUrl: "https://x",
        expiresAt: 123,
        completion: Promise.resolve({ status: "completed" as const }),
      })),
      getLoginStatus: vi.fn(() => ({ status: "pending" })),
      cancelLogin: vi.fn(async () => ({ status: "canceled" })),
      getModels: vi.fn(async () => [{ value: "gpt-5", displayName: "GPT-5", supportedReasoningEfforts: ["high"] }]),
      listProfiles: vi.fn(async () => ["personal", "work.secure"]),
      getUsage: vi.fn(async () => ({ bars: [], fetchedAt: 1 })),
    } as unknown as CodexMetadataService;
    const codexLatest = {
      getVersion: vi.fn(async () => ({ installed: "1.2.3", provenance: "npm", latest: "1.2.4" })),
    } as unknown as CodexLatestService;
    current = await buildTestServer({ terminalAvailable: true, deps: { codexMetadata, codexLatest } });

    const status = await current.app.inject({
      method: "GET",
      url: "/providers/codex/auth/status",
      headers: auth,
    });
    expect(status.json()).toMatchObject({ available: true, authenticated: true, authMethod: "chatgpt" });

    const login = await current.app.inject({
      method: "POST",
      url: "/providers/codex/auth/login/start",
      headers: auth,
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({
      loginId: "login-1",
      userCode: "ABCD",
      verificationUrl: "https://x",
      expiresAt: 123,
    });

    const loginStatus = await current.app.inject({
      method: "GET",
      url: "/providers/codex/auth/login/status?loginId=login-1",
      headers: auth,
    });
    expect(loginStatus.json()).toEqual({ status: "pending" });
    expect(codexMetadata.getLoginStatus).toHaveBeenCalledWith("login-1");

    const missingLoginId = await current.app.inject({
      method: "GET",
      url: "/providers/codex/auth/login/status",
      headers: auth,
    });
    expect(missingLoginId.statusCode).toBe(400);
    const oversizedLoginId = await current.app.inject({
      method: "GET",
      url: `/providers/codex/auth/login/status?loginId=${"x".repeat(257)}`,
      headers: auth,
    });
    expect(oversizedLoginId.statusCode).toBe(400);

    const canceled = await current.app.inject({
      method: "POST",
      url: "/providers/codex/auth/login/cancel",
      headers: auth,
      payload: { loginId: "login-1" },
    });
    expect(canceled.json()).toEqual({ status: "canceled" });

    expect(
      (await current.app.inject({ method: "GET", url: "/providers/codex/models", headers: auth })).json(),
    ).toMatchObject({ models: [{ value: "gpt-5" }] });
    expect(
      (await current.app.inject({ method: "GET", url: "/providers/codex/profiles", headers: auth })).json(),
    ).toEqual({ profiles: ["personal", "work.secure"] });
    expect(
      (await current.app.inject({ method: "GET", url: "/providers/claude/profiles", headers: auth })).json(),
    ).toEqual({ profiles: [] });
    expect(
      (await current.app.inject({ method: "GET", url: "/providers/codex/usage", headers: auth })).json(),
    ).toMatchObject({ usage: { bars: [] } });
    expect(
      (await current.app.inject({ method: "GET", url: "/providers/codex/version", headers: auth })).json(),
    ).toMatchObject({ installed: "1.2.3", latest: "1.2.4" });
  });

  test("GET /providers/claude/models returns the injected live Claude catalog", async () => {
    const models = [
      {
        value: "sonnet",
        displayName: "Sonnet",
        description: "Balanced model",
        supportedEffortLevels: ["low", "medium", "future-depth"],
        isDefault: true,
      },
    ];
    const claudeMetadata = {
      getModels: vi.fn().mockResolvedValue(models),
      validateModelSelection: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    } as unknown as ClaudeMetadataService;
    current = await buildTestServer({ terminalAvailable: true, deps: { claudeMetadata } });

    const response = await current.app.inject({
      method: "GET",
      url: "/providers/claude/models",
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ models });
    expect(claudeMetadata.getModels).toHaveBeenCalledTimes(1);
  });

  test("GET /providers/claude/models returns stable metadata-unavailable details when probing fails", async () => {
    const claudeMetadata = {
      getModels: vi.fn().mockRejectedValue(new Error("raw Claude metadata containing secret")),
      validateModelSelection: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    } as unknown as ClaudeMetadataService;
    current = await buildTestServer({ terminalAvailable: true, deps: { claudeMetadata } });

    const response = await current.app.inject({
      method: "GET",
      url: "/providers/claude/models",
      headers: auth,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "PROVIDER_METADATA_UNAVAILABLE",
      error: "Provider metadata is unavailable",
    });
    expect(response.body).not.toMatch(/raw Claude metadata|secret/i);
  });

  test("provider routes are default-deny authenticated and reject unknown providers", async () => {
    current = await buildTestServer({ terminalAvailable: true });
    expect((await current.app.inject({ method: "GET", url: "/providers" })).statusCode).toBe(401);
    expect((await current.app.inject({ method: "GET", url: "/providers/codex/profiles" })).statusCode).toBe(401);
    expect(
      (await current.app.inject({ method: "GET", url: "/providers/codex/auth/login/status?loginId=x" })).statusCode,
    ).toBe(401);
    const unknown = await current.app.inject({
      method: "GET",
      url: "/providers/openai/auth/status",
      headers: auth,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ code: "PROVIDER_NOT_FOUND", error: "Provider not found" });
  });

  test("the default server registry exposes both real provider adapters", async () => {
    const config = loadServerConfig({ ACCESS_TOKEN: "test-token", HOME: process.cwd() });
    const server = createServer(config, { terminalAvailable: false });
    const response = await server.app.inject({ method: "GET", url: "/providers", headers: auth });
    expect(response.json().providers).toMatchObject({
      claude: { terminalAvailable: false },
      codex: { terminalAvailable: false },
    });
    await server.app.close();
  });

  test("provider metadata and auth resources are disposed exactly once on close", async () => {
    const codexDispose = vi.fn();
    const claudeDispose = vi.fn();
    const cancel = vi.fn();
    const stop = vi.fn(async () => {});
    current = await buildTestServer({
      terminalAvailable: true,
      deps: {
        codexMetadata: { dispose: codexDispose } as unknown as CodexMetadataService,
        claudeMetadata: { dispose: claudeDispose } as unknown as ClaudeMetadataService,
        claudeAuth: { cancel } as never,
        disposeProviders: stop,
      },
    });
    await current.app.close();
    await current.app.close();
    expect(codexDispose).toHaveBeenCalledTimes(1);
    expect(claudeDispose).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    current = undefined;
  });

  test("store and push-store close are attempted independently when either throws", async () => {
    const storeClose = vi.fn(() => {
      throw new Error("session db close failed");
    });
    const pushClose = vi.fn(() => {
      throw new Error("push db close failed");
    });
    current = await buildTestServer({
      terminalAvailable: true,
      deps: {
        store: { close: storeClose } as unknown as SessionStore,
        pushStore: { close: pushClose } as unknown as PushStore,
      },
    });

    await expect(current.app.close()).resolves.toBeUndefined();
    expect(storeClose).toHaveBeenCalledTimes(1);
    expect(pushClose).toHaveBeenCalledTimes(1);
    current = undefined;
  });

  test("Claude compatibility aliases delegate to the same provider services", async () => {
    const claudeAuth = {
      status: vi.fn(async () => ({ loggedIn: true, email: "a@example.com" })),
      cancel: vi.fn(),
    } as unknown as ClaudeAuthService;
    const usage = { getUsage: vi.fn(async () => ({ session: null, weekly: null })) } as unknown as UsageService;
    const claudeLatest = { getLatest: vi.fn(async () => "2.0.0") } as unknown as ClaudeLatestService;
    const claudeVersionProbe = {
      get: vi.fn(async () => ({ available: true, version: "1.0.0" })),
    } satisfies ClaudeVersionProbe;
    current = await buildTestServer({
      terminalAvailable: true,
      deps: { claudeAuth, usage, claudeLatest, claudeVersionProbe },
    });

    const [legacyStatus, providerStatus, legacyUsage, providerUsage, legacyVersion, providerVersion] =
      await Promise.all([
        current.app.inject({ method: "GET", url: "/auth/status", headers: auth }),
        current.app.inject({ method: "GET", url: "/providers/claude/auth/status", headers: auth }),
        current.app.inject({ method: "GET", url: "/usage", headers: auth }),
        current.app.inject({ method: "GET", url: "/providers/claude/usage", headers: auth }),
        current.app.inject({ method: "GET", url: "/claude/version", headers: auth }),
        current.app.inject({ method: "GET", url: "/providers/claude/version", headers: auth }),
      ]);
    expect(legacyStatus.json()).toEqual(providerStatus.json());
    expect(legacyUsage.json()).toEqual(providerUsage.json());
    expect(legacyVersion.json()).toEqual(providerVersion.json());
  });
});
