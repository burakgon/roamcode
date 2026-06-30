// packages/server/test/transport.terminal-ws.test.ts
import { expect, test } from "vitest";
import { buildTestServer } from "./helpers/test-server.js";

test("terminal WS streams pty output (binary) and forwards input/resize", async () => {
  const { app, token, fakePty, listen, wsConnect } = await buildTestServer({ terminalAvailable: true });
  await listen();

  const create = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { cwd: process.cwd(), mode: "terminal" },
  });
  expect(create.statusCode).toBe(201);
  const id = create.json().id as string;

  // Connect to the terminal WebSocket using ?token= query param.
  const ws = wsConnect(`/sessions/${id}/terminal?token=${token}`);

  const gotBuffers: Buffer[] = [];

  // Wait for connection to open, then emit pty data.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ws never opened")), 5000);
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
    ws.on("open", () => { clearTimeout(timeout); resolve(); });
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

test("terminal WS returns 4404 for unknown session id", async () => {
  const { app, token, listen, wsConnect } = await buildTestServer({ terminalAvailable: true });
  await listen();

  const closeCode = await new Promise<number>((resolve, reject) => {
    const ws = wsConnect(`/sessions/nonexistent-id/terminal?token=${token}`);
    const timeout = setTimeout(() => reject(new Error("ws never closed")), 5000);
    ws.on("close", (code) => { clearTimeout(timeout); resolve(code); });
    ws.on("error", () => { /* close event will follow */ });
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
    payload: { cwd: process.cwd(), mode: "terminal" },
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
    payload: { cwd: process.cwd(), mode: "terminal" },
  });
  const id = create.json().id as string;

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
    payload: { cwd: process.cwd(), mode: "terminal" },
  });
  const id = create.json().id as string;

  const stop = await app.inject({
    method: "POST",
    url: `/sessions/${id}/stop`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(stop.statusCode).toBe(200);
  expect(stop.json().ok).toBe(true);

  await app.close();
});
