import { fileURLToPath } from "node:url";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { SessionManager, createServer, openSessionStore, openIdempotencyStore, HistoryService } from "../src/index.js";
import type { CreateServerResult, ServerRuntimeConfig, ServerFrame } from "../src/index.js";
import { encodeProjectDir } from "@remote-coder/protocol";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "int-token";

let dir: string;
let current: CreateServerResult | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-int-"));
});
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
  await rm(dir, { recursive: true, force: true });
});

function configFor(): ServerRuntimeConfig {
  return { port: 0, bindAddress: "127.0.0.1", accessToken: TOKEN, fsRoot: process.cwd(), maxUploadBytes: 26214400, dataDir: dir, claude: { claudeBin: process.execPath } };
}

test("question over WS: create -> ask -> answer frame -> result reflects the choice", async () => {
  const manager = new SessionManager({ claudeBin: process.execPath }, { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "question" }, startTimeoutMs: 5000 });
  current = createServer(configFor(), manager, { store: openSessionStore({ dbPath: join(dir, "s.db") }), idempotency: openIdempotencyStore({ dbPath: join(dir, "i.db") }), history: new HistoryService() });
  const httpUrl = await current.app.listen({ port: 0, host: "127.0.0.1" });
  const wsBase = httpUrl.replace(/^http/, "ws");

  const created = await current.app.inject({ method: "POST", url: "/sessions", headers: { authorization: `Bearer ${TOKEN}` }, payload: { cwd: process.cwd() } });
  const id = created.json().session.id;

  await new Promise<void>((resolve, reject) => {
    let sent = false;
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?token=${TOKEN}`);
    ws.on("message", (raw: Buffer) => {
      const frame: ServerFrame = JSON.parse(raw.toString());
      if (!sent) { sent = true; ws.send(JSON.stringify({ type: "user", content: "ask" })); }
      if (frame.kind === "question") {
        const p = frame.payload as { requestId: string; toolInput: unknown };
        ws.send(JSON.stringify({ type: "answer", requestId: p.requestId, toolInput: p.toolInput, answers: { "Which language?": "Python" } }));
      }
      if (frame.kind === "result") {
        expect((frame.payload as { result?: string }).result).toContain("Python");
        ws.close(); resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("int: no question result")), 10000);
  });
}, 20000);

// The headline durability+interactivity loop, chained end-to-end against the interactive mock:
//   1. create a session (authed, idempotency-keyed)
//   2. send a message + answer an AskUserQuestion over WS (interactivity)
//   3. change a live setting (set_model) over the SAME WS — meta mirrors the change
//   4. simulate a RESTART: close the server, then build a NEW server/manager against the SAME
//      SQLite db + data dir + claudeHome
//   5. the session reappears as DORMANT (rehydrated from the store, no live process)
//   6. a message resumes it (`claude --resume`, mock "resume" mode warm-up suppressed) -> running
//   7. GET /sessions/:id returns the jsonl transcript as history frames
//   8. an idempotent create with the SAME Idempotency-Key returns the SAME session (200)
test("full durability+interactivity loop: create -> ask/answer -> live setting -> restart -> dormant -> resume -> history -> idempotent", async () => {
  const dbPath = join(dir, "sessions.db");
  const idemPath = join(dir, "idem.db");
  const claudeHome = join(dir, "home");
  const sessionCwd = join(dir, "work");
  await mkdir(sessionCwd, { recursive: true });

  const idemKey = "loop-key-1";
  const idemHeaders = { authorization: `Bearer ${TOKEN}`, "idempotency-key": idemKey };

  let id: string;

  // ---- Server 1: interactivity (question + answer + live setting), then close. ----
  {
    const store = openSessionStore({ dbPath });
    const idempotency = openIdempotencyStore({ dbPath: idemPath });
    const manager = new SessionManager({ claudeBin: process.execPath }, { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "question" }, startTimeoutMs: 5000 });
    current = createServer(configFor(), manager, { store, idempotency, history: new HistoryService({ claudeHome }) });
    const httpUrl = await current.app.listen({ port: 0, host: "127.0.0.1" });
    const wsBase = httpUrl.replace(/^http/, "ws");

    const created = await current.app.inject({ method: "POST", url: "/sessions", headers: idemHeaders, payload: { cwd: sessionCwd } });
    expect(created.statusCode).toBe(201);
    id = created.json().session.id as string;

    // Drive the question loop, then change a live setting on the SAME socket.
    await new Promise<void>((resolve, reject) => {
      let sent = false;
      const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?token=${TOKEN}`);
      ws.on("message", (raw: Buffer) => {
        const frame: ServerFrame = JSON.parse(raw.toString());
        if (!sent) { sent = true; ws.send(JSON.stringify({ type: "user", content: "ask" })); }
        if (frame.kind === "question") {
          const p = frame.payload as { requestId: string; toolInput: unknown };
          ws.send(JSON.stringify({ type: "answer", requestId: p.requestId, toolInput: p.toolInput, answers: { "Which language?": "Python" } }));
        }
        if (frame.kind === "result") {
          expect((frame.payload as { result?: string }).result).toContain("Python");
          // Live setting on the active session (the mock acks set_model with ok:true).
          ws.send(JSON.stringify({ type: "settings", model: "claude-live-x" }));
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("loop: no question result")), 10000);
    });

    // The live setting mirrored into the in-memory meta (applySettings persists it too).
    // Give the async settings frame a moment to apply before reading.
    await new Promise((r) => setTimeout(r, 50));
    const meta = await current.app.inject({ method: "GET", url: `/sessions/${id}`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(meta.json().session.model).toBe("claude-live-x");

    await current.app.close();
    store.close();
    idempotency.close();
    current = undefined;
  }

  // Simulate the on-disk transcript Claude would have written for this session (sandboxed claudeHome).
  const projDir = join(claudeHome, ".claude", "projects", encodeProjectDir(sessionCwd));
  await mkdir(projDir, { recursive: true });
  await writeFile(
    join(projDir, `${id}.jsonl`),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "ask" }] } }) + "\n" +
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "You picked Python" }] } }) + "\n",
    "utf8",
  );

  // ---- Server 2 (RESTART): SAME db + idem db + claudeHome. Resume mode for the dormant warm-up. ----
  const store2 = openSessionStore({ dbPath });
  const idempotency2 = openIdempotencyStore({ dbPath: idemPath });
  const manager2 = new SessionManager({ claudeBin: process.execPath }, { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "resume" }, startTimeoutMs: 5000 });
  current = createServer(configFor(), manager2, { store: store2, idempotency: idempotency2, history: new HistoryService({ claudeHome }) });
  const url2 = await current.app.listen({ port: 0, host: "127.0.0.1" });
  const wsBase2 = url2.replace(/^http/, "ws");

  // The rehydrated session is DORMANT (no live process), and its persisted live-setting survived.
  {
    const list = await current.app.inject({ method: "GET", url: "/sessions", headers: { authorization: `Bearer ${TOKEN}` } });
    const sessions = list.json().sessions as { id: string; status: string; model?: string }[];
    expect(sessions).toHaveLength(1);
    const restored = sessions.find((s) => s.id === id);
    expect(restored?.status).toBe("dormant");
    expect(restored?.model).toBe("claude-live-x");
  }

  // A message RESUMES the dormant session (`claude --resume`, warm-up suppressed) -> running.
  await new Promise<void>((resolve, reject) => {
    let sent = false;
    const ws = new WebSocket(`${wsBase2}/sessions/${id}/ws?token=${TOKEN}`);
    ws.on("open", () => { sent = true; ws.send(JSON.stringify({ type: "user", content: "continue please" })); });
    ws.on("message", (raw: Buffer) => {
      const frame: ServerFrame = JSON.parse(raw.toString());
      if (frame.kind === "result") { ws.close(); resolve(); }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error(sent ? "loop: resume no result" : "loop: resume ws never opened")), 12000);
  });

  // The resume flipped the meta to running.
  {
    const list = await current.app.inject({ method: "GET", url: "/sessions", headers: { authorization: `Bearer ${TOKEN}` } });
    const sessions = list.json().sessions as { id: string; status: string }[];
    expect(sessions.find((s) => s.id === id)?.status).toBe("running");
  }

  // GET /sessions/:id projects the on-disk jsonl into history frames (durable transcript).
  // (The resumed live process produced a fresh buffer; the on-disk transcript is read when the
  // buffer is empty. We read via a SEPARATE dormant view to assert the jsonl projection directly.)
  const historyService = new HistoryService({ claudeHome });
  const turns = await historyService.read(sessionCwd, id);
  expect(turns).toHaveLength(2);
  expect(turns.map((t) => t.type)).toEqual(["user", "assistant"]);

  // An idempotent create with the SAME key returns the SAME session (200, not a new 201).
  const repeat = await current.app.inject({ method: "POST", url: "/sessions", headers: idemHeaders, payload: { cwd: sessionCwd } });
  expect(repeat.statusCode).toBe(200);
  expect(repeat.json().session.id).toBe(id);

  // Cleanup the explicit stores opened above (the app's onClose tears down live processes).
  await current.app.close();
  store2.close();
  idempotency2.close();
  current = undefined;
}, 40000);

