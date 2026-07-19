import { expect, test } from "vitest";
import { openDeviceStore } from "../src/device-store.js";
import { buildTestServer } from "./helpers/test-server.js";

async function openWs(socket: import("ws").WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket did not open")), 5_000);
    socket.once("error", reject);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

test("enterprise policy uniformly restricts provider danger, transfer, extensions, updates, and live access", async () => {
  const deviceToken = `rcd_${"d".repeat(43)}`;
  const deviceStore = openDeviceStore({
    dbPath: ":memory:",
    generateSecret: () => `rcp_${"p".repeat(43)}`,
    generateToken: () => deviceToken,
    generateId: () => "policy-device",
  });
  const server = await buildTestServer({ terminalAvailable: true, deps: { deviceStore } });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const pairing = server.issuePairing();
  const claimed = await server.app.inject({
    method: "POST",
    url: "/pairing/claim",
    payload: { secret: pairing.secret, name: "Managed browser" },
  });
  expect(claimed.statusCode).toBe(201);

  const workspaceResponse = await server.app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth(server.token),
    payload: { cwd: process.cwd(), label: "Policy workspace" },
  });
  expect(workspaceResponse.statusCode).toBe(201);
  const workspaceId = workspaceResponse.json().workspace.id as string;
  const hostResponse = await server.app.inject({ method: "GET", url: "/api/v1/host", headers: auth(server.token) });
  const hostId = hostResponse.json().host.id as string;
  const initial = server.policyStore.get();
  const enabled = await server.app.inject({
    method: "PATCH",
    url: "/api/v1/policy",
    headers: auth(server.token),
    payload: {
      enforcementEnabled: true,
      allowedHostIds: [hostId],
      allowedWorkspaceIds: [workspaceId],
      allowedProviderIds: ["codex"],
      allowDangerousProviderModes: false,
      allowFileTransfer: false,
      extensionMode: "deny",
      updateMode: "deny",
      expectedRevision: initial.revision,
      confirm: true,
    },
  });
  expect(enabled.statusCode).toBe(200);

  const deniedProvider = await server.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: auth(deviceToken),
    payload: { provider: "claude", cwd: process.cwd(), options: {} },
  });
  expect(deniedProvider.statusCode).toBe(403);
  expect(deniedProvider.json()).toMatchObject({
    code: "ENTERPRISE_POLICY_DENIED",
    reason: "provider-denied",
  });

  const deniedDanger = await server.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: auth(deviceToken),
    payload: {
      provider: "codex",
      cwd: process.cwd(),
      options: { dangerouslyBypassApprovalsAndSandbox: true },
    },
  });
  expect(deniedDanger.statusCode).toBe(403);
  expect(deniedDanger.json().reason).toBe("dangerous-mode-denied");

  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: auth(deviceToken),
    payload: {
      provider: "codex",
      cwd: process.cwd(),
      options: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    },
  });
  expect(created.statusCode).toBe(201);
  const sessionId = created.json().session.id as string;

  const deniedTransfer = await server.app.inject({
    method: "GET",
    url: "/fs/download?path=package.json",
    headers: auth(deviceToken),
  });
  expect(deniedTransfer.statusCode).toBe(403);
  expect(deniedTransfer.json().reason).toBe("file-transfer-denied");
  const deniedExtension = await server.app.inject({
    method: "POST",
    url: "/api/v1/extensions/install",
    headers: auth(deviceToken),
    payload: { sourceDirectory: process.cwd(), expectedIntegrity: `sha256:${"a".repeat(64)}` },
  });
  expect(deniedExtension.statusCode).toBe(403);
  expect(deniedExtension.json().reason).toBe("extension-denied");
  const deniedUpdate = await server.app.inject({
    method: "POST",
    url: "/update",
    headers: auth(deviceToken),
  });
  expect(deniedUpdate.statusCode).toBe(403);
  expect(deniedUpdate.json().reason).toBe("updates-denied");

  const fleet = await server.app.inject({ method: "GET", url: "/api/v1/fleet", headers: auth(deviceToken) });
  expect(fleet.statusCode).toBe(200);
  expect(fleet.json()).toMatchObject({
    hosts: [
      {
        id: hostId,
        health: "healthy",
        policyPosture: { enforcementEnabled: true, compliant: true },
        adapters: expect.arrayContaining([expect.objectContaining({ id: "codex" })]),
      },
    ],
  });
  expect(fleet.body).not.toContain(process.cwd());
  expect(fleet.body).not.toContain(deviceToken);

  await server.listen();
  const socket = server.wsConnect(`/sessions/${sessionId}/terminal?token=${deviceToken}`);
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  await openWs(socket);
  const current = server.policyStore.get();
  const hostDenied = await server.app.inject({
    method: "PATCH",
    url: "/api/v1/policy",
    headers: auth(server.token),
    payload: { allowedHostIds: ["another-host"], expectedRevision: current.revision },
  });
  expect(hostDenied.statusCode).toBe(200);
  await expect(closed).resolves.toBe(4403);
  const deniedRead = await server.app.inject({ method: "GET", url: "/api/v1/sessions", headers: auth(deviceToken) });
  expect(deniedRead.statusCode).toBe(403);
  expect(deniedRead.json().reason).toBe("host-denied");
  const breakGlassRead = await server.app.inject({
    method: "GET",
    url: "/api/v1/sessions",
    headers: auth(server.token),
  });
  expect(breakGlassRead.statusCode).toBe(200);

  const audit = await server.app.inject({ method: "GET", url: "/api/v1/audit", headers: auth(server.token) });
  expect(audit.body).toContain("enterprise.policy.denied");
  expect(audit.body).not.toContain(deviceToken);
  await server.app.close();
});

