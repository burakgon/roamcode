import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer } from "../src/index.js";
import type { CreateServerResult, ServerRuntimeConfig } from "../src/index.js";

// Regression suite for the percent-encoding auth bypass (Plan 6, Task 1).
//
// The auth preHandler used to gate on the RAW, un-decoded request path, while Fastify's
// find-my-way router routes the percent-DECODED path. The two disagreed, so a single encoded
// character (e.g. `%73` => `s`) made a protected path LOOK public to the gate while still
// reaching the protected handler after the router decoded it:
//   GET /%73essions  -> gate sees "/%73essions" (not in denylist) -> PUBLIC -> token check skipped
//                    -> router decodes to "/sessions" -> protected handler -> 200 UNAUTHENTICATED.
// These tests assert every token-gated route stays 401 when reached via an encoded path with no
// token, and that the public shell stays reachable.

let dir: string;
let webDir: string;
let result: CreateServerResult | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-bypass-"));
  webDir = join(dir, "web");
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>roamcode</title>");
  await writeFile(join(webDir, "assets", "app.js"), "console.log('shell')");
});
afterEach(async () => {
  if (result) await result.app.close();
  result = undefined;
  await rm(dir, { recursive: true, force: true });
});

function configFor(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: "tok",
    fsRoot: dir,
    maxUploadBytes: 26214400,
    dataDir: dir,
    claude: { claudeBin: process.execPath },
  };
}

function makeServer(): CreateServerResult {
  return createServer(configFor(), { webDir });
}

describe("percent-encoded path auth bypass is closed", () => {
  test("GET /%73essions (encoded 's' -> /sessions) is 401, not 200 nor the SPA shell", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/%73essions" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("roamcode");
  });

  test("GET /se%73sions/abc (encoded -> /sessions/:id) is 401", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/se%73sions/abc" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("roamcode");
  });

  test("GET /f%73/list (encoded -> /fs/list arbitrary read) is 401", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/f%73/list" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("roamcode");
  });

  test("an encoded-slash variant (/%2fsessions) never yields a protected 200", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/%2fsessions" });
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  test("an encoded-slash traversal variant (/sessions%2f..%2f) never yields a protected 200", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/sessions%2f..%2f" });
    expect(res.statusCode).not.toBe(200);
  });
});

describe("the public shell stays reachable and authed access still works", () => {
  test("/login, /assets/app.js, / stay public (200)", async () => {
    result = makeServer();
    const login = await result.app.inject({ method: "GET", url: "/login" });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain("roamcode");
    const asset = await result.app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    const root = await result.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
  });

  test("a normal authed GET /sessions still works (200)", async () => {
    result = makeServer();
    const res = await result.app.inject({
      method: "GET",
      url: "/sessions",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("/health is an unauthenticated liveness probe", () => {
  test("GET /health returns 200 { ok: true } with NO token", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  test("GET /health is NOT the SPA shell (it's a real handler, not index.html)", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/health" });
    expect(res.body).not.toContain("roamcode");
  });
});

describe("?token= query is accepted ONLY on media/WS routes (not leaked into logs for API routes)", () => {
  test("GET /sessions?token=tok is 401 — a query token is NOT accepted on an API route", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/sessions?token=tok" });
    expect(res.statusCode).toBe(401);
  });

  test("GET /fs/download?path=...&token=tok passes auth (not 401)", async () => {
    result = makeServer();
    const res = await result.app.inject({
      method: "GET",
      url: `/fs/download?path=${encodeURIComponent(dir)}&token=tok`,
    });
    expect(res.statusCode).not.toBe(401);
  });

  test("the Authorization header still works on API routes (200)", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/sessions", headers: { authorization: "Bearer tok" } });
    expect(res.statusCode).toBe(200);
  });
});
