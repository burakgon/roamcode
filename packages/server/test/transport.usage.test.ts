import { afterEach, expect, test, vi } from "vitest";
import { UsageService, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, UsageInfo } from "../src/index.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

function baseConfig(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    dataDir: "/data",
    claude: { claudeBin: process.execPath },
  };
}

/** Build a server with an injected UsageService whose getUsage resolves the given value (no real spawn). */
function makeServer(usageValue: UsageInfo | null): CreateServerResult {
  const config = baseConfig();
  const usage = new UsageService({ runUsage: async () => "", now: () => 0 });
  vi.spyOn(usage, "getUsage").mockResolvedValue(usageValue);
  return createServer(config, { usage });
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
  vi.restoreAllMocks();
});

test("GET /usage is token-gated (401 without a token)", async () => {
  current = makeServer(null);
  const res = await current.app.inject({ method: "GET", url: "/usage" });
  expect(res.statusCode).toBe(401);
});

test("GET /usage returns { usage } with a token", async () => {
  const info: UsageInfo = {
    session: { percent: 12, resets: "Jun 25 at 11:30pm (Europe/Istanbul)" },
    week: { percent: 72, resets: "Jun 25 at 10pm (Europe/Istanbul)" },
    fetchedAt: 1000,
  };
  current = makeServer(info);
  const res = await current.app.inject({ method: "GET", url: "/usage", headers: auth });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ usage: info });
});

test("GET /usage returns { usage: null } when the service has no data (feature unavailable)", async () => {
  current = makeServer(null);
  const res = await current.app.inject({ method: "GET", url: "/usage", headers: auth });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ usage: null });
});

test("GET /usage returns { usage: null } when no UsageService is wired", async () => {
  const config = baseConfig();
  current = createServer(config, {}); // no usage dep
  const res = await current.app.inject({ method: "GET", url: "/usage", headers: auth });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ usage: null });
});
