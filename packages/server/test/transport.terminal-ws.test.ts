// packages/server/test/transport.terminal-ws.test.ts
import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { TerminalManager } from "../src/terminal-manager.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { openSessionStore } from "../src/session-store.js";
import type { AgentProvider } from "../src/providers/types.js";
import { buildTestServer } from "./helpers/test-server.js";
import {
  CodexThreadResolver,
  resetCodexThreadResolutionCoordinatorForTests,
} from "../src/providers/codex-thread-resolver.js";

function delayedCodexManager() {
  let releaseBuild!: () => void;
  let markBuildStarted!: () => void;
  const buildGate = new Promise<void>((resolve) => (releaseBuild = resolve));
  const buildStarted = new Promise<void>((resolve) => (markBuildStarted = resolve));
  const cleanupCalls: string[][] = [];
  const ptys: Array<EventEmitter & { writes: string[] }> = [];
  const provider: AgentProvider = {
    id: "codex",
    displayName: "Codex",
    resumeIdentity: "required",
    probe: () => Promise.resolve({ terminalAvailable: true, metadataAvailable: true }),
    buildProcess: async () => {
      markBuildStarted();
      await buildGate;
      return {
        executable: "/bin/codex",
        args: [],
        env: {},
        cleanupPaths: ["/tmp/pending-ws-token-bearing"],
      };
    },
    runtimeSignals: () => [],
    classifyPane: () => "idle",
    cleanup: (paths) => cleanupCalls.push([...paths]),
  };
  const manager = new TerminalManager({
    store: openSessionStore({ dbPath: ":memory:" }),
    providers: new ProviderRegistry([provider]),
    now: () => 1,
    ptySpawn: (() => {
      const pty = new EventEmitter() as EventEmitter & {
        writes: string[];
        write(data: string): void;
        resize(): void;
        kill(): void;
        onData(cb: (data: string) => void): void;
        onExit(cb: (event: { exitCode: number }) => void): void;
      };
      pty.writes = [];
      pty.write = (data) => pty.writes.push(data);
      pty.resize = () => {};
      pty.kill = () => {};
      pty.onData = (cb) => void pty.on("data", cb);
      pty.onExit = (cb) => void pty.on("exit", cb);
      ptys.push(pty);
      return pty;
    }) as never,
    runTmux: () => {},
  });
  return { manager, buildStarted, releaseBuild, cleanupCalls, ptys };
}

async function openWs(ws: import("ws").WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ws never opened")), 5000);
    ws.on("error", reject);
    ws.on("open", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

interface InputLeaseFrame {
  t: "input-lease";
  writable: boolean;
  owner: { actorType: string; label: string } | null;
  revision: number;
  reason?: string;
}

function collectInputLeaseFrames(ws: import("ws").WebSocket): InputLeaseFrame[] {
  const frames: InputLeaseFrame[] = [];
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    try {
      const value = JSON.parse(raw.toString()) as Partial<InputLeaseFrame>;
      if (value.t === "input-lease" && typeof value.writable === "boolean") frames.push(value as InputLeaseFrame);
    } catch {
      /* unrelated provider control frame */
    }
  });
  return frames;
}

