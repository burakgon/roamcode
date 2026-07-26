import { afterEach, describe, expect, test, vi } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

const auth = { authorization: "Bearer test-token" };
let current: TestServer | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

describe("terminal-first transport", () => {
  test("manual creation starts a provider-neutral shell without probing provider metadata", async () => {
    const validateModelSelection = vi.fn();
    current = await buildTestServer({
      terminalAvailable: true,
      deps: {
        codexMetadata: { validateModelSelection } as never,
        claudeMetadata: { validateModelSelection } as never,
      },
    });

    const response = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { cwd: process.cwd() },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().session).toMatchObject({
      launch: { kind: "shell" },
      cwd: process.cwd(),
      status: "running",
    });
    expect(response.json().session).not.toHaveProperty("provider");
    expect(response.json().session).not.toHaveProperty("agent");
    expect(validateModelSelection).not.toHaveBeenCalled();
  });

  test.each([
    { provider: "claude" },
    { provider: null },
    { options: {} },
    { options: { provider: "codex", model: "gpt" } },
  ])("manual creation rejects removed provider selection fields: %j", async (removedField) => {
    current = await buildTestServer({ terminalAvailable: true });
    const response = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { cwd: process.cwd(), ...removedField },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_SESSION_REQUEST" });
  });

  test("an explicit integration can report and clear agent state without changing shell launch ownership", async () => {
    current = await buildTestServer({ terminalAvailable: true });
    const created = await current.app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: auth,
      payload: { cwd: process.cwd() },
    });
    const id = created.json().session.id as string;

    const reported = await current.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/agent-state`,
      headers: auth,
      payload: {
        active: true,
        provider: "codex",
        activity: "working",
        model: "gpt-test",
        providerSessionId: "thread-test",
      },
    });
    expect(reported.statusCode).toBe(202);
    expect(reported.json().agent).toEqual({
      provider: "codex",
      source: "integration",
      activity: "working",
      model: "gpt-test",
      identityState: "exact",
      providerSessionId: "thread-test",
    });

    const session = await current.app.inject({ method: "GET", url: `/api/v1/sessions/${id}`, headers: auth });
    expect(session.json().session).toMatchObject({
      launch: { kind: "shell" },
      provider: "codex",
      agent: { provider: "codex", source: "integration", activity: "working" },
    });
    const agents = await current.app.inject({ method: "GET", url: "/api/v1/agents", headers: auth });
    expect(agents.json().agents).toEqual([
      expect.objectContaining({ sessionId: id, provider: "codex", activity: "working" }),
    ]);

    const cleared = await current.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/agent-state`,
      headers: auth,
      payload: { active: false },
    });
    expect(cleared.statusCode).toBe(202);
    expect(cleared.json()).toEqual({ accepted: true, agent: null });
    const neutral = await current.app.inject({ method: "GET", url: `/api/v1/sessions/${id}`, headers: auth });
    expect(neutral.json().session.launch).toEqual({ kind: "shell" });
    expect(neutral.json().session).not.toHaveProperty("provider");
    expect(neutral.json().session).not.toHaveProperty("agent");
    expect((await current.app.inject({ method: "GET", url: "/api/v1/agents", headers: auth })).json().agents).toEqual(
      [],
    );
  });

  test("agent-state reports fail closed for unknown providers and malformed clear events", async () => {
    current = await buildTestServer({ terminalAvailable: true });
    const created = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { cwd: process.cwd() },
    });
    const id = created.json().session.id as string;

    const unknown = await current.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/agent-state`,
      headers: auth,
      payload: { active: true, provider: "unknown", activity: "working" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: "UNSUPPORTED_AGENT_PROVIDER" });

    const malformed = await current.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/agent-state`,
      headers: auth,
      payload: { active: false, provider: "codex" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "INVALID_AGENT_STATE" });
  });
});
