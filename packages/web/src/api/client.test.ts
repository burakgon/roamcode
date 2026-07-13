import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, terminalWsUrl, ApiError } from "./client";
import type { CreateSessionBody } from "./client";
import type { CodexLoginCancellation } from "../providers/types";

// Every new outgoing request must make a provider choice. Incoming sessions remain tolerant of old servers.
// @ts-expect-error provider-less create bodies are deliberately forbidden
const providerlessCreate: CreateSessionBody = { cwd: "/x" };
void providerlessCreate;

const conflictingClaudeSafety: CreateSessionBody = {
  provider: "claude",
  cwd: "/x",
  // @ts-expect-error dangerous Claude mode cannot carry an ordinary permission mode
  options: { dangerouslySkip: true, permissionMode: "plan" },
};
void conflictingClaudeSafety;

const conflictingCodexSafety: CreateSessionBody = {
  provider: "codex",
  cwd: "/x",
  // @ts-expect-error dangerous Codex mode cannot carry ordinary sandbox controls
  options: { dangerouslyBypassApprovalsAndSandbox: true, sandbox: "workspace-write" },
};
void conflictingCodexSafety;

const missingLogin: CodexLoginCancellation = { status: "notFound" };
void missingLogin;
// @ts-expect-error login completion states are not cancellation response states
const invalidCancellation: CodexLoginCancellation = { status: "completed" };
void invalidCancellation;

