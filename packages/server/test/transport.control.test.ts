import { afterEach, describe, expect, test } from "vitest";
import {
  createServer,
  openCommandCenterStore,
  openIdempotencyStore,
  type CreateServerResult,
  type ServerRuntimeConfig,
} from "../src/index.js";

const TOKEN = "host-token";
let result: CreateServerResult | undefined;

afterEach(async () => {
  await result?.app.close();
  result = undefined;
});

function config(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    dataDir: process.cwd(),
    maxUploadBytes: 1024,
    rateLimitRpm: 0,
    rateLimitBurst: 120,
    maxSessions: 25,
    codexBin: process.execPath,
    claude: { claudeBin: process.execPath },
  };
}

function makeServer(): CreateServerResult {
  return createServer(config(), {
    terminalAvailable: false,
    idempotencyStore: openIdempotencyStore({ dbPath: ":memory:" }),
    commandStore: openCommandCenterStore({
      dbPath: ":memory:",
      generateHostId: () => "host-1",
      generateWorkspaceId: () => "workspace-1",
    }),
  });
}

describe("versioned mutation idempotency", () => {
  test("replays an identical mutation for one actor and rejects key reuse with another payload", async () => {
    result = makeServer();
    const request = (label: string) =>
      result!.app.inject({
        method: "PATCH",
        url: "/api/v1/host",
        headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "rename-host-1" },
        payload: { label },
      });

    const first = await request("Studio");
    expect(first.statusCode).toBe(200);
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    const replay = await request("Studio");
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());

    const conflict = await request("Different studio");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("rejects malformed keys and leaves removed experimental APIs unavailable", async () => {
    result = makeServer();
    const malformed = await result.app.inject({
      method: "PATCH",
      url: "/api/v1/host",
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "spaces are not accepted" },
      payload: { label: "Studio" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe("INVALID_IDEMPOTENCY_KEY");

    for (const url of [
      "/api/v1/attention",
      "/api/v1/audit",
      "/api/v1/team",
      "/api/v1/policy",
      "/api/v1/fleet",
      "/api/v1/peers",
      "/api/v1/extensions",
      "/api/v1/plugins",
    ]) {
      const response = await result.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });
      expect(response.statusCode, url).toBe(404);
    }
  });
});
