import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProductApiV2Client, ProductApiV2Error } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ProductApiV2Client", () => {
  const request = vi.fn<typeof fetch>();
  const client = createProductApiV2Client({
    baseUrl: "https://node.example/",
    getToken: () => "device-token",
    request,
  });

  beforeEach(() => request.mockReset());

  it("loads the exact Node and runtime resources with header authentication", async () => {
    request
      .mockResolvedValueOnce(jsonResponse({ nodes: [{ id: "node-1" }] }))
      .mockResolvedValueOnce(jsonResponse({ runtimes: [{ id: "runtime-1" }] }));

    await expect(client.listNodes()).resolves.toEqual([{ id: "node-1" }]);
    await expect(client.listNodeRuntimes("node/1")).resolves.toEqual([{ id: "runtime-1" }]);

    expect(request.mock.calls[0]?.[0]).toBe("https://node.example/api/v2/nodes");
    expect(request.mock.calls[1]?.[0]).toBe("https://node.example/api/v2/nodes/node%2F1/runtimes");
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer device-token");
  });

  it("sends server-derived automation create fields and an idempotency key", async () => {
    request.mockResolvedValueOnce(jsonResponse({ automation: { id: "automation-1" } }, 201));

    await client.createAutomation({
      name: "Release notes",
      nodeId: "node-1",
      agentRuntimeId: "runtime-1",
      cwd: "/repo",
      instruction: "Prepare release notes",
    });

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://node.example/api/v2/automations");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Release notes",
      nodeId: "node-1",
      agentRuntimeId: "runtime-1",
      cwd: "/repo",
      instruction: "Prepare release notes",
    });
    const sent = new Headers(init?.headers);
    expect(sent.get("idempotency-key")).toMatch(/^web-v2-/);
    expect(sent.get("content-type")).toBe("application/json");
  });

  it("retries a mutation network failure once with the same idempotency key, body, and a fresh timeout", async () => {
    request
      .mockRejectedValueOnce(new TypeError("network interrupted"))
      .mockResolvedValueOnce(jsonResponse({ automation: { id: "automation-1" } }, 201));

    await expect(
      client.createAutomation({
        name: "Release notes",
        nodeId: "node-1",
        agentRuntimeId: "runtime-1",
        cwd: "/repo",
        instruction: "Prepare release notes",
      }),
    ).resolves.toEqual({ id: "automation-1" });

    expect(request).toHaveBeenCalledTimes(2);
    const first = request.mock.calls[0]?.[1];
    const second = request.mock.calls[1]?.[1];
    expect(new Headers(first?.headers).get("idempotency-key")).toBeTruthy();
    expect(new Headers(second?.headers).get("idempotency-key")).toBe(
      new Headers(first?.headers).get("idempotency-key"),
    );
    expect(second?.body).toBe(first?.body);
    if (typeof AbortSignal.timeout === "function") expect(second?.signal).not.toBe(first?.signal);
  });

  it("does not retry an authoritative HTTP failure", async () => {
    request.mockResolvedValueOnce(jsonResponse({ code: "NODE_OFFLINE", error: "Node is offline" }, 503));

    await expect(
      client.createAutomation({
        name: "Release notes",
        nodeId: "node-1",
        agentRuntimeId: "runtime-1",
        cwd: "/repo",
        instruction: "Prepare release notes",
      }),
    ).rejects.toMatchObject({ status: 503, code: "NODE_OFFLINE" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("runs an automation without a fabricated request body and returns its real session", async () => {
    request.mockResolvedValueOnce(
      jsonResponse({ run: { id: "run-1", sessionId: "session-1" }, session: { id: "session-1" } }, 201),
    );

    await expect(client.runAutomation("release/notes")).resolves.toMatchObject({
      run: { sessionId: "session-1" },
      session: { id: "session-1" },
    });

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://node.example/api/v2/automations/release%2Fnotes/runs");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("idempotency-key")).toMatch(/^web-v2-/);
  });

  it("surfaces stable server codes without losing the HTTP status", async () => {
    request.mockResolvedValueOnce(jsonResponse({ code: "RUNTIME_UNAVAILABLE", error: "Runtime is unavailable" }, 409));

    const error = await client.runAutomation("automation-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProductApiV2Error);
    expect(error).toMatchObject({ status: 409, code: "RUNTIME_UNAVAILABLE", message: "Runtime is unavailable" });
  });
});
