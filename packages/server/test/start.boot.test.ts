import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startServer } from "../src/index.js";
import type { CreateServerResult } from "../src/index.js";

let dir: string;
let running: (CreateServerResult & { url: string }) | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-boot-"));
});
afterEach(async () => {
  if (running) await running.app.close();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Env that drives startServer against the interactive mock on a sandboxed data dir. */
function envFor(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: "0",
    BIND_ADDRESS: "127.0.0.1",
    CLAUDE_BIN: process.execPath,
    CODEX_BIN: process.execPath,
    ROAMCODE_DATA_DIR: dir,
    ...extra,
  } as NodeJS.ProcessEnv;
}

test("first run on loopback generates + persists + reports a token", async () => {
  running = await startServer(envFor());
  expect(running.tokenGenerated).toBe(true);
  expect(typeof running.token).toBe("string");
  expect((running.token ?? "").length).toBeGreaterThan(20);

  // Persisted to the data dir so the SECOND boot reuses it (not regenerated).
  const persisted = (await readFile(join(dir, "token"), "utf8")).trim();
  expect(persisted).toBe(running.token);

  // The token actually gates: an unauthenticated request is rejected.
  const res = await running.app.inject({ method: "GET", url: "/sessions" });
  expect(res.statusCode).toBe(401);
  const ok = await running.app.inject({
    method: "GET",
    url: "/sessions",
    headers: { authorization: `Bearer ${running.token}` },
  });
  expect(ok.statusCode).toBe(200);

  const health = await running.app.inject({ method: "GET", url: "/health" });
  expect(health.statusCode).toBe(200);
  expect(health.headers["x-roamcode-instance"]).toMatch(/^[a-f0-9-]{36}$/);
  expect(health.headers["cache-control"]).toBe("no-store");
});

test("second boot reuses the persisted token (tokenGenerated false)", async () => {
  const first = await startServer(envFor());
  const token = first.token;
  await first.app.close();

  running = await startServer(envFor());
  expect(running.tokenGenerated).toBe(false);
  expect(running.token).toBe(token);
});

test("NO_TOKEN=1 on loopback boots tokenless (no token required)", async () => {
  running = await startServer(envFor({ NO_TOKEN: "1" }));
  expect(running.token).toBeUndefined();
  expect(running.tokenGenerated).toBe(false);
  // No token configured -> the gate allows.
  const res = await running.app.inject({ method: "GET", url: "/sessions" });
  expect(res.statusCode).toBe(200);
});
