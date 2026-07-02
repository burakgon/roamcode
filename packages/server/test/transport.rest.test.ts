import { afterEach, expect, test } from "vitest";
import { buildTestServer } from "./helpers/test-server.js";
import type { TestServer } from "./helpers/test-server.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

let current: TestServer | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

async function makeServer(): Promise<TestServer> {
  return buildTestServer({ terminalAvailable: true });
}

test("requests without a valid token get 401", async () => {
  current = await makeServer();
  const res = await current.app.inject({ method: "GET", url: "/sessions" });
  expect(res.statusCode).toBe(401);
});

test("a non-string ?token= (repeated param -> array) is rejected with 401, not 500", async () => {
  current = await makeServer();
  // `?token=a&token=b` parses to an array; feeding that to the auth path must not 500.
  const res = await current.app.inject({ method: "GET", url: "/sessions?token=a&token=b" });
  expect(res.statusCode).toBe(401);
});

test("POST /sessions creates a terminal session and GET lists it", async () => {
  current = await makeServer();
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
  expect(session.mode).toBe("terminal");
  expect(session.status).toBe("running");

  const listed = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().sessions.map((s: { id: string }) => s.id)).toContain(session.id);
});

test("POST /sessions without a cwd is a 400", async () => {
  current = await makeServer();
  const res = await current.app.inject({ method: "POST", url: "/sessions", headers: auth, payload: {} });
  expect(res.statusCode).toBe(400);
});

test("POST /sessions derives dangerouslySkip from the flag; GET /sessions returns it per session", async () => {
  current = await makeServer();
  const skip = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd(), dangerouslySkip: true },
  });
  expect(skip.statusCode).toBe(201);
  expect(skip.json().session.dangerouslySkip).toBe(true);

  const normal = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd() },
  });
  expect(normal.json().session.dangerouslySkip).toBe(false);

  const listed = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  const byId = new Map<string, boolean>(
    listed.json().sessions.map((s: { id: string; dangerouslySkip: boolean }) => [s.id, s.dangerouslySkip]),
  );
  expect(byId.get(skip.json().session.id)).toBe(true);
  expect(byId.get(normal.json().session.id)).toBe(false);
});

test("POST /sessions/:id/stop removes a session (stop + delete)", async () => {
  current = await makeServer();
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

  const list = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(list.json().sessions.map((s: { id: string }) => s.id)).not.toContain(id);
});

test("POST /sessions/:id/stop on an unknown id is a 404", async () => {
  current = await makeServer();
  const res = await current.app.inject({ method: "POST", url: "/sessions/does-not-exist/stop", headers: auth });
  expect(res.statusCode).toBe(404);
});

test("DELETE /sessions/:id removes a session (204) and is idempotent on an unknown id", async () => {
  current = await makeServer();
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd() },
  });
  const id = created.json().session.id;

  const deleted = await current.app.inject({ method: "DELETE", url: `/sessions/${id}`, headers: auth });
  expect(deleted.statusCode).toBe(204);

  const list = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(list.json().sessions.map((s: { id: string }) => s.id)).not.toContain(id);

  // Idempotent: deleting again (now unknown) is still a 204 no-op, not an error.
  const again = await current.app.inject({ method: "DELETE", url: `/sessions/${id}`, headers: auth });
  expect(again.statusCode).toBe(204);
});

test("DELETE /sessions/:id requires a token (401 without auth)", async () => {
  current = await makeServer();
  const res = await current.app.inject({ method: "DELETE", url: "/sessions/whatever" });
  expect(res.statusCode).toBe(401);
});
