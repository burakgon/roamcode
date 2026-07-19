import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startServer } from "../src/index.js";

let dir: string;
let running: Awaited<ReturnType<typeof startServer>> | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-boot-"));
});

afterEach(async () => {
  if (running) await running.app.close();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

function envFor(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: "0",
    BIND_ADDRESS: "127.0.0.1",
    CLAUDE_BIN: process.execPath,
    CODEX_BIN: process.execPath,
    ROAMCODE_DATA_DIR: dir,
    ...extra,
  };
}

test("first standalone boot generates, persists, and enforces host access", async () => {
  running = await startServer(envFor());
  expect(running.tokenGenerated).toBe(true);
  expect((running.token ?? "").length).toBeGreaterThan(20);
  expect((await readFile(join(dir, "token"), "utf8")).trim()).toBe(running.token);

  expect((await running.app.inject({ method: "GET", url: "/sessions" })).statusCode).toBe(401);
  const headers = { authorization: `Bearer ${running.token}` };
  expect((await running.app.inject({ method: "GET", url: "/sessions", headers })).statusCode).toBe(200);

  const capabilities = await running.app.inject({ method: "GET", url: "/api/v1/capabilities", headers });
  expect(capabilities.statusCode).toBe(200);
  expect(capabilities.json().features).toMatchObject({
    automations: true,
    devicePairing: true,
    directMultiHost: true,
    peerFederation: true,
  });
  expect(JSON.stringify(capabilities.json())).not.toMatch(/cloud|relay/i);

  const health = await running.app.inject({ method: "GET", url: "/health" });
  expect(health.statusCode).toBe(200);
  expect(health.headers["x-roamcode-instance"]).toMatch(/^[a-f0-9-]{36}$/);
  expect(health.headers["cache-control"]).toBe("no-store");
});

test("second standalone boot reuses the persisted host credential", async () => {
  const first = await startServer(envFor());
  const token = first.token;
  await first.app.close();

  running = await startServer(envFor());
  expect(running.tokenGenerated).toBe(false);
  expect(running.token).toBe(token);
});

test("NO_TOKEN=1 remains an isolated loopback development mode", async () => {
  running = await startServer(envFor({ NO_TOKEN: "1" }));
  expect(running.token).toBeUndefined();
  expect(running.tokenGenerated).toBe(false);
  expect((await running.app.inject({ method: "GET", url: "/sessions" })).statusCode).toBe(200);
});

test("obsolete external-service configuration is inert after a standalone-only upgrade", async () => {
  await writeFile(join(dir, "cloud-host.json"), JSON.stringify({ kind: "obsolete", credential: "not-read" }));
  await writeFile(join(dir, "relay-host.json"), JSON.stringify({ kind: "obsolete", credential: "not-read" }));

  running = await startServer(envFor());
  const headers = { authorization: `Bearer ${running.token}` };
  expect((await running.app.inject({ method: "GET", url: "/api/v1/cloud/status", headers })).statusCode).toBe(404);
  expect((await running.app.inject({ method: "GET", url: "/api/v1/relay/status", headers })).statusCode).toBe(404);
});
