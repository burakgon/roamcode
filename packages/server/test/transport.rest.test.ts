import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { SessionManager, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult } from "../src/index.js";
import { ModelsService } from "../src/models-service.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "test-token";

function makeServer(): CreateServerResult {
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
  return createServer(config, manager);
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

const auth = { authorization: `Bearer ${TOKEN}` };

test("requests without a valid token get 401", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "GET", url: "/sessions" });
  expect(res.statusCode).toBe(401);
});

test("a non-string ?token= (repeated param -> array) is rejected with 401, not 500", async () => {
  current = makeServer();
  // `?token=a&token=b` parses to an array; feeding that to the auth path must not 500.
  const res = await current.app.inject({ method: "GET", url: "/sessions?token=a&token=b" });
  expect(res.statusCode).toBe(401);
});

test("POST /sessions creates a session and GET lists it", async () => {
  current = makeServer();
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd(), model: "opus" },
  });
  expect(created.statusCode).toBe(201);
  const session = created.json().session;
  expect(session.id).toMatch(/[0-9a-f]{8}-/i);
  expect(session.cwd).toBe(process.cwd());
  expect(session.model).toBe("opus");
  expect(session.status).toBe("running");

  const listed = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().sessions.map((s: { id: string }) => s.id)).toContain(session.id);
});

test("GET /sessions/:id returns the session + (empty) history; unknown -> 404", async () => {
  current = makeServer();
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd() },
  });
  const id = created.json().session.id;

  const got = await current.app.inject({ method: "GET", url: `/sessions/${id}`, headers: auth });
  expect(got.statusCode).toBe(200);
  expect(got.json().session.id).toBe(id);
  expect(Array.isArray(got.json().history)).toBe(true);

  const missing = await current.app.inject({ method: "GET", url: "/sessions/does-not-exist", headers: auth });
  expect(missing.statusCode).toBe(404);
});

test("POST /sessions/:id/stop removes a session (stop + delete; transcript untouched)", async () => {
  current = makeServer();
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd() },
  });
  const id = created.json().session.id;
  const stopped = await current.app.inject({ method: "POST", url: `/sessions/${id}/stop`, headers: auth });
  expect(stopped.statusCode).toBe(200);
  expect(stopped.json().ok).toBe(true);

  // Stop now CONVERGES on full removal: the session is gone from both the detail route and the list.
  const after = await current.app.inject({ method: "GET", url: `/sessions/${id}`, headers: auth });
  expect(after.statusCode).toBe(404);
  const list = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(list.json().sessions.map((s: { id: string }) => s.id)).not.toContain(id);
});

test("DELETE /sessions/:id removes a session (204) and is idempotent on an unknown id", async () => {
  current = makeServer();
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd() },
  });
  const id = created.json().session.id;

  const deleted = await current.app.inject({ method: "DELETE", url: `/sessions/${id}`, headers: auth });
  expect(deleted.statusCode).toBe(204);

  const after = await current.app.inject({ method: "GET", url: `/sessions/${id}`, headers: auth });
  expect(after.statusCode).toBe(404);
  const list = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(list.json().sessions.map((s: { id: string }) => s.id)).not.toContain(id);

  // Idempotent: deleting again (now unknown) is still a 204 no-op, not an error.
  const again = await current.app.inject({ method: "DELETE", url: `/sessions/${id}`, headers: auth });
  expect(again.statusCode).toBe(204);
});

test("DELETE /sessions/:id requires a token (401 without auth)", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "DELETE", url: "/sessions/whatever" });
  expect(res.statusCode).toBe(401);
});

test("a created session exposes awaiting:false and a numeric lastActivityAt", async () => {
  current = makeServer();
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd() },
  });
  const session = created.json().session;
  expect(session.awaiting).toBe(false);
  expect(typeof session.lastActivityAt).toBe("number");

  const listed = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  const fromList = listed.json().sessions.find((s: { id: string }) => s.id === session.id);
  expect(fromList.awaiting).toBe(false);
  expect(typeof fromList.lastActivityAt).toBe("number");
});

test("GET /models returns the service's model list", async () => {
  const models = new ModelsService({
    runProbe: async () => [{ value: "opus[1m]", displayName: "Opus" }],
    now: () => 0,
  });
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
  const manager = new SessionManager(config.claude, {
    spawnPrefixArgs: [fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url))],
    baseEnv: { ...process.env, MOCK_MODE: "simple" },
    startTimeoutMs: 5000,
  });
  current = createServer(config, manager, { models });
  const res = await current.app.inject({
    method: "GET",
    url: "/models",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ models: [{ value: "opus[1m]", displayName: "Opus" }] });
});
