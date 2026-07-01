import { afterEach, expect, test } from "vitest";
import { createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, ClaudeAuthService } from "../src/index.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

function makeServer(claudeAuth?: ClaudeAuthService): CreateServerResult {
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
  return createServer(config, { claudeAuth });
}

/** A fake ClaudeAuthService driving the route logic without spawning real `claude`. */
function fakeAuth(): ClaudeAuthService {
  return {
    status: async () => ({ loggedIn: true, email: "a@b.com", subscriptionType: "max" }),
    startLogin: async () => ({ loginId: "L1", url: "https://claude.com/cai/oauth/authorize?code=true" }),
    submitCode: async (id: string, code: string) => ({ ok: id === "L1" && code === "GOOD" }),
    cancel: () => {},
  } as unknown as ClaudeAuthService;
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

test("with no claudeAuth dep, /auth/status reports unavailable and /auth/login/start is 503", async () => {
  current = makeServer();
  const status = await current.app.inject({ method: "GET", url: "/auth/status", headers: auth });
  expect(status.statusCode).toBe(200);
  expect(status.json()).toEqual({ available: false });
  const start = await current.app.inject({ method: "POST", url: "/auth/login/start", headers: auth });
  expect(start.statusCode).toBe(503);
});

test("the /auth routes are token-gated", async () => {
  current = makeServer(fakeAuth());
  const res = await current.app.inject({ method: "GET", url: "/auth/status" });
  expect(res.statusCode).toBe(401);
});

test("GET /auth/status returns the account; the login start→code flow completes", async () => {
  current = makeServer(fakeAuth());

  const status = await current.app.inject({ method: "GET", url: "/auth/status", headers: auth });
  expect(status.json()).toEqual({ available: true, loggedIn: true, email: "a@b.com", subscriptionType: "max" });

  const start = await current.app.inject({ method: "POST", url: "/auth/login/start", headers: auth });
  expect(start.statusCode).toBe(200);
  expect(start.json()).toEqual({ loginId: "L1", url: "https://claude.com/cai/oauth/authorize?code=true" });

  const ok = await current.app.inject({
    method: "POST",
    url: "/auth/login/code",
    headers: { ...auth, "content-type": "application/json" },
    payload: { loginId: "L1", code: "GOOD" },
  });
  expect(ok.json()).toEqual({ ok: true });

  const bad = await current.app.inject({
    method: "POST",
    url: "/auth/login/code",
    headers: { ...auth, "content-type": "application/json" },
    payload: { loginId: "L1", code: "WRONG" },
  });
  expect(bad.json()).toEqual({ ok: false });
});

test("POST /auth/login/code without loginId+code is a 400", async () => {
  current = makeServer(fakeAuth());
  const res = await current.app.inject({
    method: "POST",
    url: "/auth/login/code",
    headers: { ...auth, "content-type": "application/json" },
    payload: {},
  });
  expect(res.statusCode).toBe(400);
});