test("terminal WS enforces one writer, explicit takeover, observer sizing, and release on disconnect", async () => {
  const { app, token, fakePty, listen, wsConnect } = await buildTestServer({ terminalAvailable: true });
  await listen();
  const create = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });
  const id = create.json().session.id as string;

  const writer = wsConnect(`/sessions/${id}/terminal?token=${token}&cols=91&rows=31`);
  const writerLeases = collectInputLeaseFrames(writer);
  await openWs(writer);
  await expect.poll(() => writerLeases.some((frame) => frame.writable)).toBe(true);
  await expect.poll(() => fakePty.argsFor(id).length).toBeGreaterThan(0);

  const observer = wsConnect(`/sessions/${id}/terminal?token=${token}&cols=149&rows=49`);
  const observerLeases = collectInputLeaseFrames(observer);
  await openWs(observer);
  await expect.poll(() => observerLeases.some((frame) => !frame.writable && frame.owner !== null)).toBe(true);

  writer.send(JSON.stringify({ t: "i", d: "writer-only" }));
  observer.send(JSON.stringify({ t: "i", d: "observer-blocked" }));
  observer.send(JSON.stringify({ t: "r", c: 149, r: 49 }));
  await expect.poll(() => fakePty.writesFor(id)).toContain("writer-only");
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(fakePty.writesFor(id)).not.toContain("observer-blocked");
  expect(fakePty.resizesFor(id)).not.toContainEqual([149, 49]);

  observer.send(JSON.stringify({ t: "lease", action: "takeover" }));
  await expect.poll(() => observerLeases.some((frame) => frame.reason === "confirm takeover")).toBe(true);
  observer.send(JSON.stringify({ t: "i", d: "still-blocked" }));
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(fakePty.writesFor(id)).not.toContain("still-blocked");

  observer.send(JSON.stringify({ t: "lease", action: "takeover", confirm: true }));
  await expect.poll(() => observerLeases.at(-1)?.writable).toBe(true);
  await expect.poll(() => writerLeases.at(-1)?.writable).toBe(false);
  writer.send(JSON.stringify({ t: "i", d: "old-writer-blocked" }));
  observer.send(JSON.stringify({ t: "i", d: "new-writer" }));
  observer.send(JSON.stringify({ t: "r", c: 132, r: 42 }));
  await expect.poll(() => fakePty.writesFor(id)).toContain("new-writer");
  await expect.poll(() => fakePty.resizesFor(id)).toContainEqual([132, 42]);
  expect(fakePty.writesFor(id)).not.toContain("old-writer-blocked");

  const observerClosed = new Promise<void>((resolve) => observer.once("close", () => resolve()));
  observer.close();
  await observerClosed;
  await expect.poll(() => writerLeases.at(-1)?.owner).toBeNull();
  writer.send(JSON.stringify({ t: "lease", action: "acquire" }));
  await expect.poll(() => writerLeases.at(-1)?.writable).toBe(true);
  writer.send(JSON.stringify({ t: "i", d: "reacquired" }));
  await expect.poll(() => fakePty.writesFor(id)).toContain("reacquired");

  writer.close();
  await app.close();
});

test("terminal WS buffers early input during delayed attach and replays it in order", async () => {
  const delayed = delayedCodexManager();
  const { app, token, listen, wsConnect } = await buildTestServer({
    terminalAvailable: true,
    deps: { terminalManager: delayed.manager },
  });
  delayed.manager.create({ id: "pending", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await listen();
  const ws = wsConnect(`/sessions/pending/terminal?token=${token}`);
  await openWs(ws);
  await delayed.buildStarted;

  ws.send(JSON.stringify({ t: "i", d: "first" }));
  ws.send(JSON.stringify({ t: "i", d: "second" }));
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  delayed.releaseBuild();

  await expect.poll(() => delayed.ptys[0]?.writes).toEqual(["first", "second"]);
  ws.close();
  await app.close();
});

test("terminal WS close before delayed attach cancels spawn and cleans provider artifacts once", async () => {
  const delayed = delayedCodexManager();
  const { app, token, listen, wsConnect } = await buildTestServer({
    terminalAvailable: true,
    deps: { terminalManager: delayed.manager },
  });
  delayed.manager.create({ id: "closing", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await listen();
  const ws = wsConnect(`/sessions/closing/terminal?token=${token}`);
  await openWs(ws);
  await delayed.buildStarted;

  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  ws.close();
  await closed;
  await expect.poll(() => delayed.manager.isAttached("closing")).toBe(false);
  delayed.releaseBuild();

  await expect.poll(() => delayed.cleanupCalls).toEqual([["/tmp/pending-ws-token-bearing"]]);
  expect(delayed.ptys).toHaveLength(0);
  expect(delayed.manager.get("closing")).toBeDefined();
  await app.close();
});

test("terminal WS fails closed when pending frame count exceeds its bound", async () => {
  const delayed = delayedCodexManager();
  const { app, token, listen, wsConnect } = await buildTestServer({
    terminalAvailable: true,
    deps: { terminalManager: delayed.manager },
  });
  delayed.manager.create({ id: "overflow-count", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await listen();
  const ws = wsConnect(`/sessions/overflow-count/terminal?token=${token}`);
  await openWs(ws);
  await delayed.buildStarted;
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));

  for (let index = 0; index < 65; index += 1) ws.send(JSON.stringify({ t: "i", d: String(index) }));
  const code = await Promise.race([closed, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 300))]);
  delayed.releaseBuild();

  expect(code).toBe(4400);
  await app.close();
});

test("terminal WS fails closed when pending frame bytes exceed their bound", async () => {
  const delayed = delayedCodexManager();
  const { app, token, listen, wsConnect } = await buildTestServer({
    terminalAvailable: true,
    deps: { terminalManager: delayed.manager },
  });
  delayed.manager.create({ id: "overflow-bytes", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await listen();
  const ws = wsConnect(`/sessions/overflow-bytes/terminal?token=${token}`);
  await openWs(ws);
  await delayed.buildStarted;
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));

  const large = JSON.stringify({ t: "i", d: "x".repeat(600_000) });
  ws.send(large);
  ws.send(large);
  const code = await Promise.race([closed, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 300))]);
  delayed.releaseBuild();

  expect(code).toBe(4400);
  await app.close();
});