const baseUrl = "http://127.0.0.1:4280";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ApiClient", () => {
  it("getSessionDefaults GETs the authenticated defaults envelope", async () => {
    const envelope = {
      defaults: { effort: "medium", dangerouslySkip: false },
      revision: 3,
      updatedAt: 1_234,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(envelope));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });

    await expect(api.getSessionDefaults()).resolves.toEqual(envelope);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/settings/session-defaults`);
    expect((init as RequestInit).method).toBeUndefined();
    expect((init as RequestInit).headers).toEqual({ authorization: "Bearer tok" });
  });

  it("putSessionDefaults PUTs the complete document and expected revision", async () => {
    const defaults = {
      effort: "high",
      model: "claude-opus-4-1",
      dangerouslySkip: false,
      permissionMode: "plan" as const,
    };
    const envelope = { defaults, revision: 4, updatedAt: 2_345 };
    fetchMock.mockResolvedValueOnce(jsonResponse(envelope));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });

    await expect(api.putSessionDefaults(defaults, 3)).resolves.toEqual(envelope);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/settings/session-defaults`);
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer tok",
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ defaults, expectedRevision: 3 });
  });

  it("preserves the structured settings conflict body on ApiError", async () => {
    const body = {
      code: "SETTINGS_CONFLICT",
      error: "Session defaults revision conflict",
      current: {
        defaults: { effort: "low", dangerouslySkip: false },
        revision: 5,
        updatedAt: 3_456,
      },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(body, 409));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });

    await expect(api.putSessionDefaults({ effort: "high", dangerouslySkip: false }, 4)).rejects.toMatchObject({
      status: 409,
      code: "SETTINGS_CONFLICT",
      message: "Session defaults revision conflict",
      body,
    });
  });

  it("listSessions GETs /sessions with a bearer token and returns the array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ sessions: [{ id: "s1", cwd: "/p", dangerouslySkip: false, status: "running", createdAt: 1 }] }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const sessions = await api.listSessions();
    expect(sessions).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/sessions`);
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("createSession POSTs a discriminated Claude body and preserves non-fatal warnings", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          session: {
            id: "s2",
            provider: "claude",
            cwd: "/x",
            dangerouslySkip: false,
            status: "running",
            createdAt: 2,
          },
          warnings: [{ code: "PROVIDER_METADATA_UNAVAILABLE", message: "metadata unavailable" }],
        },
        201,
      ),
    );
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    const created = await api.createSession({ provider: "claude", cwd: "/x", options: { model: "opus" } });
    expect(created.session.id).toBe("s2");
    expect(created.warnings).toEqual([{ code: "PROVIDER_METADATA_UNAVAILABLE", message: "metadata unavailable" }]);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      provider: "claude",
      cwd: "/x",
      options: { model: "opus" },
    });
  });

  it("preserves the server error code when provider options become stale", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: "INVALID_PROVIDER_OPTIONS", error: "Invalid Codex model or reasoning selection" }, 400),
    );
    const api = createApiClient({ baseUrl, getToken: () => undefined });

    await expect(
      api.createSession({
        provider: "codex",
        cwd: "/x",
        options: { model: "gpt-stale", reasoningEffort: "high" },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PROVIDER_OPTIONS",
      message: "Invalid Codex model or reasoning selection",
    });
  });

  it("POSTs a provider-native Codex body without flattening its controls", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        session: {
          id: "c1",
          provider: "codex",
          identityState: "pending",
          cwd: "/x",
          dangerouslySkip: false,
          status: "running",
          createdAt: 2,
        },
      }),
    );
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    await api.createSession({
      provider: "codex",
      cwd: "/x",
      options: {
        model: "gpt-future-custom",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reasoningEffort: "high",
      },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      provider: "codex",
      cwd: "/x",
      options: {
        model: "gpt-future-custom",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reasoningEffort: "high",
      },
    });
  });

  it("throws ApiError with status 401 on unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const api = createApiClient({ baseUrl, getToken: () => "bad" });
    await expect(api.listSessions()).rejects.toMatchObject({ status: 401 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    await expect(api.listSessions()).rejects.toBeInstanceOf(ApiError);
  });

  it("listDir GETs /fs/list with the path query", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ path: "/home", entries: [] }));
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    await api.listDir("/home/u");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/fs/list?path=${encodeURIComponent("/home/u")}`);
  });

  it("deleteSession DELETEs /sessions/:id and resolves on a 204 with no body", async () => {
    // A 204 No Content with an empty body — the client must NOT try to parse JSON (that would throw).
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.deleteSession("s1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/sessions/s1`);
    expect((init as RequestInit).method).toBe("DELETE");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("deleteSession rejects with ApiError on a real failure (5xx)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.deleteSession("s1")).rejects.toMatchObject({ status: 500, message: "boom" });
  });

  it("rotateToken POSTs /token/rotate, returns the new token, and persists it to the token store", async () => {
    localStorage.clear();
    localStorage.setItem("roamcode.token", "old-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "fresh-token" }));
    const api = createApiClient({ baseUrl, getToken: () => "old-token" });
    const next = await api.rotateToken();
    expect(next).toBe("fresh-token");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/token/rotate`);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer old-token" });
    // The new token is stored so subsequent requests use it (the old one is dead server-side).
    expect(localStorage.getItem("roamcode.token")).toBe("fresh-token");
  });

  it("downloadUrl includes path and token", () => {
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    expect(api.downloadUrl("/home/u/a.txt")).toBe(
      `${baseUrl}/fs/download?path=${encodeURIComponent("/home/u/a.txt")}&token=tok`,
    );
  });

  it("getVersion GETs /version and returns the version info", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        current: "v1.0.0",
        latest: "v1.1.0",
        behind: 2,
        releaseCount: 2,
        updatable: true,
        updateAvailable: true,
        updateAction: "update",
        installation: "managed",
        runningVersion: "1.0.0",
        activeVersion: "1.0.0",
        installDrift: false,
        checkStatus: "fresh",
        runningBuild: "1.0.0",
        buildDrift: false,
        changelog: [
          { id: "1.1.0:0", version: "1.1.0", subject: "new", group: "new", when: "2h", date: "2026-06-25T10:00:00Z" },
        ],
      }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const v = await api.getVersion();
    expect(v.behind).toBe(2);
    expect(v.updateAvailable).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/version`);
  });

  it("applyUpdate POSTs /update with confirm:true and returns the accepted operation", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, state: "starting", operationId: "op-1", target: "1.1.0" }, 202),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.applyUpdate("v1.1.0")).resolves.toMatchObject({ operationId: "op-1", target: "1.1.0" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/update`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ confirm: true, target: "v1.1.0" });
  });

  it("applyUpdate rejects with ApiError when the server refuses (409)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "not a git checkout" }, 409));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.applyUpdate()).rejects.toMatchObject({ status: 409 });
    await expect(api.applyUpdate()).rejects.toBeInstanceOf(ApiError);
  });

  it("getUpdateStatus GETs /update/status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "verifying", phase: "boot smoke" }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const s = await api.getUpdateStatus();
    expect(s.state).toBe("verifying");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/update/status`);
  });

  it("getModels aliases the Claude provider model route and returns the list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ value: "opus[1m]", displayName: "Opus" }] }));
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    const models = await api.getModels();
    expect(models).toEqual([{ value: "opus[1m]", displayName: "Opus" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/providers/claude/models`);
  });

  it("uses provider routes and preserves each provider's native metadata shape", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          providers: {
            claude: { terminalAvailable: true, metadataAvailable: false },
            codex: { terminalAvailable: true, metadataAvailable: true, version: "1.2.3" },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            {
              value: "gpt-future-custom",
              id: "custom",
              displayName: "Future Custom",
              description: "custom model",
              isDefault: false,
              supportedReasoningEfforts: ["low", "high"],
              defaultReasoningEffort: "high",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ profiles: ["personal", "work.secure"] }))
      .mockResolvedValueOnce(
        jsonResponse({ usage: { bars: [{ id: "primary", label: "Primary", percent: 25 }], fetchedAt: 7 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ installed: "1.2.3", provenance: "npm", latest: "1.2.4", updateAvailable: true }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ available: true, authenticated: true, authMethod: "chatgpt", plan: "plus" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          loginId: "login-1",
          userCode: "ABCD",
          verificationUrl: "https://example.test/device",
          expiresAt: 9,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "pending" }))
      .mockResolvedValueOnce(jsonResponse({ status: "canceled" }));

    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const providers = await api.getProviders();
    const models = await api.getProviderModels("codex");
    const profiles = await api.getProviderProfiles("codex");
    const usage = await api.getProviderUsage("codex");
    const version = await api.getProviderVersion("codex");
    const auth = await api.getProviderAuthStatus("codex");
    const login = await api.startProviderLogin("codex");
    const loginStatus = await api.getProviderLoginStatus("codex", "login-1");
    const canceled = await api.cancelProviderLogin("codex", "login-1");

    expect(providers.codex).toEqual({ terminalAvailable: true, metadataAvailable: true, version: "1.2.3" });
    expect(models[0]).toMatchObject({ value: "gpt-future-custom", supportedReasoningEfforts: ["low", "high"] });
    expect(profiles).toEqual(["personal", "work.secure"]);
    expect(usage).toMatchObject({ bars: [{ id: "primary", label: "Primary", percent: 25 }] });
    expect(version).toMatchObject({ installed: "1.2.3", provenance: "npm", latest: "1.2.4" });
    expect(auth).toMatchObject({ available: true, authenticated: true, authMethod: "chatgpt" });
    expect(login).toMatchObject({ loginId: "login-1", userCode: "ABCD" });
    expect(loginStatus).toEqual({ status: "pending" });
    expect(canceled).toEqual({ status: "canceled" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${baseUrl}/providers`,
      `${baseUrl}/providers/codex/models`,
      `${baseUrl}/providers/codex/profiles`,
      `${baseUrl}/providers/codex/usage`,
      `${baseUrl}/providers/codex/version`,
      `${baseUrl}/providers/codex/auth/status`,
      `${baseUrl}/providers/codex/auth/login/start`,
      `${baseUrl}/providers/codex/auth/login/status?loginId=login-1`,
      `${baseUrl}/providers/codex/auth/login/cancel`,
    ]);
    expect(JSON.parse((fetchMock.mock.calls[8]![1] as RequestInit).body as string)).toEqual({ loginId: "login-1" });
  });

  it("keeps old metadata methods as thin Claude aliases over provider routes", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ usage: null }))
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ available: true, loggedIn: true }))
      .mockResolvedValueOnce(jsonResponse({ loginId: "l1", url: "https://example.test" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ installed: "1.0.0", latest: "1.1.0" }));
    const api = createApiClient({ baseUrl, getToken: () => undefined });

    await api.getUsage();
    await api.getModels();
    await api.getAuthStatus();
    await api.startAuthLogin();
    await api.cancelAuthLogin();
    await api.getClaudeVersion();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${baseUrl}/providers/claude/usage`,
      `${baseUrl}/providers/claude/models`,
      `${baseUrl}/providers/claude/auth/status`,
      `${baseUrl}/providers/claude/auth/login/start`,
      `${baseUrl}/providers/claude/auth/login/cancel`,
      `${baseUrl}/providers/claude/version`,
    ]);
  });

  it("renameSession PATCHes /sessions/:id with the trimmed name (204, no body)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.renameSession("s1", "  My session  ")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/sessions/s1`);
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: "My session" });
  });

  it("renameSession sends name:null for an empty string (clears the server name)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await api.renameSession("s1", "   ");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: null });
  });

  it("rollbackUpdate POSTs /update/rollback with confirm:true and surfaces a 409 as ApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, state: "starting", operationId: "op-r", target: "1.0.0" }, 202),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.rollbackUpdate()).resolves.toMatchObject({ operationId: "op-r", target: "1.0.0" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/update/rollback`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ confirm: true });
    // No previous build recorded → 409 rejects with the status the UI maps to its human message.
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "no previous build" }, 409));
    await expect(api.rollbackUpdate()).rejects.toMatchObject({ status: 409 });
  });

  it("mkdir POSTs /fs/mkdir with the path and rejects a 409 (exists) with ApiError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ path: "/home/u/new-proj" }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const created = await api.mkdir("/home/u/new-proj");
    expect(created).toEqual({ path: "/home/u/new-proj" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/fs/mkdir`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ path: "/home/u/new-proj" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "exists" }, 409));
    await expect(api.mkdir("/home/u/new-proj")).rejects.toMatchObject({ status: 409 });
  });

  it("searchDirs GETs /fs/search with q + base and returns the results array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [{ path: "/home/u/deep/web", name: "web", isGitRepo: true }] }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const results = await api.searchDirs("web", "/home/u");
    expect(results).toEqual([{ path: "/home/u/deep/web", name: "web", isGitRepo: true }]);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe(`${baseUrl}/fs/search?q=web&base=${encodeURIComponent("/home/u")}`);
  });
});

describe("terminalWsUrl", () => {
  it("appends respawn ONLY when a mode is chosen (Resume conversation → respawn=continue)", () => {
    // Absent (fresh spawn / plain re-attach): no respawn key rides the query at all.
    expect(terminalWsUrl("s1", 80, 24)).not.toContain("respawn=");
    // The ended overlay's Resume: the same URL + respawn=continue.
    const resume = terminalWsUrl("s1", 80, 24, "continue");
    expect(resume).toContain("/sessions/s1/terminal");
    expect(resume).toContain("respawn=continue");
    expect(resume).toContain("cols=80");
    expect(resume).toContain("rows=24");
    // Explicit fresh is also expressible (the server treats absent and fresh identically).
    expect(terminalWsUrl("s1", 80, 24, "fresh")).toContain("respawn=fresh");
  });
});