test("startServer generates + prints a token on a fresh data dir", async () => {
  const env = { BIND_ADDRESS: "127.0.0.1", PORT: "0", REMOTE_CODER_DATA_DIR: dir, CLAUDE_BIN: process.execPath } as NodeJS.ProcessEnv;
  const { startServer } = await import("../src/index.js");
  const started = await startServer(env);
  try {
    expect(started.tokenGenerated).toBe(true);
    expect(typeof started.token).toBe("string");
    expect((started.token as string).length).toBeGreaterThan(20);
    // A second start in the SAME data dir REUSES the persisted token (not regenerated).
    const again = await startServer(env);
    try {
      expect(again.tokenGenerated).toBe(false);
      expect(again.token).toBe(started.token);
    } finally {
      await again.app.close();
    }
  } finally {
    await started.app.close();
  }
});

test("startServer with NO_TOKEN=1 on loopback boots tokenless (no token required)", async () => {
  const env = { BIND_ADDRESS: "127.0.0.1", PORT: "0", REMOTE_CODER_DATA_DIR: dir, NO_TOKEN: "1", CLAUDE_BIN: process.execPath } as NodeJS.ProcessEnv;
  const { startServer } = await import("../src/index.js");
  const started = await startServer(env);
  try {
    expect(started.token).toBeUndefined();
    expect(started.tokenGenerated).toBe(false);
    // A request with NO Authorization header is accepted (the global preHandler allows when no token).
    const res = await started.app.inject({ method: "GET", url: "/sessions" });
    expect(res.statusCode).toBe(200);
  } finally {
    await started.app.close();
  }
});