test("terminal WS streams pty output (binary) and forwards input/resize", async () => {
  const { app, token, fakePty, listen, wsConnect } = await buildTestServer({ terminalAvailable: true });
  await listen();

  const create = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });
  expect(create.statusCode).toBe(201);
  const id = create.json().session.id as string;

  // Connect to the terminal WebSocket using ?token= query param.
  const ws = wsConnect(`/sessions/${id}/terminal?token=${token}`);

  const gotBuffers: Buffer[] = [];

  // Wait for connection to open, then emit pty data.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ws never opened")), 5000);
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    ws.on("open", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // Register message listener before emitting to avoid race.
  const firstMessage = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("no binary message received")), 5000);
    ws.on("message", (data: Buffer) => {
      gotBuffers.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      clearTimeout(timeout);
      resolve();
    });
  });

  // Emit pty output from the fake pty for this session.
  fakePty.lastForId(id).emit("data", "screen-redraw");

  await firstMessage;

  expect(Buffer.concat(gotBuffers).toString()).toContain("screen-redraw");

  // Send input and resize messages to the server.
  ws.send(JSON.stringify({ t: "i", d: "ls\n" }));
  ws.send(JSON.stringify({ t: "r", c: 120, r: 40 }));

  // Give the server a moment to process the messages.
  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  expect(fakePty.writesFor(id)).toContain("ls\n");
  expect(fakePty.resizesFor(id)).toContainEqual([120, 40]);

  ws.close();
  await app.close();
});

test("POST /sessions {dangerouslySkip:true} spawns claude with --dangerously-skip-permissions", async () => {
  const { app, token, fakePty, listen, wsConnect } = await buildTestServer({ terminalAvailable: true });
  await listen();

  const create = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal", dangerouslySkip: true },
  });
  expect(create.statusCode).toBe(201);
  const id = create.json().session.id as string;

  // The pty (and thus the tmux argv) is built lazily on first attach — connect to trigger the spawn.
  const ws = wsConnect(`/sessions/${id}/terminal?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ws never opened")), 5000);
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    ws.on("open", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  expect(fakePty.argsFor(id)).toContain("--dangerously-skip-permissions");

  ws.close();
  await app.close();
});

test("WS ?respawn=continue: an ENDED session's respawn passes --continue to the spawn; a plain respawn doesn't", async () => {
  const { app, token, fakePty, listen, wsConnect } = await buildTestServer({ terminalAvailable: true });
  await listen();

  const create = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });
  const id = create.json().session.id as string;

  const open = (path: string) =>
    new Promise<import("ws").WebSocket>((resolve, reject) => {
      const ws = wsConnect(path);
      const timeout = setTimeout(() => reject(new Error("ws never opened")), 5000);
      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      ws.on("open", () => {
        clearTimeout(timeout);
        resolve(ws);
      });
    });
  const closed = (ws: import("ws").WebSocket) =>
    new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));

  // First connect spawns the pty; the query param must be IGNORED (the session is running, not ended).
  const ws1 = await open(`/sessions/${id}/terminal?token=${token}&respawn=continue`);
  expect(fakePty.argsFor(id)).not.toContain("--continue");

  // claude exits → the server closes with 4410 and the session is ENDED.
  const ws1Closed = closed(ws1);
  fakePty.lastForId(id).emit("exit", { exitCode: 0 });
  expect(await ws1Closed).toBe(4410);

  // Respawn WITH continue → the fresh spawn's argv carries --continue exactly once.
  const ws2 = await open(`/sessions/${id}/terminal?token=${token}&respawn=continue`);
  expect(fakePty.argsFor(id).filter((a) => a === "--continue")).toHaveLength(1);
  const ws2Closed = closed(ws2);
  fakePty.lastForId(id).emit("exit", { exitCode: 0 });
  await ws2Closed;

  // A PLAIN respawn (no param) → today's behavior, no --continue (the stored args were never mutated).
  const ws3 = await open(`/sessions/${id}/terminal?token=${token}`);
  expect(fakePty.argsFor(id)).not.toContain("--continue");

  ws3.close();
  await app.close();
});

test("terminal WS returns 4404 for unknown session id", async () => {
  const { app, token, listen, wsConnect } = await buildTestServer({ terminalAvailable: true });
  await listen();

  const closeCode = await new Promise<number>((resolve, reject) => {
    const ws = wsConnect(`/sessions/nonexistent-id/terminal?token=${token}`);
    const timeout = setTimeout(() => reject(new Error("ws never closed")), 5000);
    ws.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    ws.on("error", () => {
      /* close event will follow */
    });
  });

  expect(closeCode).toBe(4404);
  await app.close();
});

test("GET /sessions includes terminal sessions with mode:'terminal'", async () => {
  const { app, token } = await buildTestServer({ terminalAvailable: true });

  // Create a terminal session.
  await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });

  const res = await app.inject({
    method: "GET",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const { sessions } = res.json() as { sessions: { mode: string }[] };
  expect(sessions.some((s) => s.mode === "terminal")).toBe(true);

  await app.close();
});

test("DELETE /sessions/:id stops a terminal session without touching the chat hub", async () => {
  const { app, token } = await buildTestServer({ terminalAvailable: true });

  const create = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });
  const id = create.json().session.id as string;

  const del = await app.inject({
    method: "DELETE",
    url: `/sessions/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(del.statusCode).toBe(204);

  // The terminal session should no longer appear in the list.
  const list = await app.inject({
    method: "GET",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
  });
  const { sessions } = list.json() as { sessions: { id: string }[] };
  expect(sessions.find((s) => s.id === id)).toBeUndefined();

  await app.close();
});

