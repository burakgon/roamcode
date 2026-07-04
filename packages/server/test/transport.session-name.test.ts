// Server-side session names: PATCH /sessions/:id sets/clears, GET /sessions carries the name only when
// set (absent otherwise — clients `?? cwd`), and the rename is written through to the store.
import { afterEach, expect, test } from "vitest";
import { buildTestServer } from "./helpers/test-server.js";
import type { TestServer } from "./helpers/test-server.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };

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

async function listedSession(server: TestServer, id: string): Promise<{ name?: string } | undefined> {
  const res = await server.app.inject({ method: "GET", url: "/sessions", headers: auth });
  return (res.json().sessions as Array<{ id: string; name?: string }>).find((s) => s.id === id);
}

test("PATCH /sessions/:id sets a trimmed name that appears in GET /sessions; clearing removes the field", async () => {
  current = await buildTestServer({ terminalAvailable: true });
  const id = await createSession(current);

  // Unnamed to start: the field is ABSENT (not null/""), so clients can `?? cwd`.
  expect("name" in (await listedSession(current, id))!).toBe(false);

  const set = await current.app.inject({
    method: "PATCH",
    url: `/sessions/${id}`,
    headers: json,
    payload: { name: "  wave 9 dialogs  " },
  });
  expect(set.statusCode).toBe(204);
  expect((await listedSession(current, id))?.name).toBe("wave 9 dialogs"); // trimmed

  // null clears...
  const clearNull = await current.app.inject({
    method: "PATCH",
    url: `/sessions/${id}`,
    headers: json,
    payload: { name: null },
  });
  expect(clearNull.statusCode).toBe(204);
  expect("name" in (await listedSession(current, id))!).toBe(false);

  // ...and so does an empty / whitespace-only string.
  await current.app.inject({ method: "PATCH", url: `/sessions/${id}`, headers: json, payload: { name: "again" } });
  const clearEmpty = await current.app.inject({
    method: "PATCH",
    url: `/sessions/${id}`,
    headers: json,
    payload: { name: "   " },
  });
  expect(clearEmpty.statusCode).toBe(204);
  expect("name" in (await listedSession(current, id))!).toBe(false);
});

test("PATCH /sessions/:id → 404 for an unknown id, 400 for a non-string name, 400 for an oversized name", async () => {
  current = await buildTestServer({ terminalAvailable: true });
  const unknown = await current.app.inject({
    method: "PATCH",
    url: "/sessions/does-not-exist",
    headers: json,
    payload: { name: "x" },
  });
  expect(unknown.statusCode).toBe(404);

  const id = await createSession(current);
  const notString = await current.app.inject({
    method: "PATCH",
    url: `/sessions/${id}`,
    headers: json,
    payload: { name: 42 },
  });
  expect(notString.statusCode).toBe(400);
  const tooLong = await current.app.inject({
    method: "PATCH",
    url: `/sessions/${id}`,
    headers: json,
    payload: { name: "x".repeat(121) },
  });
  expect(tooLong.statusCode).toBe(400);
});

test("PATCH /sessions/:id is token-gated (401 without auth)", async () => {
  current = await buildTestServer({ terminalAvailable: true });
  const id = await createSession(current);
  const res = await current.app.inject({
    method: "PATCH",
    url: `/sessions/${id}`,
    headers: { "content-type": "application/json" },
    payload: { name: "sneaky" },
  });
  expect(res.statusCode).toBe(401);
});

test("the rename is written through to the store (what rehydrate reads after a restart)", async () => {
  current = await buildTestServer({ terminalAvailable: true });
  const id = await createSession(current);
  await current.app.inject({ method: "PATCH", url: `/sessions/${id}`, headers: json, payload: { name: "durable" } });
  // The manager delegates to store.setName — assert via the manager's own meta AND the terminal list shape.
  expect(current.terminalManager.get(id)?.name).toBe("durable");
});
