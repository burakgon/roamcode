import { describe, expect, test } from "vitest";
import { isPublicPath, API_PATH_DENYLIST } from "../src/index.js";

describe("API_PATH_DENYLIST mirrors the web apiNavigationDenylist (extended)", () => {
  const matches = (p: string) => API_PATH_DENYLIST.some((re) => re.test(p));
  test("matches the live API / WS / health / push routes", () => {
    expect(matches("/sessions")).toBe(true);
    expect(matches("/sessions/abc/ws")).toBe(true);
    expect(matches("/fs/list")).toBe(true);
    expect(matches("/health")).toBe(true);
    expect(matches("/push/vapid")).toBe(true);
    expect(matches("/push/subscribe")).toBe(true);
  });
  test("does NOT match app shell navigations / static assets", () => {
    expect(matches("/")).toBe(false);
    expect(matches("/index.html")).toBe(false);
    expect(matches("/assets/index-abc123.js")).toBe(false);
    expect(matches("/icon-192.svg")).toBe(false);
    expect(matches("/manifest.webmanifest")).toBe(false);
    expect(matches("/sw.js")).toBe(false);
    expect(matches("/login")).toBe(false);
  });
});

describe("isPublicPath", () => {
  test("the static shell + SPA navigations are public", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isPublicPath("/index.html")).toBe(true);
    expect(isPublicPath("/assets/index-abc123.js")).toBe(true);
    expect(isPublicPath("/icon-512.svg")).toBe(true);
    expect(isPublicPath("/sw.js")).toBe(true);
    expect(isPublicPath("/manifest.webmanifest")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
  });
  test("the API / WS / push-write / health routes are NOT public (token-gated)", () => {
    expect(isPublicPath("/sessions")).toBe(false);
    expect(isPublicPath("/sessions/abc")).toBe(false);
    expect(isPublicPath("/sessions/abc/ws")).toBe(false);
    expect(isPublicPath("/fs/list")).toBe(false);
    expect(isPublicPath("/push/subscribe")).toBe(false);
    expect(isPublicPath("/health")).toBe(false);
  });
});

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { createServer, SessionManager } from "../src/index.js";
import type { CreateServerResult, ServerRuntimeConfig } from "../src/index.js";

let dir: string;
let webDir: string;
let result: CreateServerResult | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-static-"));
  webDir = join(dir, "web");
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>remote-coder</title>");
  await writeFile(join(webDir, "assets", "app.js"), "console.log('shell')");
});
afterEach(async () => {
  if (result) await result.app.close();
  result = undefined;
  await rm(dir, { recursive: true, force: true });
});

function configFor(): ServerRuntimeConfig {
  return {
    port: 0, bindAddress: "127.0.0.1", accessToken: "tok", fsRoot: dir,
    maxUploadBytes: 26214400, dataDir: dir, claude: { claudeBin: process.execPath },
  };
}

describe("serving the PWA on the same origin", () => {
  test("the shell + assets load WITHOUT a token; the SPA fallback serves index.html for /login", async () => {
    result = createServer(configFor(), new SessionManager({ claudeBin: process.execPath }), { webDir });
    const root = await result.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("remote-coder");
    const asset = await result.app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    const spa = await result.app.inject({ method: "GET", url: "/login" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("remote-coder");
  });

  test("the API stays token-gated even though the shell is public", async () => {
    result = createServer(configFor(), new SessionManager({ claudeBin: process.execPath }), { webDir });
    const noTok = await result.app.inject({ method: "GET", url: "/sessions" });
    expect(noTok.statusCode).toBe(401);
    const withTok = await result.app.inject({ method: "GET", url: "/sessions", headers: { authorization: "Bearer tok" } });
    expect(withTok.statusCode).toBe(200);
  });

  test("an unauthenticated unknown protected path 401s (NOT the SPA shell)", async () => {
    result = createServer(configFor(), new SessionManager({ claudeBin: process.execPath }), { webDir });
    const res = await result.app.inject({ method: "GET", url: "/sessions/nope" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("remote-coder");
  });

  test("an unknown API path 404s as JSON (not the SPA shell)", async () => {
    result = createServer(configFor(), new SessionManager({ claudeBin: process.execPath }), { webDir });
    const res = await result.app.inject({ method: "GET", url: "/sessions/nope", headers: { authorization: "Bearer tok" } });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});
