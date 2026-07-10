// DEFAULT-DENY auth: every REGISTERED route is token-gated unless explicitly allowlisted (the static
// shell + /health). The old model was a DENYlist of API path prefixes — a new route anyone forgot to
// list was silently PUBLIC (the gate mistook it for the SPA shell). These tests pin the inversion: a
// probe route that exists nowhere in any list is denied by default, while the shell + /health stay open.
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer } from "../src/index.js";
import type { CreateServerResult, ServerRuntimeConfig } from "../src/index.js";

const TOKEN = "tok";
const auth = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let webDir: string;
let result: CreateServerResult | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-deny-"));
  webDir = join(dir, "web");
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>roamcode</title>");
  await writeFile(join(webDir, "assets", "app.js"), "console.log('shell')");
  await writeFile(join(webDir, "icon-192.svg"), "<svg/>");
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
    accessToken: TOKEN,
    fsRoot: dir,
    maxUploadBytes: 26214400,
    dataDir: dir,
    claude: { claudeBin: process.execPath },
  };
  return createServer(config, { webDir });
}

test("a NEW unlisted route is denied by default (401 without a token, works with one)", async () => {
  result = makeServer();
  // A probe route that appears on NO list anywhere — exactly the "forgot to gate it" scenario. It's
  // extensionless and GET, so under the old not-in-the-denylist model it would have been PUBLIC.
  result.app.get("/probe-unlisted", async () => ({ secret: "leaked?" }));
  result.app.post("/probe-unlisted-post", async () => ({ secret: "leaked?" }));

  const get = await result.app.inject({ method: "GET", url: "/probe-unlisted" });
  expect(get.statusCode).toBe(401);
  expect(get.body).not.toContain("leaked?");
  const post = await result.app.inject({ method: "POST", url: "/probe-unlisted-post" });
  expect(post.statusCode).toBe(401);

  const authed = await result.app.inject({ method: "GET", url: "/probe-unlisted", headers: auth });
  expect(authed.statusCode).toBe(200);
  expect(authed.json()).toEqual({ secret: "leaked?" });
});

test("/health stays open (unauthenticated liveness probe)", async () => {
  result = makeServer();
  const res = await result.app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});

test("the static shell stays open: /, /index.html, /assets/*, top-level icons, and SPA navigations", async () => {
  result = makeServer();
  for (const url of ["/", "/index.html", "/login", "/some/client/route"]) {
    const res = await result.app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("roamcode");
  }
  const asset = await result.app.inject({ method: "GET", url: "/assets/app.js" });
  expect(asset.statusCode).toBe(200);
  const icon = await result.app.inject({ method: "GET", url: "/icon-192.svg" });
  expect(icon.statusCode).toBe(200);
});

test("/ws-ticket is gated (it mints WS credentials — never public)", async () => {
  result = makeServer();
  const res = await result.app.inject({ method: "POST", url: "/ws-ticket" });
  expect(res.statusCode).toBe(401);
});

test("an unauthenticated POST to a shell path is NOT public (only GET/HEAD serve the shell)", async () => {
  result = makeServer();
  const res = await result.app.inject({ method: "POST", url: "/" });
  expect(res.statusCode).toBe(401);
});
