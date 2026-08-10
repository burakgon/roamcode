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

  it("loads Node and runtime resources with header authentication", async () => {
    request
      .mockResolvedValueOnce(jsonResponse({ nodes: [{ id: "node-1" }] }))
      .mockResolvedValueOnce(jsonResponse({ runtimes: [{ id: "runtime-1" }] }));

    await expect(client.listNodes()).resolves.toEqual([{ id: "node-1" }]);
    await expect(client.listNodeRuntimes("node/1")).resolves.toEqual([{ id: "runtime-1" }]);

    expect(request.mock.calls[0]?.[0]).toBe("https://node.example/api/v2/nodes");
    expect(request.mock.calls[1]?.[0]).toBe("https://node.example/api/v2/nodes/node%2F1/runtimes");
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer device-token");
  });

  it("creates a neutral Node terminal with cwd as the only launch input", async () => {
    request.mockResolvedValueOnce(
      jsonResponse({ session: { id: "terminal-1", nodeId: "node-1", launch: { kind: "shell" } } }, 201),
    );

    await client.createNodeSession("node/1", { cwd: "/repo" });

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://node.example/api/v2/nodes/node%2F1/sessions");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ cwd: "/repo" });
    expect(new Headers(init?.headers).get("idempotency-key")).toMatch(/^web-v2-/);
  });

  it("retries a mutation network failure once with the same idempotency key and body", async () => {
    request
      .mockRejectedValueOnce(new TypeError("network interrupted"))
      .mockResolvedValueOnce(jsonResponse({ session: { id: "terminal-1" } }, 201));

    await expect(client.createNodeSession("node-1", { cwd: "/repo" })).resolves.toMatchObject({
      session: { id: "terminal-1" },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const first = request.mock.calls[0]?.[1];
    const second = request.mock.calls[1]?.[1];
    expect(new Headers(second?.headers).get("idempotency-key")).toBe(
      new Headers(first?.headers).get("idempotency-key"),
    );
    expect(second?.body).toBe(first?.body);
  });

  it("surfaces stable server codes without retrying HTTP failures", async () => {
    request.mockResolvedValueOnce(jsonResponse({ code: "NODE_OFFLINE", error: "Node is offline" }, 503));

    const error = await client.createNodeSession("node-1", { cwd: "/repo" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProductApiV2Error);
    expect(error).toMatchObject({ status: 503, code: "NODE_OFFLINE", message: "Node is offline" });
    expect(request).toHaveBeenCalledOnce();
  });
});
