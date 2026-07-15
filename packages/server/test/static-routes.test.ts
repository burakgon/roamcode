import { describe, expect, test } from "vitest";
import { isPublicPath, isShellPath, API_PATH_DENYLIST, looksLikeAssetRequest } from "../src/index.js";

describe("API_PATH_DENYLIST mirrors the web apiNavigationDenylist (extended)", () => {
  const matches = (p: string) => API_PATH_DENYLIST.some((re) => re.test(p));
  test("matches the live API / WS / health / push routes", () => {
    expect(matches("/sessions")).toBe(true);
    expect(matches("/sessions/abc/ws")).toBe(true);
    expect(matches("/resumable")).toBe(true);
    expect(matches("/fs/list")).toBe(true);
    expect(matches("/health")).toBe(true);
    expect(matches("/push/vapid")).toBe(true);
    expect(matches("/push/subscribe")).toBe(true);
    expect(matches("/pairing/claim")).toBe(true);
    expect(matches("/devices")).toBe(true);
    // OTA self-update routes are live API — token-gated, never the public shell.
    expect(matches("/version")).toBe(true);
    expect(matches("/update")).toBe(true);
    expect(matches("/update/status")).toBe(true);
    // The authed diagnostics route is live API too — never the public shell.
    expect(matches("/diag")).toBe(true);
    // The authed token-rotation route is server-only, token-gated — never the public shell.
    expect(matches("/token/rotate")).toBe(true);
    // In-app Claude sign-in routes start an OAuth flow + reveal the account — token-gated, never public.
    expect(matches("/auth/status")).toBe(true);
    expect(matches("/auth/login/start")).toBe(true);
    expect(matches("/auth/login/code")).toBe(true);
    // The claude version/update endpoint is live API — token-gated, never the public shell.
    expect(matches("/claude/version")).toBe(true);
    // WS-ticket minting is a credential endpoint — reserved API namespace, never the shell.
    expect(matches("/ws-ticket")).toBe(true);
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

describe("isShellPath (the auth gate's EXPLICIT allowlist — a REGISTERED route is public only via this)", () => {
  test("covers the built PWA shell: root, /assets/*, and every top-level bundle file the dist emits", () => {
    for (const p of [
      "/",
      "/index.html",
      "/sw.js",
      "/manifest.webmanifest",
      "/assets/index-abc123.js",
      "/assets/index-abc123.css",
      "/icon-192.png",
      "/icon-512.svg",
      "/apple-touch-icon.png",
      "/favicon.ico",
    ]) {
      expect(isShellPath(p)).toBe(true);
    }
  });
  test("never covers API shapes: extensionless routes, nested non-asset files, or the API namespace", () => {
    for (const p of [
      "/sessions",
      "/diag",
      "/ws-ticket",
      "/login", // an SPA navigation is public only via the is404 branch, NOT the shell allowlist
      "/foo/bar.png", // nested outside /assets/ — not something the Vite build emits
      "/sessions/abc/terminal",
    ]) {
      expect(isShellPath(p)).toBe(false);
    }
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
    expect(isPublicPath("/resumable")).toBe(false);
    expect(isPublicPath("/fs/list")).toBe(false);
    expect(isPublicPath("/push/subscribe")).toBe(false);
    expect(isPublicPath("/pairing/claim")).toBe(false);
    expect(isPublicPath("/devices")).toBe(false);
    expect(isPublicPath("/health")).toBe(false);
    expect(isPublicPath("/version")).toBe(false);
    expect(isPublicPath("/update")).toBe(false);
    expect(isPublicPath("/update/status")).toBe(false);
    expect(isPublicPath("/token/rotate")).toBe(false);
  });
});

describe("looksLikeAssetRequest", () => {
  test("true for /assets/* and any *.ext path (a missing file must 404, not get the shell)", () => {
    expect(looksLikeAssetRequest("/assets/index-abc123.js")).toBe(true);
    expect(looksLikeAssetRequest("/assets/index-abc123.css")).toBe(true);
    expect(looksLikeAssetRequest("/icon-192.svg")).toBe(true);
    expect(looksLikeAssetRequest("/whatever.js")).toBe(true);
  });
  test("false for extensionless navigation paths (these get the SPA shell)", () => {
    expect(looksLikeAssetRequest("/")).toBe(false);
    expect(looksLikeAssetRequest("/login")).toBe(false);
    expect(looksLikeAssetRequest("/some/client/route")).toBe(false);
  });
});

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { createServer } from "../src/index.js";
import type { CreateServerResult, ServerRuntimeConfig } from "../src/index.js";

let dir: string;
let webDir: string;
let result: CreateServerResult | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-static-"));
  webDir = join(dir, "web");
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>roamcode</title>");
  await writeFile(join(webDir, "assets", "app.js"), "console.log('shell')");
  await writeFile(join(webDir, "sw.js"), "/* service worker */");
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

describe("serving the PWA on the same origin", () => {
  test("the shell + assets load WITHOUT a token; the SPA fallback serves index.html for /login", async () => {
    result = createServer(configFor(), { webDir });
    const root = await result.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("roamcode");
    const asset = await result.app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    const spa = await result.app.inject({ method: "GET", url: "/login" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("roamcode");
  });

  test("sw.js is served no-store (the OTA trigger must never be cached), while hashed assets are not", async () => {
    result = createServer(configFor(), { webDir });
    const sw = await result.app.inject({ method: "GET", url: "/sw.js" });
    expect(sw.statusCode).toBe(200);
    // Must be uncacheable so a CDN/browser can't pin clients to a stale bundle and block OTA updates.
    expect(sw.headers["cache-control"]).toMatch(/no-store/);
    // A normal content-hashed asset is immutable → it must NOT inherit the sw.js no-store override.
    const asset = await result.app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"] ?? "").not.toMatch(/no-store/);
  });

  test("the HTML shell (index.html + SPA fallback) is served no-cache so the browser always revalidates", async () => {
    // The shell references the content-hashed asset filenames; if it's cached, the browser keeps loading
    // an OLD shell that points at OLD assets — a stale bundle that survives an OTA. Force it revalidated.
    result = createServer(configFor(), { webDir });
    const root = await result.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["cache-control"] ?? "").toMatch(/no-cache|no-store/);
    const spa = await result.app.inject({ method: "GET", url: "/login" });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers["cache-control"] ?? "").toMatch(/no-cache|no-store/);
    // A content-hashed asset stays cacheable (immutable) — it must NOT inherit the shell's no-cache.
    const asset = await result.app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"] ?? "").not.toMatch(/no-cache|no-store/);
  });

  test("the API stays token-gated even though the shell is public", async () => {
    result = createServer(configFor(), { webDir });
    const noTok = await result.app.inject({ method: "GET", url: "/sessions" });
    expect(noTok.statusCode).toBe(401);
    const withTok = await result.app.inject({
      method: "GET",
      url: "/sessions",
      headers: { authorization: "Bearer tok" },
    });
    expect(withTok.statusCode).toBe(200);
  });

  test("an unauthenticated unknown protected path 401s (NOT the SPA shell)", async () => {
    result = createServer(configFor(), { webDir });
    const res = await result.app.inject({ method: "GET", url: "/sessions/nope" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("roamcode");
  });

  test("a MISSING static asset 404s instead of serving the HTML shell (no MIME-mismatch blank page / SW cache poisoning)", async () => {
    // Regression: @fastify/static (wildcard:false) only routes files that existed at startup, so a
    // stale/renamed asset reaches the notFound handler. It must 404 — serving index.html (text/html)
    // for a missing `*.js` makes the browser block the module script (blank page) and can poison a
    // service-worker precache (HTML cached as the JS entry).
    result = createServer(configFor(), { webDir });
    const missingJs = await result.app.inject({ method: "GET", url: "/assets/index-DOESNOTEXIST.js" });
    expect(missingJs.statusCode).toBe(404);
    expect(missingJs.body).not.toContain("roamcode");
    const missingCss = await result.app.inject({ method: "GET", url: "/whatever.css" });
    expect(missingCss.statusCode).toBe(404);
    // ...but an extensionless CLIENT route still gets the shell (SPA fallback preserved).
    const clientRoute = await result.app.inject({ method: "GET", url: "/some/client/route" });
    expect(clientRoute.statusCode).toBe(200);
    expect(clientRoute.body).toContain("roamcode");
  });

  test("an unknown API path 404s as JSON (not the SPA shell)", async () => {
    result = createServer(configFor(), { webDir });
    const res = await result.app.inject({
      method: "GET",
      url: "/sessions/nope",
      headers: { authorization: "Bearer tok" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});
