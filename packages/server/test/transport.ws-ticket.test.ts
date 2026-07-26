// WS ticket auth end-to-end: POST /ws-ticket mints a single-use credential the terminal WS accepts via
// `?ticket=` (so the LONG-LIVED token stays out of WS URLs / proxy logs); a reused ticket is rejected;
// the legacy `?token=` path still works for old bundles.
import { afterEach, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { buildTestServer } from "./helpers/test-server.js";
import type { TestServer } from "./helpers/test-server.js";
import { WsTicketStore } from "../src/ws-ticket.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

let current: TestServer | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

async function createSession(server: TestServer): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd() },
  });
  expect(created.statusCode).toBe(201);
  return created.json().session.id as string;
}

function opens(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

/** Resolves true when the upgrade is REJECTED (the 401 aborts it → the client sees an error, never open). */
function rejected(ws: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    ws.on("open", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    ws.on("error", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

test("POST /ws-ticket is token-gated and returns { ticket, expiresInMs }", async () => {
  current = await buildTestServer({ terminalAvailable: true });
  const noTok = await current.app.inject({ method: "POST", url: "/ws-ticket" });
  expect(noTok.statusCode).toBe(401);
  const res = await current.app.inject({ method: "POST", url: "/ws-ticket", headers: auth });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { ticket: string; expiresInMs: number };
  expect(body.expiresInMs).toBe(30_000);
  expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43,}$/);
});

test("a ticket connects the terminal WS once; the SAME ticket is rejected on reuse", async () => {
  current = await buildTestServer({ terminalAvailable: true });
  const { app, listen, wsConnect } = current;
  await listen();
  const id = await createSession(current);

  const { ticket } = (await app.inject({ method: "POST", url: "/ws-ticket", headers: auth })).json() as {
    ticket: string;
  };

  const ws1 = wsConnect(`/sessions/${id}/terminal?ticket=${ticket}`);
  await opens(ws1); // first use: accepted (and consumed by this very upgrade)

  const ws2 = wsConnect(`/sessions/${id}/terminal?ticket=${ticket}`);
  expect(await rejected(ws2)).toBe(true); // replayed URL → the spent ticket is worthless

  ws1.close();
});

test("an EXPIRED ticket is rejected at the upgrade (injected clock)", async () => {
  let t = 0;
  const wsTickets = new WsTicketStore({ now: () => t });
  current = await buildTestServer({ terminalAvailable: true, deps: { wsTickets } });
  const { app, listen, wsConnect } = current;
  await listen();
  const id = await createSession(current);

  const { ticket } = (await app.inject({ method: "POST", url: "/ws-ticket", headers: auth })).json() as {
    ticket: string;
  };
  t = 30_001; // past the 30s TTL before the client ever connects
  const ws = wsConnect(`/sessions/${id}/terminal?ticket=${ticket}`);
  expect(await rejected(ws)).toBe(true);
});

test("the legacy ?token= WS auth still works (old bundles keep reconnecting)", async () => {
  current = await buildTestServer({ terminalAvailable: true });
  const { listen, wsConnect } = current;
  await listen();
  const id = await createSession(current);
  const ws = wsConnect(`/sessions/${id}/terminal?token=${TOKEN}`);
  await opens(ws);
  ws.close();
});

test("a garbage ?ticket= does NOT fall back to being treated as a token (still 401 without one)", async () => {
  current = await buildTestServer({ terminalAvailable: true });
  const { listen, wsConnect } = current;
  await listen();
  const id = await createSession(current);
  const ws = wsConnect(`/sessions/${id}/terminal?ticket=not-a-real-ticket`);
  expect(await rejected(ws)).toBe(true);
});