test("POST /sessions/:id/stop stops a terminal session", async () => {
  const { app, token } = await buildTestServer({ terminalAvailable: true });

  const create = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });
  const id = create.json().session.id as string;

  const stop = await app.inject({
    method: "POST",
    url: `/sessions/${id}/stop`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(stop.statusCode).toBe(200);
  expect(stop.json().ok).toBe(true);

  await app.close();
});

test("Codex metadata discovery failure keeps the terminal usable and disables future resume", async () => {
  const resolver = new CodexThreadResolver({
    inventory: async () => {
      throw new Error("raw app-server frame with token");
    },
  });
  const { app, token, fakePty, listen, wsConnect } = await buildTestServer({
    terminalAvailable: true,
    deps: { codexThreadResolver: () => resolver },
  });
  await listen();
  const create = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: "codex", cwd: process.cwd(), options: { sandbox: "workspace-write" } },
  });
  expect(create.statusCode).toBe(201);
  const id = create.json().session.id as string;
  const ws = wsConnect(`/sessions/${id}/terminal?token=${token}`);
  await openWs(ws);

  await expect.poll(() => fakePty.argsFor(id).length).toBeGreaterThan(0);
  const listed = await app.inject({
    method: "GET",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(listed.json().sessions[0]).toMatchObject({
    provider: "codex",
    identityState: "ambiguous",
  });
  expect(JSON.stringify(listed.json())).not.toContain("token");
  expect(fakePty.argsFor(id)).not.toContain("--last");

  ws.close();
  await app.close();
  resetCodexThreadResolutionCoordinatorForTests();
});

test("a committed Codex identity resumes exactly without app-server and never uses --last", async () => {
  const createdAt = 10_000;
  let inventoryRead = 0;
  const resolver = new CodexThreadResolver({
    now: () => createdAt,
    inventory: async () => {
      inventoryRead += 1;
      if (inventoryRead === 1) return [];
      return [{ id: "thread-exact", cwd: process.cwd(), source: "cli" as const, createdAt: createdAt / 1_000 }];
    },
  });
  const { app, token, fakePty, listen, wsConnect } = await buildTestServer({
    terminalAvailable: true,
    deps: { codexThreadResolver: () => resolver },
  });
  await listen();
  const create = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: "codex", cwd: process.cwd(), options: {} },
  });
  const id = create.json().session.id as string;
  const first = wsConnect(`/sessions/${id}/terminal?token=${token}`);
  await openWs(first);
  await expect
    .poll(async () => {
      const listed = await app.inject({
        method: "GET",
        url: "/sessions",
        headers: { authorization: `Bearer ${token}` },
      });
      return listed.json().sessions[0]?.identityState;
    })
    .toBe("exact");

  const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
  fakePty.lastForId(id).emit("exit", { exitCode: 0 });
  await firstClosed;

  const resumed = wsConnect(`/sessions/${id}/terminal?token=${token}&respawn=continue`);
  await openWs(resumed);
  await expect.poll(() => fakePty.argsFor(id)).toContain("thread-exact");
  expect(fakePty.argsFor(id)).toContain("resume");
  expect(fakePty.argsFor(id)).not.toContain("--last");

  resumed.close();
  await app.close();
});
