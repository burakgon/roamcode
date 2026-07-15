import { expect, test } from "vitest";
import { openDeviceStore } from "../src/device-store.js";
import { openTeamStore } from "../src/team-store.js";
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

function collectLeaseFrames(ws: import("ws").WebSocket): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (raw, binary) => {
    if (binary) return;
    try {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (value.t === "input-lease") frames.push(value);
    } catch {
      /* unrelated control */
    }
  });
  return frames;
}

test("enforced team roles apply equally to HTTP, terminal WS, input ownership, and presence", async () => {
  const secrets = [`rcp_${"a".repeat(43)}`, `rcp_${"b".repeat(43)}`, `rcp_${"c".repeat(43)}`];
  const tokens = [`rcd_${"a".repeat(43)}`, `rcd_${"b".repeat(43)}`, `rcd_${"c".repeat(43)}`];
  const ids = ["viewer-device", "operator-device", "policy-device"];
  let secretIndex = 0;
  let tokenIndex = 0;
  let idIndex = 0;
  const deviceStore = openDeviceStore({
    dbPath: ":memory:",
    generateSecret: () => secrets[secretIndex++]!,
    generateToken: () => tokens[tokenIndex++]!,
    generateId: () => ids[idIndex++]!,
  });
  let memberId = 0;
  let roleId = 0;
  const teamStore = openTeamStore({
    dbPath: ":memory:",
    generateTeamId: () => "team-1",
    generateMemberId: () => `member-${++memberId}`,
    generateRoleId: () => `role-${++roleId}`,
  });
  const server = await buildTestServer({ terminalAvailable: true, deps: { deviceStore, teamStore } });

  for (const name of ["Viewer browser", "Operator agent", "Policy administrator"]) {
    const pairing = server.issuePairing();
    const claim = await server.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { secret: pairing.secret, name },
    });
    expect(claim.statusCode).toBe(201);
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const team = await server.app.inject({
    method: "POST",
    url: "/api/v1/team",
    headers: auth(server.token),
    payload: { name: "Product Engineering", ownerName: "Host owner" },
  });
  expect(team.statusCode).toBe(201);

  const viewer = await server.app.inject({
    method: "POST",
    url: "/api/v1/team/members",
    headers: auth(server.token),
    payload: { displayName: "Viewer", role: "viewer" },
  });
  const viewerId = viewer.json().member.id as string;
  await server.app.inject({
    method: "POST",
    url: "/api/v1/team/principals",
    headers: auth(server.token),
    payload: { memberId: viewerId, actorType: "device", actorId: "viewer-device" },
  });
  const operator = await server.app.inject({
    method: "POST",
    url: "/api/v1/team/members",
    headers: auth(server.token),
    payload: { displayName: "Operator", kind: "service", role: "operator" },
  });
  const operatorId = operator.json().member.id as string;
  await server.app.inject({
    method: "POST",
    url: "/api/v1/team/principals",
    headers: auth(server.token),
    payload: { memberId: operatorId, actorType: "device", actorId: "operator-device" },
  });
  const policyAdmin = await server.app.inject({
    method: "POST",
    url: "/api/v1/team/members",
    headers: auth(server.token),
    payload: { displayName: "Policy administrator", role: "policy-admin" },
  });
  await server.app.inject({
    method: "POST",
    url: "/api/v1/team/principals",
    headers: auth(server.token),
    payload: { memberId: policyAdmin.json().member.id, actorType: "device", actorId: "policy-device" },
  });

  const current = server.teamStore.getTeam()!;
  const enabled = await server.app.inject({
    method: "PATCH",
    url: "/api/v1/team",
    headers: auth(server.token),
    payload: { authorizationEnabled: true, expectedRevision: current.revision, confirm: true },
  });
  expect(enabled.statusCode).toBe(200);

  const created = await server.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth(server.token),
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });
  const sessionId = created.json().session.id as string;
  await server.listen();

  const viewerSocket = server.wsConnect(`/sessions/${sessionId}/terminal?token=${tokens[0]}`);
  const frames = collectLeaseFrames(viewerSocket);
  const viewerClosed = new Promise<number>((resolve) => viewerSocket.once("close", (code) => resolve(code)));
  await openWs(viewerSocket);
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  expect(frames.at(-1)).toMatchObject({ writable: false, canTakeover: false });
  expect(frames.at(-1)?.reason).toContain("view but cannot operate");

  const viewerRead = await server.app.inject({
    method: "GET",
    url: "/api/v1/sessions",
    headers: auth(tokens[0]!),
  });
  expect(viewerRead.statusCode).toBe(200);
  const viewerWrite = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/input-lease`,
    headers: auth(tokens[0]!),
    payload: { action: "acquire", clientId: "viewer-tab" },
  });
  expect(viewerWrite.statusCode).toBe(403);
  expect(viewerWrite.json().code).toBe("TEAM_PERMISSION_DENIED");
  const viewerWorkspaceMutation = await server.app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth(tokens[0]!),
    payload: { cwd: process.cwd() },
  });
  expect(viewerWorkspaceMutation.statusCode).toBe(403);
  expect(viewerWorkspaceMutation.json().permission).toBe("workspaces:manage");

  const viewerPresence = await server.app.inject({
    method: "POST",
    url: "/api/v1/presence",
    headers: auth(tokens[0]!),
    payload: { clientId: "viewer-tab", mode: "viewing", sessionId },
  });
  expect(viewerPresence.statusCode).toBe(200);
  expect(viewerPresence.json().presence).toMatchObject({ memberId: viewerId, mode: "viewing", sessionId });

  const lease = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/input-lease`,
    headers: auth(tokens[1]!),
    payload: { action: "acquire", clientId: "operator-agent" },
  });
  expect(lease.statusCode).toBe(201);
  const operatorPresence = await server.app.inject({
    method: "POST",
    url: "/api/v1/presence",
    headers: auth(tokens[1]!),
    payload: { clientId: "operator-agent", mode: "operating", sessionId },
  });
  expect(operatorPresence.statusCode).toBe(200);
  const operatorCannotAdminRevoke = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/input-lease`,
    headers: auth(tokens[1]!),
    payload: { action: "revoke", confirm: true },
  });
  expect(operatorCannotAdminRevoke.statusCode).toBe(403);
  expect(operatorCannotAdminRevoke.json().permission).toBe("policy:manage");
  const adminRevoked = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/input-lease`,
    headers: auth(tokens[2]!),
    payload: { action: "revoke", confirm: true },
  });
  expect(adminRevoked.statusCode).toBe(200);
  expect(server.inputLeases.get(sessionId)).toBeUndefined();
  expect(server.presence.list({ sessionId }).find((record) => record.memberId === operatorId)?.mode).toBe("viewing");
  const reacquired = await server.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/input-lease`,
    headers: auth(tokens[1]!),
    payload: { action: "acquire", clientId: "operator-agent" },
  });
  expect(reacquired.statusCode).toBe(201);
  const refreshedOperatorPresence = await server.app.inject({
    method: "POST",
    url: "/api/v1/presence",
    headers: auth(tokens[1]!),
    payload: { clientId: "operator-agent", mode: "operating", sessionId },
  });
  expect(refreshedOperatorPresence.statusCode).toBe(200);
  const listedPresence = await server.app.inject({
    method: "GET",
    url: `/api/v1/presence?sessionId=${sessionId}`,
    headers: auth(tokens[0]!),
  });
  expect(listedPresence.json().presence).toHaveLength(2);
  expect(JSON.stringify(listedPresence.json())).not.toContain("operator-device");

  const operatorRole = server.teamStore.listRoleBindings(operatorId).find((binding) => binding.role === "operator")!;
  const revokedRole = await server.app.inject({
    method: "DELETE",
    url: `/api/v1/team/roles/${operatorRole.id}`,
    headers: auth(server.token),
  });
  expect(revokedRole.statusCode).toBe(204);
  expect(server.inputLeases.get(sessionId)).toBeUndefined();
  expect(server.presence.list().some((record) => record.memberId === operatorId)).toBe(false);

  const currentViewer = server.teamStore.getMember(viewerId)!;
  const suspended = await server.app.inject({
    method: "PATCH",
    url: `/api/v1/team/members/${viewerId}`,
    headers: auth(server.token),
    payload: { status: "suspended", expectedRevision: currentViewer.revision },
  });
  expect(suspended.statusCode).toBe(200);
  await expect(viewerClosed).resolves.toBe(4403);
  const deniedAfterSuspension = await server.app.inject({
    method: "GET",
    url: "/api/v1/sessions",
    headers: auth(tokens[0]!),
  });
  expect(deniedAfterSuspension.statusCode).toBe(403);
  expect(deniedAfterSuspension.json().code).toBe("TEAM_PERMISSION_DENIED");

  await server.app.close();
});

test("team mutations return deterministic revision conflicts and require confirmation before enforcement", async () => {
  const server = await buildTestServer({ terminalAvailable: false });
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/team",
    headers: { authorization: `Bearer ${server.token}` },
    payload: { name: "Studio" },
  });
  const revision = created.json().team.revision as number;
  const noConfirm = await server.app.inject({
    method: "PATCH",
    url: "/api/v1/team",
    headers: { authorization: `Bearer ${server.token}` },
    payload: { authorizationEnabled: true, expectedRevision: revision },
  });
  expect(noConfirm.statusCode).toBe(400);
  expect(noConfirm.json().code).toBe("TEAM_ENFORCEMENT_CONFIRM_REQUIRED");

  const renamed = await server.app.inject({
    method: "PATCH",
    url: "/api/v1/team",
    headers: { authorization: `Bearer ${server.token}` },
    payload: { name: "Studio Two", expectedRevision: revision },
  });
  expect(renamed.statusCode).toBe(200);
  const stale = await server.app.inject({
    method: "PATCH",
    url: "/api/v1/team",
    headers: { authorization: `Bearer ${server.token}` },
    payload: { name: "Lost update", expectedRevision: revision },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ code: "TEAM_REVISION_CONFLICT", current: { name: "Studio Two" } });
  await server.app.close();
});

test("workspace-scoped roles authorize matching presence filters and deny other workspaces", async () => {
  const token = `rcd_${"c".repeat(43)}`;
  const deviceStore = openDeviceStore({
    dbPath: ":memory:",
    generateSecret: () => `rcp_${"c".repeat(43)}`,
    generateToken: () => token,
    generateId: () => "scoped-device",
  });
  const server = await buildTestServer({ terminalAvailable: false, deps: { deviceStore } });
  const pairing = server.issuePairing();
  const claimed = await server.app.inject({
    method: "POST",
    url: "/pairing/claim",
    payload: { secret: pairing.secret, name: "Workspace reviewer" },
  });
  expect(claimed.statusCode).toBe(201);
  const hostAuth = { authorization: `Bearer ${server.token}` };
  const deviceAuth = { authorization: `Bearer ${token}` };
  await server.app.inject({
    method: "POST",
    url: "/api/v1/team",
    headers: hostAuth,
    payload: { name: "Scoped team" },
  });
  const member = await server.app.inject({
    method: "POST",
    url: "/api/v1/team/members",
    headers: hostAuth,
    payload: {
      displayName: "Workspace reviewer",
      role: "viewer",
      scopeType: "workspace",
      scopeId: "workspace-allowed",
    },
  });
  await server.app.inject({
    method: "POST",
    url: "/api/v1/team/principals",
    headers: hostAuth,
    payload: { memberId: member.json().member.id, actorType: "device", actorId: "scoped-device" },
  });
  const current = server.teamStore.getTeam()!;
  await server.app.inject({
    method: "PATCH",
    url: "/api/v1/team",
    headers: hostAuth,
    payload: { authorizationEnabled: true, expectedRevision: current.revision, confirm: true },
  });

  const allowed = await server.app.inject({
    method: "GET",
    url: "/api/v1/presence?workspaceId=workspace-allowed",
    headers: deviceAuth,
  });
  expect(allowed.statusCode).toBe(200);
  const denied = await server.app.inject({
    method: "GET",
    url: "/api/v1/presence?workspaceId=workspace-other",
    headers: deviceAuth,
  });
  expect(denied.statusCode).toBe(403);
  expect(denied.json()).toMatchObject({ code: "TEAM_PERMISSION_DENIED", permission: "presence:read" });

  await server.app.close();
});
