import { expect, test } from "vitest";
import { openDeviceStore } from "../src/device-store.js";
import { buildTestServer } from "./helpers/test-server.js";

async function openWs(ws: import("ws").WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ws never opened")), 5_000);
    ws.once("error", reject);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function createAttachedSession(server: Awaited<ReturnType<typeof buildTestServer>>): Promise<{
  id: string;
  socket: import("ws").WebSocket;
}> {
  const created = await server.app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${server.token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });
  const id = created.json().session.id as string;
  const socket = server.wsConnect(`/sessions/${id}/terminal?token=${server.token}`);
  await openWs(socket);
  await expect.poll(() => server.fakePty.argsFor(id).length).toBeGreaterThan(0);
  return { id, socket };
}

test("versioned API requires a bound lease and supports explicit automation takeover", async () => {
  const server = await buildTestServer({ terminalAvailable: true });
  await server.listen();
  const { id, socket } = await createAttachedSession(server);

  const acquired = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input-lease`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { action: "takeover", clientId: "automation-a", confirm: true },
  });
  expect(acquired.statusCode).toBe(201);
  const leaseA = acquired.json().leaseId as string;
  expect(leaseA).toEqual(expect.any(String));

  const publicState = await server.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${id}/input-lease`,
    headers: { authorization: `Bearer ${server.token}` },
  });
  expect(publicState.json().lease).toMatchObject({
    owner: { actorType: "host", label: "Host administrator" },
    revision: expect.any(Number),
  });
  expect(JSON.stringify(publicState.json())).not.toContain(leaseA);
  expect(JSON.stringify(publicState.json())).not.toContain("holderId");
  expect(JSON.stringify(publicState.json())).not.toContain("actorId");

  const unproven = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { data: "unproven" },
  });
  expect(unproven.statusCode).toBe(409);
  expect(unproven.json().code).toBe("INPUT_LEASE_REQUIRED");

  const acceptedA = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { data: "from-a", clientId: "automation-a", leaseId: leaseA },
  });
  expect(acceptedA.statusCode).toBe(202);
  expect(server.fakePty.writesFor(id)).toContain("from-a");

  const contested = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input-lease`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { action: "acquire", clientId: "automation-b" },
  });
  expect(contested.statusCode).toBe(409);
  const unconfirmed = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input-lease`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { action: "takeover", clientId: "automation-b" },
  });
  expect(unconfirmed.statusCode).toBe(409);

  const takeover = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input-lease`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { action: "takeover", clientId: "automation-b", confirm: true },
  });
  expect(takeover.statusCode).toBe(201);
  const leaseB = takeover.json().leaseId as string;
  expect(leaseB).not.toBe(leaseA);

  const stale = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { data: "stale-a", clientId: "automation-a", leaseId: leaseA },
  });
  expect(stale.statusCode).toBe(409);
  const acceptedB = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { data: "from-b", appendNewline: true, clientId: "automation-b", leaseId: leaseB },
  });
  expect(acceptedB.statusCode).toBe(202);
  expect(server.fakePty.writesFor(id)).toContain("from-b\r");
  expect(server.fakePty.writesFor(id)).not.toContain("stale-a");

  const released = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input-lease`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { action: "release", clientId: "automation-b", leaseId: leaseB },
  });
  expect(released.statusCode).toBe(200);
  const legacyOneShot = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { data: "legacy-one-shot" },
  });
  expect(legacyOneShot.statusCode).toBe(202);
  expect(server.fakePty.writesFor(id)).toContain("legacy-one-shot");
  expect(server.inputLeases.get(id)).toBeUndefined();

  socket.close();
  await server.app.close();
});

test("team policy can deny even a confirmed input takeover", async () => {
  const server = await buildTestServer({
    terminalAvailable: true,
    deps: { authorizeInputTakeover: () => false },
  });
  await server.listen();
  const { id, socket } = await createAttachedSession(server);

  const denied = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input-lease`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { action: "takeover", clientId: "policy-denied", confirm: true },
  });
  expect(denied.statusCode).toBe(403);
  expect(denied.json().code).toBe("INPUT_TAKEOVER_FORBIDDEN");

  socket.close();
  await server.app.close();
});

test("administrator revoke is confirmed, idempotent, and never transfers input", async () => {
  const server = await buildTestServer({ terminalAvailable: true });
  await server.listen();
  const { id, socket } = await createAttachedSession(server);
  expect(server.inputLeases.get(id)).toBeDefined();

  const unconfirmed = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input-lease`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { action: "revoke" },
  });
  expect(unconfirmed.statusCode).toBe(400);
  expect(unconfirmed.json().code).toBe("INPUT_LEASE_REVOKE_CONFIRM_REQUIRED");
  expect(server.inputLeases.get(id)).toBeDefined();

  const revoked = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input-lease`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { action: "revoke", confirm: true },
  });
  expect(revoked.statusCode).toBe(200);
  expect(revoked.json()).toEqual({ lease: null, revoked: true });
  expect(server.inputLeases.get(id)).toBeUndefined();

  const repeated = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/input-lease`,
    headers: { authorization: `Bearer ${server.token}` },
    payload: { action: "revoke", confirm: true },
  });
  expect(repeated.json()).toEqual({ lease: null, revoked: false });
  expect(server.inputLeases.get(id)).toBeUndefined();

  socket.close();
  await server.app.close();
});

test("revoking a device immediately closes its live terminal sockets", async () => {
  const pairSecret = `rcp_${"p".repeat(43)}`;
  const deviceToken = `rcd_${"d".repeat(43)}`;
  const deviceStore = openDeviceStore({
    dbPath: ":memory:",
    generateSecret: () => pairSecret,
    generateToken: () => deviceToken,
    generateId: () => "device-live",
  });
  const server = await buildTestServer({ terminalAvailable: true, deps: { deviceStore } });
  const pairing = server.issuePairing();
  const claim = await server.app.inject({
    method: "POST",
    url: "/pairing/claim",
    payload: { secret: pairing.secret, name: "Revocable browser" },
  });
  expect(claim.statusCode).toBe(201);
  await server.listen();
  const created = await server.app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${server.token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });
  const id = created.json().session.id as string;
  const socket = server.wsConnect(`/sessions/${id}/terminal?token=${deviceToken}`);
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  await openWs(socket);

  const revoked = await server.app.inject({
    method: "DELETE",
    url: "/api/v1/devices/device-live",
    headers: { authorization: `Bearer ${server.token}` },
  });
  expect(revoked.statusCode).toBe(204);
  await expect(closed).resolves.toBe(4403);
  await expect.poll(() => server.inputLeases.get(id)).toBeUndefined();

  await server.app.close();
});
