import { afterEach, describe, expect, test } from "vitest";
import { openCommandCenterStore } from "../src/command-center-store.js";
import { openDeviceStore, type DeviceStore } from "../src/device-store.js";
import { openPeerStore } from "../src/peer-store.js";
import { openPolicyStore } from "../src/policy-store.js";
import { openTeamStore } from "../src/team-store.js";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const peerTokenA = `rcd_${"a".repeat(43)}`;
const peerTokenB = `rcd_${"b".repeat(43)}`;
const peerTokenC = `rcd_${"c".repeat(43)}`;

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.app.close()));
});

function enroll(store: DeviceStore, name: string): { id: string; token: string } {
  const ticket = store.issuePairing();
  const enrollment = store.claimPairing(ticket.secret, name);
  if (!enrollment) throw new Error("test device enrollment failed");
  return { id: enrollment.device.id, token: enrollment.token };
}

async function setupRemote(): Promise<{
  server: TestServer;
  baseUrl: string;
  deviceStore: DeviceStore;
  peerDevices: [{ id: string; token: string }, { id: string; token: string }];
  workspaceIds: [string, string];
}> {
  const commandStore = openCommandCenterStore({
    dbPath: ":memory:",
    hostLabel: "Remote build host",
    generateHostId: () => "host-remote",
    generateWorkspaceId: (() => {
      let index = 0;
      return () => `workspace-remote-${++index}`;
    })(),
  });
  const tokens = [peerTokenA, peerTokenB, peerTokenC];
  const deviceStore = openDeviceStore({
    dbPath: ":memory:",
    generateSecret: (() => {
      let index = 0;
      return () => `rcp_${String(++index).padStart(43, "p")}`;
    })(),
    generateToken: () => tokens.shift()!,
    generateId: (() => {
      let index = 0;
      return () => `peer-device-${++index}`;
    })(),
  });
  const peerDevices = [enroll(deviceStore, "Federation service A"), enroll(deviceStore, "Federation service B")] as [
    { id: string; token: string },
    { id: string; token: string },
  ];
  const teamStore = openTeamStore({
    dbPath: ":memory:",
    generateTeamId: () => "team-remote",
    generateMemberId: (() => {
      let index = 0;
      return () => `member-remote-${++index}`;
    })(),
    generateRoleId: (() => {
      let index = 0;
      return () => `role-remote-${++index}`;
    })(),
  });
  teamStore.createTeam({
    name: "Remote engineering",
    ownerName: "Remote owner",
    ownerPrincipal: { actorType: "host", actorId: "host-remote" },
  });
  const service = teamStore.createMember({ displayName: "Federation service", kind: "service" });
  teamStore.grantRole({ memberId: service.id, role: "operator" });
  for (const device of peerDevices) {
    teamStore.bindPrincipal({ memberId: service.id, actorType: "device", actorId: device.id });
  }
  const team = teamStore.getTeam()!;
  teamStore.updateTeam({ authorizationEnabled: true }, team.revision);

  const server = await buildTestServer({
    terminalAvailable: true,
    deps: { commandStore, deviceStore, teamStore },
  });
  servers.push(server);
  const first = await server.app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth(server.token),
    payload: { cwd: process.cwd(), label: "Remote root" },
  });
  const second = await server.app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth(server.token),
    payload: { cwd: `${process.cwd()}/packages/server`, label: "Remote server" },
  });
  expect(first.statusCode).toBe(201);
  expect(second.statusCode).toBe(201);
  const wsUrl = await server.listen();
  return {
    server,
    baseUrl: wsUrl.replace(/^ws:/, "http:"),
    deviceStore,
    peerDevices,
    workspaceIds: [first.json().workspace.id as string, second.json().workspace.id as string],
  };
}

async function setupLocal(
  extra: {
    deviceStore?: DeviceStore;
    teamStore?: ReturnType<typeof openTeamStore>;
    policyStore?: ReturnType<typeof openPolicyStore>;
    peerFetch?: typeof globalThis.fetch;
  } = {},
): Promise<TestServer> {
  const commandStore = openCommandCenterStore({
    dbPath: ":memory:",
    hostLabel: "Local coordinator",
    generateHostId: () => "host-local",
  });
  const peerStore = openPeerStore({ dbPath: ":memory:", generatePeerId: () => "peer-remote" });
  const server = await buildTestServer({
    terminalAvailable: false,
    deps: { commandStore, peerStore, ...extra },
  });
  servers.push(server);
  return server;
}

