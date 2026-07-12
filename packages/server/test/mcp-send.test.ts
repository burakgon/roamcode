import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { deliver, createMcpSendServer } from "../src/mcp-send.js";
import type { McpEnv } from "../src/mcp-send.js";

const ENV: McpEnv = {
  RC_BASE_URL: "http://127.0.0.1:4280",
  RC_SESSION_ID: "sess-1",
  RC_TOKEN: "tok-1",
};

const temporaryDirectories: string[] = [];

function tokenFile(content: string, mode = 0o600): string {
  const dataDir = mkdtempSync(join(tmpdir(), "roamcode-mcp-token-"));
  temporaryDirectories.push(dataDir);
  const path = join(dataDir, "token");
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

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

test("deliver reads bearer authorization from a secure regular token file", async () => {
  const path = tokenFile("file-backed-token");
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

  const result = await deliver(
    { RC_BASE_URL: ENV.RC_BASE_URL, RC_SESSION_ID: ENV.RC_SESSION_ID, RC_TOKEN_FILE: path },
    { path: "/root/pic.png", kind: "image" },
    fetchImpl,
  );

  expect(result.isError).toBeFalsy();
  const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer file-backed-token");
});

test("direct RC_TOKEN takes precedence over RC_TOKEN_FILE for Claude compatibility", async () => {
  const path = tokenFile("file-token-must-not-win");
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

  await deliver(
    { ...ENV, RC_TOKEN: "direct-token", RC_TOKEN_FILE: path },
    { path: "/root/pic.png", kind: "image" },
    fetchImpl,
  );

  const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer direct-token");
});

test.each([
  [
    "symlink",
    () => {
      const target = tokenFile("symlink-target");
      const link = join(temporaryDirectories.at(-1)!, "token-link");
      symlinkSync(target, link);
      return link;
    },
  ],
  ["group/world-readable", () => tokenFile("readable-token", 0o644)],
  ["empty", () => tokenFile("")],
  ["control-bearing", () => tokenFile("unsafe\ntoken")],
  ["larger than 4096 bytes", () => tokenFile("x".repeat(4097))],
] as const)("deliver rejects a %s token file without revealing filesystem details", async (_name, createPath) => {
  const path = createPath();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

  const result = await deliver(
    { RC_BASE_URL: ENV.RC_BASE_URL, RC_SESSION_ID: ENV.RC_SESSION_ID, RC_TOKEN_FILE: path },
    { path: "/root/pic.png", kind: "file" },
    fetchImpl,
  );

  expect(result).toEqual({
    content: [
      {
        type: "text",
        text: "Attachment delivery is not configured (RC_BASE_URL / RC_SESSION_ID / RC_TOKEN missing).",
      },
    ],
    isError: true,
  });
  expect(JSON.stringify(result)).not.toContain(path);
  expect(fetchImpl).not.toHaveBeenCalled();
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
