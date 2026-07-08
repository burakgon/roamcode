import { expect, test } from "vitest";
import { deliver, createMcpSendServer } from "../src/mcp-send.js";
import type { McpEnv } from "../src/mcp-send.js";

const ENV: McpEnv = {
  RC_BASE_URL: "http://127.0.0.1:4280",
  RC_SESSION_ID: "sess-1",
  RC_TOKEN: "tok-1",
};

test("deliver POSTs to the attach endpoint with bearer auth + json body and returns a success result", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    captured = { url: String(url), init: init as RequestInit };
    return new Response(JSON.stringify({ ok: true, id: "att-1" }), { status: 200 });
  };

  const result = await deliver(ENV, { path: "/root/pic.png", caption: "look", kind: "image" }, fetchImpl);

  expect(captured?.url).toBe("http://127.0.0.1:4280/sessions/sess-1/attach");
  expect(captured?.init.method).toBe("POST");
  const headers = captured?.init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer tok-1");
  expect(headers["content-type"]).toBe("application/json");
  expect(JSON.parse(captured?.init.body as string)).toEqual({
    path: "/root/pic.png",
    caption: "look",
    kind: "image",
  });

  expect(result.isError).toBeFalsy();
  expect(result.content[0]).toEqual({ type: "text", text: "Sent pic.png to the user." });
});

test("deliver maps a non-ok HTTP response to an error tool-result with the server's message", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ error: "path is outside the allowed root: ../x" }), { status: 403 });

  const result = await deliver(ENV, { path: "../x", kind: "image" }, fetchImpl);

  expect(result.isError).toBe(true);
  expect(result.content[0].type).toBe("text");
  expect(result.content[0].text).toContain("path is outside the allowed root");
});

test("deliver never throws on a network error — it returns an error tool-result", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };

  const result = await deliver(ENV, { path: "/root/pic.png", kind: "file" }, fetchImpl);

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("ECONNREFUSED");
});

test("deliver returns an error result when required env is missing (no crash)", async () => {
  const fetchImpl: typeof fetch = async () => new Response("{}", { status: 200 });
  const result = await deliver({}, { path: "/root/pic.png", kind: "file" }, fetchImpl);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/RC_BASE_URL|RC_SESSION_ID|RC_TOKEN|not configured/i);
});

test("createMcpSendServer registers send_image and send_file", async () => {
  const server = createMcpSendServer(ENV);
  // The SDK exposes registered tools on the internal registry; assert both send tools are present.
  const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  expect(Object.keys(registered).sort()).toEqual(["send_file", "send_image"]);
});