test("delegated policy writes require enforced RBAC and deterministic revisions", async () => {
  const deviceToken = `rcd_${"e".repeat(43)}`;
  const deviceStore = openDeviceStore({
    dbPath: ":memory:",
    generateSecret: () => `rcp_${"q".repeat(43)}`,
    generateToken: () => deviceToken,
    generateId: () => "unbound-policy-device",
  });
  const server = await buildTestServer({ terminalAvailable: false, deps: { deviceStore } });
  const pairing = server.issuePairing();
  await server.app.inject({
    method: "POST",
    url: "/pairing/claim",
    payload: { secret: pairing.secret, name: "Unbound browser" },
  });
  const delegated = await server.app.inject({
    method: "PATCH",
    url: "/api/v1/policy",
    headers: { authorization: `Bearer ${deviceToken}` },
    payload: { allowFileTransfer: false, expectedRevision: 1 },
  });
  expect(delegated.statusCode).toBe(403);
  expect(delegated.json().code).toBe("TEAM_AUTHORIZATION_REQUIRED");

  const confirmation = await server.app.inject({
    method: "PATCH",
    url: "/api/v1/policy",
    headers: { authorization: `Bearer ${server.token}` },
    payload: { enforcementEnabled: true, expectedRevision: 1 },
  });
  expect(confirmation.statusCode).toBe(400);
  expect(confirmation.json().code).toBe("POLICY_ENFORCEMENT_CONFIRM_REQUIRED");
  const updated = await server.app.inject({
    method: "PATCH",
    url: "/api/v1/policy",
    headers: { authorization: `Bearer ${server.token}` },
    payload: { allowFileTransfer: false, expectedRevision: 1 },
  });
  expect(updated.statusCode).toBe(200);
  const stale = await server.app.inject({
    method: "PATCH",
    url: "/api/v1/policy",
    headers: { authorization: `Bearer ${server.token}` },
    payload: { allowFileTransfer: true, expectedRevision: 1 },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe("ENTERPRISE_POLICY_REVISION_CONFLICT");
  await server.app.close();
});
