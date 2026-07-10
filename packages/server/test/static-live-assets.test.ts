import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult } from "../src/index.js";

// Regression: with @fastify/static `wildcard:false` the asset route list is FROZEN at server startup, so a
// build that lands AFTER the server starts (an OTA's build→restart window) serves a fresh index.html whose
// new content-hashed /assets/* have no route → 404 → the app fails to boot. The notFoundHandler now serves
// such files LIVE from disk (within webDir), closing the window. These tests lock that in.

let dir: string;
let webDir: string;
let result: CreateServerResult | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-live-assets-"));
  webDir = join(dir, "web");
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>roamcode-shell</title>");
  await writeFile(join(webDir, "assets", "index-OLD11111.js"), "console.log('startup asset')");
});
afterEach(async () => {
  if (result) await result.app.close();
  result = undefined;
  await rm(dir, { recursive: true, force: true });
});

function makeServer(): CreateServerResult {
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: "tok",
    fsRoot: dir,
    maxUploadBytes: 26214400,
    dataDir: dir,
    claude: { claudeBin: process.execPath },
  };
  return createServer(config, { webDir });
}

describe("static asset serving survives a build that lands after startup", () => {
  test("an asset written AFTER the server started is still served (live, not a frozen 404)", async () => {
    result = makeServer();
    // Simulate an OTA build landing while this server runs: a brand-new hashed chunk appears on disk.
    await writeFile(join(webDir, "assets", "index-NEW22222.js"), "console.log('post-startup asset')");
    const res = await result.app.inject({ method: "GET", url: "/assets/index-NEW22222.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("post-startup asset");
  });

  test("the startup-globbed asset still serves", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/assets/index-OLD11111.js" });
    expect(res.statusCode).toBe(200);
  });

  test("a genuinely missing asset is a 404, never the HTML shell", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/assets/index-DOESNOTEXIST.js" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("roamcode-shell");
  });

  test("a SPA navigation still falls back to index.html", async () => {
    result = makeServer();
    const res = await result.app.inject({ method: "GET", url: "/some/client/route" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("roamcode-shell");
  });

  test("a path-traversal asset request never escapes webDir", async () => {
    result = makeServer();
    await writeFile(join(dir, "secret.js"), "TOP SECRET");
    // …/assets/../../secret.js resolves outside webDir → must NOT be served.
    const res = await result.app.inject({ method: "GET", url: "/assets/../../secret.js" });
    expect(res.body).not.toContain("TOP SECRET");
  });
});
