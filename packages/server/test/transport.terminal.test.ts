// packages/server/test/transport.terminal.test.ts
import { expect, test } from "vitest";
import { buildTestServer } from "./helpers/test-server.js";

test("POST /sessions {mode:'terminal'} creates a terminal session", async () => {
  const { app, token } = await buildTestServer({ terminalAvailable: true });
  const res = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      provider: "claude",
      cwd: process.cwd(),
      mode: "terminal",
      options: { model: "sonnet", effort: "high", permissionMode: "plan", addDirs: [process.cwd()] },
    },
  });
  expect(res.statusCode).toBe(201);
  // Must mirror the chat-create contract: the session is under `.session` (the web client reads
  // `created.session`), with mode:"terminal" so the client routes to the TerminalView.
  expect(res.json().session.mode).toBe("terminal");
  expect(typeof res.json().session.id).toBe("string");
  expect(res.json().rememberedSessionOptions).toMatchObject({
    defaults: {
      provider: "claude",
      effort: "high",
      model: "sonnet",
      dangerouslySkip: false,
      permissionMode: "plan",
      addDirs: [process.cwd()],
    },
    revision: 1,
  });
  const remembered = await app.inject({
    method: "GET",
    url: "/settings/session-defaults",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(remembered.json()).toEqual(res.json().rememberedSessionOptions);
  await app.close();
});

test("terminal create with no cwd is a 400", async () => {
  const { app, token } = await buildTestServer({ terminalAvailable: true });
  const res = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { mode: "terminal" },
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("terminal create is rejected when unsupported", async () => {
  const { app, token } = await buildTestServer({ terminalAvailable: false });
  const res = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("GET /version reports terminalAvailable", async () => {
  const { app, token } = await buildTestServer({ terminalAvailable: true });
  const res = await app.inject({ method: "GET", url: "/version", headers: { authorization: `Bearer ${token}` } });
  expect(res.json().terminalAvailable).toBe(true);
  await app.close();
});
