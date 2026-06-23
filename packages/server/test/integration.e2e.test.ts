import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { SessionManager, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, ServerFrame } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "e2e-token";

function configFor(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

test("full flow: create -> WS subscribe -> message -> events+result -> permission -> reconnect replay", async () => {
  const config = configFor();
  const manager = new SessionManager(config.claude, {
    spawnPrefixArgs: [MOCK],
    baseEnv: { ...process.env, MOCK_MODE: "permission" },
    startTimeoutMs: 5000,
  });
  current = createServer(config, manager);
  const httpUrl = await current.app.listen({ port: 0, host: "127.0.0.1" });
  const wsBase = httpUrl.replace(/^http/, "ws");

  // 1) Create a session over REST.
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { cwd: process.cwd(), dangerouslySkip: false },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().session.id;

  // 2) Subscribe over WS, send a message, answer the permission, await the result.
  await new Promise<void>((resolve, reject) => {
    let sent = false;
    let answered = false;
    const kinds: string[] = [];
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?token=${TOKEN}`);
    ws.on("message", (raw: Buffer) => {
      const frame: ServerFrame = JSON.parse(raw.toString());
      kinds.push(frame.kind);
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "user", content: "write a file" }));
      }
      if (frame.kind === "permission" && !answered) {
        answered = true;
        const requestId = (frame.payload as { requestId: string }).requestId;
        ws.send(JSON.stringify({ type: "permission", requestId, decision: "allow", reason: "e2e" }));
      }
      if (frame.kind === "result") {
        expect(kinds).toContain("permission");
        expect((frame.payload as { permissionDenials?: unknown[] }).permissionDenials).toEqual([]);
        ws.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("e2e: no result over ws")), 10000);
  });

  // 3) Reconnect: a fresh socket replays the buffered frames (resilience — spec §7/§10).
  await new Promise<void>((resolve, reject) => {
    const replayed: string[] = [];
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?token=${TOKEN}`);
    ws.on("message", (raw: Buffer) => {
      const frame: ServerFrame = JSON.parse(raw.toString());
      replayed.push(frame.kind);
      if (frame.kind === "result") {
        expect(replayed).toContain("permission");
        ws.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("e2e: reconnect did not replay")), 5000);
  });

  // 4) REST history reflects the turn.
  const history = await current.app.inject({
    method: "GET",
    url: `/sessions/${id}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(history.json().history.some((f: ServerFrame) => f.kind === "result")).toBe(true);
}, 20000); // subprocess-driven WS flow; allow headroom over the in-test budgets under full-suite load

test("startServer refuses a non-loopback bind without a token", async () => {
  const { startServer } = await import("../src/index.js");
  await expect(
    startServer({ BIND_ADDRESS: "0.0.0.0", CLAUDE_BIN: process.execPath } as NodeJS.ProcessEnv),
  ).rejects.toThrow(/refusing to start/);
});
