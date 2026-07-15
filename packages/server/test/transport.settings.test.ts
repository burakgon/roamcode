import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openSessionStore } from "../src/session-store.js";
import type { SessionStore } from "../src/session-store.js";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

const auth = { authorization: "Bearer test-token" };

describe("session defaults transport", () => {
  let server: TestServer;
  let store: SessionStore;

  beforeEach(async () => {
    store = openSessionStore({ dbPath: ":memory:" });
    server = await buildTestServer({ terminalAvailable: false, deps: { store } });
  });

  afterEach(async () => {
    await server.app.close();
    store.close();
  });

  test("GET and PUT require authentication", async () => {
    const get = await server.app.inject({ method: "GET", url: "/settings/session-defaults" });
    const put = await server.app.inject({
      method: "PUT",
      url: "/settings/session-defaults",
      headers: { "content-type": "application/json" },
      payload: { defaults: {}, expectedRevision: 0 },
    });

    expect(get.statusCode).toBe(401);
    expect(put.statusCode).toBe(401);
  });

  test("GET maps an unset injected store to revision zero", async () => {
    const getDefaults = vi.spyOn(store, "getSessionDefaults");

    const response = await server.app.inject({
      method: "GET",
      url: "/settings/session-defaults",
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ defaults: null, revision: 0 });
    expect(getDefaults).toHaveBeenCalledOnce();
  });

  test("first boot remembers the newest durable session when the old defaults document has no provider", async () => {
    await server.app.close();
    store.close();
    store = openSessionStore({ dbPath: ":memory:" });
    store.putSessionDefaults(
      {
        effort: "low",
        dangerouslySkip: false,
        codex: { model: "gpt-5.1" },
      },
      0,
      100,
    );
    store.claimNew({
      id: "older",
      provider: "claude",
      cwd: "/tmp/older",
      mode: "terminal",
      status: "stopped",
      createdAt: 200,
      lastActivityAt: 200,
      dangerouslySkip: false,
      spawnArgs: ["--model", "claude-sonnet-4-5", "--effort", "high", "--permission-mode", "plan"],
    });
    store.claimNew({
      id: "newest",
      provider: "codex",
      cwd: "/tmp/newest",
      mode: "terminal",
      status: "stopped",
      createdAt: 300,
      lastActivityAt: 300,
      launchOptions: {
        provider: "codex",
        model: "gpt-5.2-codex",
        reasoningEffort: "high",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        webSearch: true,
      },
    });
    server = await buildTestServer({ terminalAvailable: false, deps: { store } });

    const response = await server.app.inject({
      method: "GET",
      url: "/settings/session-defaults",
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      defaults: {
        provider: "codex",
        effort: "low",
        dangerouslySkip: false,
        codex: {
          model: "gpt-5.2-codex",
          reasoningEffort: "high",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          webSearch: true,
        },
      },
      revision: 2,
      updatedAt: expect.any(Number),
    });
  });

  test("a malformed legacy launch record cannot prevent server startup", async () => {
    await server.app.close();
    store.close();
    store = openSessionStore({ dbPath: ":memory:" });
    store.claimNew({
      id: "legacy",
      provider: "claude",
      cwd: "/tmp/legacy",
      mode: "terminal",
      status: "stopped",
      createdAt: 100,
      lastActivityAt: 100,
      dangerouslySkip: false,
      spawnArgs: ["--model"],
    });

    server = await buildTestServer({ terminalAvailable: false, deps: { store } });
    const response = await server.app.inject({
      method: "GET",
      url: "/settings/session-defaults",
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ defaults: null, revision: 0 });
  });

  test("PUT normalizes a complete document and increments its revision", async () => {
    const putDefaults = vi.spyOn(store, "putSessionDefaults");
    const before = Date.now();

    const first = await server.app.inject({
      method: "PUT",
      url: "/settings/session-defaults",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        defaults: {
          model: "claude-opus-4-1",
          dangerouslySkip: true,
          permissionMode: "plan",
          codex: {
            dangerouslyBypassApprovalsAndSandbox: true,
            sandbox: "workspace-write",
            approvalPolicy: "on-request",
          },
        },
        expectedRevision: 0,
      },
    });

    const firstBody = first.json();
    expect(first.statusCode).toBe(200);
    expect(firstBody).toEqual({
      defaults: {
        effort: "medium",
        model: "claude-opus-4-1",
        dangerouslySkip: true,
        codex: { dangerouslyBypassApprovalsAndSandbox: true },
      },
      revision: 1,
      updatedAt: expect.any(Number),
    });
    expect(firstBody.updatedAt).toBeGreaterThanOrEqual(before);
    expect(firstBody.updatedAt).toBeLessThanOrEqual(Date.now());
    expect(putDefaults).toHaveBeenCalledWith(firstBody.defaults, 0, firstBody.updatedAt);

    const second = await server.app.inject({
      method: "PUT",
      url: "/settings/session-defaults",
      headers: { ...auth, "content-type": "application/json" },
      payload: { defaults: { effort: "high", dangerouslySkip: false }, expectedRevision: 1 },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      defaults: { effort: "high", dangerouslySkip: false },
      revision: 2,
    });
  });

  test.each([
    [{ defaults: { effort: "high", dangerouslySkip: false, unknown: true }, expectedRevision: 0 }],
    [{ defaults: { effort: "high", dangerouslySkip: "false" }, expectedRevision: 0 }],
    [{ defaults: { effort: "high", dangerouslySkip: false }, expectedRevision: -1 }],
    [{ defaults: { effort: "high", dangerouslySkip: false }, expectedRevision: 1.5 }],
    [{ defaults: { effort: "high", dangerouslySkip: false }, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
    [{ defaults: { effort: "high", dangerouslySkip: false }, expectedRevision: "0" }],
    [{ defaults: { effort: "high", dangerouslySkip: false }, expectedRevision: 0, unknown: true }],
  ])("PUT rejects invalid or unknown payload %#", async (payload) => {
    const response = await server.app.inject({
      method: "PUT",
      url: "/settings/session-defaults",
      headers: { ...auth, "content-type": "application/json" },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.any(String) });
  });

  test("a stale PUT returns a structured conflict with the current document", async () => {
    store.putSessionDefaults({ effort: "high", dangerouslySkip: false }, 0, 1_234);

    const response = await server.app.inject({
      method: "PUT",
      url: "/settings/session-defaults",
      headers: { ...auth, "content-type": "application/json" },
      payload: { defaults: { effort: "low", dangerouslySkip: false }, expectedRevision: 0 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "SETTINGS_CONFLICT",
      error: "Session defaults revision conflict",
      current: {
        defaults: { effort: "high", dangerouslySkip: false },
        revision: 1,
        updatedAt: 1_234,
      },
    });
  });

  test("a stale first PUT safely returns the unset envelope", async () => {
    const response = await server.app.inject({
      method: "PUT",
      url: "/settings/session-defaults",
      headers: { ...auth, "content-type": "application/json" },
      payload: { defaults: { effort: "low", dangerouslySkip: false }, expectedRevision: 2 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "SETTINGS_CONFLICT",
      error: "Session defaults revision conflict",
      current: { defaults: null, revision: 0 },
    });
  });

  test("PUT rejects payloads above the route's 256 KiB bound", async () => {
    const response = await server.app.inject({
      method: "PUT",
      url: "/settings/session-defaults",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({
        defaults: { effort: "high", dangerouslySkip: false, model: "x".repeat(256 * 1024) },
        expectedRevision: 0,
      }),
    });

    expect(response.statusCode).toBe(413);
  });
});