async function registerPeer(
  local: TestServer,
  input: { baseUrl: string; credential: string; allowedWorkspaceIds?: string[] | null },
) {
  return local.app.inject({
    method: "POST",
    url: "/api/v1/peers",
    headers: auth(local.token),
    payload: {
      label: "Remote build",
      baseUrl: input.baseUrl,
      credential: input.credential,
      actions: ["read", "wait", "send", "start", "focus"],
      ...(input.allowedWorkspaceIds === undefined ? {} : { allowedWorkspaceIds: input.allowedWorkspaceIds }),
      confirm: true,
    },
  });
}

describe("peer federation transport", () => {
  test("enrolls from a one-use pairing link while keeping the durable credential server-side", async () => {
    const remote = await setupRemote();
    const local = await setupLocal();
    const ticket = remote.deviceStore.issuePairing();
    const registered = await local.app.inject({
      method: "POST",
      url: "/api/v1/peers",
      headers: auth(local.token),
      payload: {
        label: "Remote build",
        pairingUrl: `${remote.baseUrl}/#pair=${ticket.secret}`,
        actions: ["read", "wait"],
        confirm: true,
      },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().peer).toMatchObject({
      id: "peer-remote",
      remoteHostId: "host-remote",
      allowedWorkspaceIds: [],
    });
    expect(registered.body).not.toContain(ticket.secret);
    expect(registered.body).not.toContain(peerTokenC);
    expect(remote.deviceStore.list()).toContainEqual(
      expect.objectContaining({ name: "RoamCode peer · Local coordinator", scopes: ["direct"] }),
    );

    const replayed = await local.app.inject({
      method: "POST",
      url: "/api/v1/peers",
      headers: auth(local.token),
      payload: { pairingUrl: `${remote.baseUrl}/#pair=${ticket.secret}`, confirm: true },
    });
    expect(replayed.statusCode).toBe(410);
    expect(replayed.body).not.toContain(ticket.secret);
  });

  test("revokes a newly claimed remote device when local peer persistence fails", async () => {
    const remote = await setupRemote();
    const cleanupStatuses: Array<{ method: string; status: number }> = [];
    const peerFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (init?.method === "DELETE") cleanupStatuses.push({ method: init.method, status: response.status });
      return response;
    };
    const local = await setupLocal({ peerFetch });
    expect(
      (await registerPeer(local, { baseUrl: remote.baseUrl, credential: remote.peerDevices[0].token })).statusCode,
    ).toBe(201);
    const before = remote.deviceStore.list().length;
    const ticket = remote.deviceStore.issuePairing();
    const duplicate = await local.app.inject({
      method: "POST",
      url: "/api/v1/peers",
      headers: auth(local.token),
      payload: { pairingUrl: `${remote.baseUrl}/#pair=${ticket.secret}`, confirm: true },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "PEER_EXISTS" });
    expect(cleanupStatuses).toEqual([{ method: "DELETE", status: 204 }]);
    expect(remote.deviceStore.list()).toHaveLength(before);
    expect(duplicate.body).not.toContain(ticket.secret);
    expect(duplicate.body).not.toContain(peerTokenC);
  });

  test("discovers metadata for setup while keeping a new peer workspace-denied by default", async () => {
    const remote = await setupRemote();
    const local = await setupLocal();
    const registered = await registerPeer(local, {
      baseUrl: remote.baseUrl,
      credential: remote.peerDevices[0].token,
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().peer.allowedWorkspaceIds).toEqual([]);

    const deniedByDefault = await local.app.inject({
      method: "GET",
      url: "/api/v1/peers/peer-remote/workspaces",
      headers: auth(local.token),
    });
    expect(deniedByDefault.statusCode).toBe(200);
    expect(deniedByDefault.json().workspaces).toEqual([]);

    const discovered = await local.app.inject({
      method: "POST",
      url: "/api/v1/peers/peer-remote/discover",
      headers: auth(local.token),
      payload: { expectedRevision: 1 },
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json()).toMatchObject({
      peer: { id: "peer-remote", revision: 2, allowedWorkspaceIds: [] },
      workspaces: [
        { id: remote.workspaceIds[0], label: "Remote root", kind: "directory", archived: false },
        { id: remote.workspaceIds[1], label: "Remote server", kind: "directory", archived: false },
      ],
    });
    expect(discovered.body).not.toContain(process.cwd());
    expect(discovered.body).not.toContain(remote.peerDevices[0].token);
    expect(discovered.body).not.toContain(remote.baseUrl);

    const scoped = await local.app.inject({
      method: "PATCH",
      url: "/api/v1/peers/peer-remote",
      headers: auth(local.token),
      payload: { expectedRevision: 2, allowedWorkspaceIds: [remote.workspaceIds[0]] },
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().peer).toMatchObject({ revision: 3, allowedWorkspaceIds: [remote.workspaceIds[0]] });
    const visible = await local.app.inject({
      method: "GET",
      url: "/api/v1/peers/peer-remote/workspaces",
      headers: auth(local.token),
    });
    expect(visible.json().workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([
      remote.workspaceIds[0],
    ]);
  });

  test("coordinates a remote agent through scoped discovery, idempotent start, input lease, send, wait, and focus", async () => {
    const remote = await setupRemote();
    const local = await setupLocal();
    const registered = await registerPeer(local, {
      baseUrl: remote.baseUrl,
      credential: remote.peerDevices[0].token,
      allowedWorkspaceIds: [remote.workspaceIds[0]],
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().peer).toMatchObject({
      id: "peer-remote",
      remoteHostId: "host-remote",
      actions: ["read", "wait", "send", "start", "focus"],
      allowedWorkspaceIds: [remote.workspaceIds[0]],
    });
    expect(registered.body).not.toContain(remote.peerDevices[0].token);
    expect(registered.body).not.toContain(remote.baseUrl);

    const workspaces = await local.app.inject({
      method: "GET",
      url: "/api/v1/peers/peer-remote/workspaces",
      headers: auth(local.token),
    });
    expect(workspaces.statusCode).toBe(200);
    expect(workspaces.json().workspaces).toEqual([
      expect.objectContaining({ id: remote.workspaceIds[0], label: "Remote root" }),
    ]);
    expect(workspaces.body).not.toContain(remote.workspaceIds[1]);

    const startHeaders = { ...auth(local.token), "idempotency-key": "remote-start-1" };
    const started = await local.app.inject({
      method: "POST",
      url: "/api/v1/peers/peer-remote/sessions",
      headers: startHeaders,
      payload: { workspaceId: remote.workspaceIds[0], provider: "claude", options: {} },
    });
    expect(started.statusCode).toBe(201);
    const replayed = await local.app.inject({
      method: "POST",
      url: "/api/v1/peers/peer-remote/sessions",
      headers: startHeaders,
      payload: { workspaceId: remote.workspaceIds[0], provider: "claude", options: {} },
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toEqual(started.json());
    const sessionId = started.json().session.id as string;
    const agentId = started.json().session.agentId as string;
    expect(sessionId).toEqual(expect.any(String));

    const remoteSessions = await remote.server.app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: auth(remote.server.token),
    });
    expect(remoteSessions.json().sessions).toHaveLength(1);

    const socket = remote.server.wsConnect(`/sessions/${sessionId}/terminal?token=${remote.server.token}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await expect.poll(() => remote.server.fakePty.argsFor(sessionId).length).toBeGreaterThan(0);
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await expect.poll(() => remote.server.inputLeases.get(sessionId)).toBeUndefined();

    const acquired = await local.app.inject({
      method: "POST",
      url: `/api/v1/peers/peer-remote/sessions/${sessionId}/input-lease`,
      headers: auth(local.token),
      payload: { action: "acquire", clientId: "coordinator-one" },
    });
    expect(acquired.statusCode).toBe(201);
    const leaseId = acquired.json().leaseId as string;
    expect(leaseId).toEqual(expect.any(String));

    const sent = await local.app.inject({
      method: "POST",
      url: `/api/v1/peers/peer-remote/sessions/${sessionId}/input`,
      headers: auth(local.token),
      payload: { data: "continue", appendNewline: true, clientId: "coordinator-one", leaseId },
    });
    expect(sent.statusCode).toBe(202);
    expect(remote.server.fakePty.writesFor(sessionId)).toContain("continue\r");

    const contested = await local.app.inject({
      method: "POST",
      url: `/api/v1/peers/peer-remote/sessions/${sessionId}/input`,
      headers: auth(local.token),
      payload: { data: "must-not-write" },
    });
    expect(contested.statusCode).toBe(409);
    expect(contested.json()).toMatchObject({
      code: "PEER_REMOTE_CONFLICT",
      remoteCode: "INPUT_LEASE_REQUIRED",
    });
    expect(remote.server.fakePty.writesFor(sessionId)).not.toContain("must-not-write");

    const waited = await local.app.inject({
      method: "GET",
      url: `/api/v1/peers/peer-remote/agents/${agentId}/wait?after=0&timeoutMs=10`,
      headers: auth(local.token),
    });
    expect(waited.statusCode).toBe(200);
    expect(waited.json().agent).toMatchObject({ id: agentId, workspaceId: remote.workspaceIds[0] });

    const focused = await local.app.inject({
      method: "POST",
      url: `/api/v1/peers/peer-remote/agents/${agentId}/focus`,
      headers: auth(local.token),
      payload: { mode: "request" },
    });
    expect(focused.statusCode).toBe(202);

    const adminRevoke = await local.app.inject({
      method: "POST",
      url: `/api/v1/peers/peer-remote/sessions/${sessionId}/input-lease`,
      headers: auth(local.token),
      payload: { action: "revoke", confirm: true },
    });
    expect(adminRevoke.statusCode).toBe(403);
    expect(adminRevoke.json()).toMatchObject({
      code: "PEER_REMOTE_DENIED",
      remoteCode: "TEAM_PERMISSION_DENIED",
    });

    const released = await local.app.inject({
      method: "POST",
      url: `/api/v1/peers/peer-remote/sessions/${sessionId}/input-lease`,
      headers: auth(local.token),
      payload: { action: "release", clientId: "coordinator-one", leaseId },
    });
    expect(released.statusCode).toBe(200);
  });

  test("recovers a revoked peer credential without exposing either credential", async () => {
    const remote = await setupRemote();
    const local = await setupLocal();
    const registered = await registerPeer(local, {
      baseUrl: remote.baseUrl,
      credential: remote.peerDevices[0].token,
      allowedWorkspaceIds: null,
    });
    expect(registered.statusCode).toBe(201);
    expect(remote.server.app.server.listening).toBe(true);
    remote.server.app.server.unref();

    // Simulate remote credential revocation without restarting either isolated server.
    const revoked = await remote.server.app.inject({
      method: "DELETE",
      url: `/api/v1/devices/${remote.peerDevices[0].id}`,
      headers: auth(remote.server.token),
    });
    expect(revoked.statusCode).toBe(204);
    const failed = await local.app.inject({
      method: "GET",
      url: "/api/v1/peers/peer-remote/workspaces",
      headers: auth(local.token),
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().code).toBe("PEER_CREDENTIAL_REJECTED");
    expect(failed.body).not.toContain(remote.peerDevices[0].token);

    const rotated = await local.app.inject({
      method: "POST",
      url: "/api/v1/peers/peer-remote/credential",
      headers: auth(local.token),
      payload: { credential: remote.peerDevices[1].token, expectedRevision: 1, confirm: true },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().peer).toMatchObject({ id: "peer-remote", revision: 2 });
    expect(rotated.body).not.toContain(remote.peerDevices[1].token);

    const recovered = await local.app.inject({
      method: "GET",
      url: "/api/v1/peers/peer-remote/workspaces",
      headers: auth(local.token),
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().workspaces).toHaveLength(2);

    const stale = await local.app.inject({
      method: "POST",
      url: "/api/v1/peers/peer-remote/credential",
      headers: auth(local.token),
      payload: { credential: remote.peerDevices[1].token, expectedRevision: 1, confirm: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).not.toContain(remote.peerDevices[1].token);
  });

  test("filters discovery and operations through local workspace RBAC and organization policy", async () => {
    const remote = await setupRemote();
    const callerTokens = [`rcd_${"v".repeat(43)}`, `rcd_${"u".repeat(43)}`, `rcd_${"o".repeat(43)}`];
    const callerIds = ["viewer-device", "unbound-device", "operator-device"];
    const deviceStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: (() => {
        let index = 0;
        return () => `rcp_${String(++index).padStart(43, "q")}`;
      })(),
      generateToken: () => callerTokens.shift()!,
      generateId: () => callerIds.shift()!,
    });
    const viewer = enroll(deviceStore, "Workspace viewer");
    const unbound = enroll(deviceStore, "Unbound browser");
    const operator = enroll(deviceStore, "Team operator");
    const teamStore = openTeamStore({
      dbPath: ":memory:",
      generateTeamId: () => "team-local",
      generateMemberId: (() => {
        let index = 0;
        return () => `member-local-${++index}`;
      })(),
      generateRoleId: (() => {
        let index = 0;
        return () => `role-local-${++index}`;
      })(),
    });
    teamStore.createTeam({
      name: "Local engineering",
      ownerName: "Local owner",
      ownerPrincipal: { actorType: "host", actorId: "host-local" },
    });
    const viewerMember = teamStore.createMember({ displayName: "Workspace viewer" });
    teamStore.grantRole({
      memberId: viewerMember.id,
      role: "viewer",
      scopeType: "workspace",
      scopeId: remote.workspaceIds[0],
    });
    teamStore.bindPrincipal({ memberId: viewerMember.id, actorType: "device", actorId: viewer.id });
    const operatorMember = teamStore.createMember({ displayName: "Team operator" });
    teamStore.grantRole({ memberId: operatorMember.id, role: "operator" });
    teamStore.bindPrincipal({ memberId: operatorMember.id, actorType: "device", actorId: operator.id });
    const team = teamStore.getTeam()!;
    teamStore.updateTeam({ authorizationEnabled: true }, team.revision);
    const policyStore = openPolicyStore({ dbPath: ":memory:" });
    policyStore.update(
      {
        enforcementEnabled: true,
        allowedHostIds: ["host-remote"],
        allowedWorkspaceIds: [remote.workspaceIds[0]],
      },
      1,
    );
    const local = await setupLocal({ deviceStore, teamStore, policyStore });
    expect(
      (
        await registerPeer(local, {
          baseUrl: remote.baseUrl,
          credential: remote.peerDevices[0].token,
          allowedWorkspaceIds: null,
        })
      ).statusCode,
    ).toBe(201);

    const visible = await local.app.inject({
      method: "GET",
      url: "/api/v1/peers/peer-remote/workspaces",
      headers: auth(viewer.token),
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json().workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([
      remote.workspaceIds[0],
    ]);

    const deniedUnbound = await local.app.inject({
      method: "GET",
      url: "/api/v1/peers/peer-remote/workspaces",
      headers: auth(unbound.token),
    });
    expect(deniedUnbound.statusCode).toBe(403);
    expect(deniedUnbound.json().code).toBe("TEAM_PERMISSION_DENIED");

    const viewerCannotStart = await local.app.inject({
      method: "POST",
      url: "/api/v1/peers/peer-remote/sessions",
      headers: auth(viewer.token),
      payload: { workspaceId: remote.workspaceIds[0], provider: "claude", options: {} },
    });
    expect(viewerCannotStart.statusCode).toBe(403);
    expect(viewerCannotStart.json().permission).toBe("sessions:operate");

    const policyDenied = await local.app.inject({
      method: "POST",
      url: "/api/v1/peers/peer-remote/sessions",
      headers: auth(operator.token),
      payload: { workspaceId: remote.workspaceIds[1], provider: "claude", options: {} },
    });
    expect(policyDenied.statusCode).toBe(403);
    expect(policyDenied.json()).toMatchObject({ code: "ENTERPRISE_POLICY_DENIED", reason: "workspace-denied" });

    const audit = await local.app.inject({ method: "GET", url: "/api/v1/audit", headers: auth(local.token) });
    expect(audit.body).toContain("team.peer_authorization.denied");
    expect(audit.body).not.toContain(viewer.token);
    expect(audit.body).not.toContain(remote.peerDevices[0].token);
  });
});
