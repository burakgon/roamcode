import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { SessionManager, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, ClaudeVersionProbe, ClaudeLatestService } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

function makeServer(over: { probeVersion?: string; latest?: string; withLatest?: boolean } = {}): CreateServerResult {
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
  const manager = new SessionManager(config.claude, {
    spawnPrefixArgs: [MOCK],
    baseEnv: { ...process.env, MOCK_MODE: "simple" },
    startTimeoutMs: 5000,
  });
  const claudeVersionProbe = {
    get: async () => ({ available: true, version: over.probeVersion ?? "2.1.187" }),
  } as unknown as ClaudeVersionProbe;
  const claudeLatest =
    over.withLatest === false
      ? undefined
      : ({ getLatest: async () => over.latest ?? "2.1.195" } as unknown as ClaudeLatestService);
  return createServer(config, manager, { claudeVersionProbe, claudeLatest });
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

test("GET /claude/version returns the installed + latest versions", async () => {
  current = makeServer({ probeVersion: "2.1.187", latest: "2.1.195" });
  const res = await current.app.inject({ method: "GET", url: "/claude/version", headers: auth });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ installed: "2.1.187", latest: "2.1.195" });
});

test("latest is null when no claudeLatest dep is wired", async () => {
  current = makeServer({ withLatest: false });
  const res = await current.app.inject({ method: "GET", url: "/claude/version", headers: auth });
  expect(res.json()).toEqual({ installed: "2.1.187", latest: null });
});

test("/claude/version is token-gated", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "GET", url: "/claude/version" });
  expect(res.statusCode).toBe(401);
});
