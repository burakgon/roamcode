import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { openCloudAuthorizationStore } from "../src/cloud-authorization-store.js";
import { openCommandCenterStore } from "../src/command-center-store.js";
import { createCompositeAuthorizer } from "../src/composite-authorization.js";
import { openDeviceStore } from "../src/device-store.js";
import { generateRelayIdentity } from "../src/relay-crypto.js";
import { openTeamStore } from "../src/team-store.js";
import { cloudStatusResponse } from "../src/transport.js";
import {
  cloudAuthorizationSnapshot,
  cloudSigningFixture,
  signCloudAuthorizationSnapshot,
} from "./helpers/cloud-authorization.js";
import { buildTestServer } from "./helpers/test-server.js";
import type { TestServer } from "./helpers/test-server.js";

const directories: string[] = [];
const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.app.close()));
  while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "roamcode-transport-cloud-auth-"));
  directories.push(directory);
  return directory;
}

async function openWs(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("terminal socket did not open")), 5_000);
    socket.once("error", reject);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function managedTerminalFixture(options: {
  principalType: "device" | "relay";
  recheckMs: number;
  expiresAt?: number;
}) {
  const directory = await dataDir();
  const actorId = options.principalType === "relay" ? "cloud-relay" : "cloud-device";
  const token = `rcd_${(options.principalType === "relay" ? "r" : "d").repeat(43)}`;
  const deviceStore = openDeviceStore({
    dbPath: ":memory:",
    generateSecret: () => `rcp_${"p".repeat(43)}`,
    generateToken: () => token,
    generateId: () => actorId,
  });
  const pairing = deviceStore.issuePairing(1, options.principalType === "relay" ? ["relay"] : ["direct"]);
  const enrollment = deviceStore.claimPairing(
    pairing.secret,
    options.principalType === "relay" ? "Cloud relay" : "Cloud browser",
    2,
    options.principalType === "relay" ? generateRelayIdentity().publicKey : undefined,
  )!;
  const commandStore = openCommandCenterStore({ dbPath: ":memory:", generateHostId: () => "cloud-host" });
  const teamStore = openTeamStore({ dbPath: ":memory:" });
  const signing = cloudSigningFixture("cloud-terminal-key");
  const clock = { now: 1_000 };
  const cloudStore = openCloudAuthorizationStore({
    dataDir: directory,
    organizationId: "cloud-organization",
    hostId: "cloud-host",
    trustedKeys: [signing.trustedKey],
    now: () => clock.now,
  });
  const applyPermissions = (
    revision: number,
    permissions: Array<"sessions:read" | "sessions:operate">,
    at: number,
    expiresAt = at + 5_000,
  ) => {
    clock.now = at;
    cloudStore.apply(
      signCloudAuthorizationSnapshot(
        cloudAuthorizationSnapshot({
          organizationId: "cloud-organization",
          hostId: "cloud-host",
          revision,
          issuedAt: at,
          notBefore: at,
          expiresAt,
          grants:
            permissions.length === 0
              ? []
              : [
                  {
                    // The signed control-plane contract has one canonical browser principal type. Relay describes
                    // only how that same DeviceStore actor reached the Node.
                    principalType: "device",
                    principalId: actorId,
                    permissions,
                    scope: { type: "organization" },
                  },
                ],
        }),
        signing,
      ),
      at,
    );
  };
  applyPermissions(1, ["sessions:read", "sessions:operate"], clock.now, options.expiresAt ?? 10_000);
  const server = await buildTestServer({
    terminalAvailable: true,
    deps: {
      deviceStore,
      commandStore,
      teamStore,
      authorizer: createCompositeAuthorizer({ teamStore, cloudStore, now: () => clock.now }),
      terminalAuthorizationRecheckMs: options.recheckMs,
      cloudStatus: () => ({
        running: true,
        heartbeatFailures: 0,
        authorizationFailures: 0,
        lastAuthorizationAt: 1_000,
        authorization: cloudStore.getState(clock.now),
      }),
    },
  });
  servers.push(server);
  const created = await server.app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${server.token}` },
    payload: { provider: "claude", cwd: process.cwd(), mode: "terminal" },
  });
  expect(created.statusCode).toBe(201);
  const sessionId = created.json().session.id as string;
  await server.listen();
  const socket =
    options.principalType === "relay"
      ? server.wsConnect(
          `/sessions/${sessionId}/terminal?ticket=${encodeURIComponent(
            await server.issueRelayTerminalTicket(enrollment.token),
          )}`,
        )
      : server.wsConnect(`/sessions/${sessionId}/terminal?token=${enrollment.token}`);
  await openWs(socket);
  await expect.poll(() => server.inputLeases.get(sessionId)?.actorId).toBe(actorId);
  return { server, socket, sessionId, actorId, clock, applyPermissions };
}

describe("transport cloud authorization", () => {
  test("maps credential and verification failures to stable, non-secret recovery actions", () => {
    const base = {
      running: true,
      heartbeatFailures: 0,
      authorizationFailures: 1,
      authorization: { status: "unavailable" as const },
    };
    expect(cloudStatusResponse({ ...base, authorizationIssue: "credential-rejected" }).action).toBe("reauthorize-host");
    expect(cloudStatusResponse({ ...base, authorizationIssue: "trust-expired" }).action).toBe("reauthorize-host");
    expect(cloudStatusResponse({ ...base, authorizationIssue: "authorization-verification-failed" }).action).toBe(
      "contact-organization-admin",
    );
    expect(
      cloudStatusResponse({
        ...base,
        heartbeatFailures: 1,
        authorizationFailures: 0,
        authorization: { status: "active", revision: 2, expiresAt: 5_000 },
      }),
    ).toMatchObject({ sync: { state: "degraded" }, action: "check-host-connectivity" });
  });

  test("applies signed grants to ordinary device routes, expires fail-closed, and preserves host recovery", async () => {
    const directory = await dataDir();
    const token = `rcd_${"d".repeat(43)}`;
    const deviceStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => `rcp_${"p".repeat(43)}`,
      generateToken: () => token,
      generateId: () => "cloud-device",
    });
    const commandStore = openCommandCenterStore({ dbPath: ":memory:", generateHostId: () => "local-node" });
    const teamStore = openTeamStore({ dbPath: ":memory:" });
    const signing = cloudSigningFixture("cloud-key");
    let now = 1_000;
    const cloudStore = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId: "cloud-organization",
      hostId: "cloud-host",
      trustedKeys: [signing.trustedKey],
      now: () => now,
    });
    cloudStore.apply(
      signCloudAuthorizationSnapshot(
        cloudAuthorizationSnapshot({
          organizationId: "cloud-organization",
          hostId: "cloud-host",
          expiresAt: 1_500,
          grants: [
            {
              principalType: "device",
              principalId: "cloud-device",
              permissions: ["sessions:read"],
              scope: { type: "organization" },
            },
            {
              principalType: "device",
              principalId: "cloud-relay",
              permissions: ["sessions:read", "sessions:operate"],
              scope: { type: "host", id: "cloud-host" },
            },
            {
              principalType: "device",
              principalId: "workspace-only-device",
              permissions: ["sessions:read"],
              scope: { type: "workspace", id: "workspace-one" },
            },
            {
              principalType: "device",
              principalId: "policy-only-device",
              permissions: ["policy:manage"],
              scope: { type: "organization" },
            },
          ],
        }),
        signing,
      ),
      now,
    );
    const server = await buildTestServer({
      terminalAvailable: false,
      deps: {
        deviceStore,
        commandStore,
        teamStore,
        cloudAuthorizationStore: cloudStore,
        authorizer: createCompositeAuthorizer({
          teamStore,
          cloudStore,
          cloudHostId: "cloud-host",
          now: () => now,
        }),
        cloudStatus: () => ({
          running: true,
          heartbeatFailures: 0,
          authorizationFailures: now >= 1_500 ? 1 : 0,
          ...(now >= 1_500 ? { authorizationIssue: "connectivity" as const } : {}),
          lastAuthorizationAt: 1_000,
          authorization: cloudStore.getState(now),
        }),
      },
    });
    const pairing = server.issuePairing();
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/pairing/claim",
          payload: { secret: pairing.secret, name: "Cloud browser" },
        })
      ).statusCode,
    ).toBe(201);

    const active = await server.app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(active.statusCode).toBe(200);

    const projectedGrants = await server.app.inject({
      method: "GET",
      url: "/api/v2/nodes/local-node/access-grants",
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(projectedGrants.statusCode).toBe(200);
    expect(projectedGrants.json().grants).toEqual([
      expect.objectContaining({
        nodeId: "local-node",
        subject: { type: "device", id: "cloud-device" },
        role: "viewer",
        source: "cloud",
        mutable: false,
        revision: 1,
      }),
      expect.objectContaining({
        nodeId: "local-node",
        subject: { type: "device", id: "cloud-relay" },
        role: "operator",
        source: "cloud",
        mutable: false,
        revision: 1,
      }),
    ]);
    const managedMutation = await server.app.inject({
      method: "POST",
      url: "/api/v2/nodes/local-node/access-grants",
      headers: { authorization: `Bearer ${server.token}` },
      payload: { subject: { type: "member", id: "member-one" }, role: "viewer" },
    });
    expect(managedMutation.statusCode).toBe(409);
    expect(managedMutation.json().code).toBe("CLOUD_AUTHORITY_REQUIRED");
    const managedDelete = await server.app.inject({
      method: "DELETE",
      url: "/api/v2/nodes/local-node/access-grants/cloud_1_0",
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(managedDelete.statusCode).toBe(409);
    expect(managedDelete.json().code).toBe("CLOUD_AUTHORITY_REQUIRED");
    expect(teamStore.listRoleBindings()).toEqual([]);

    now = 1_500;
    const expired = await server.app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expired.statusCode).toBe(403);
    expect(expired.json()).toMatchObject({ code: "TEAM_PERMISSION_DENIED", permission: "sessions:read" });
    expect(cloudStore.getLastKnownGood()?.snapshot.revision).toBe(1);

    const cloudStatus = await server.app.inject({
      method: "GET",
      url: "/api/v1/cloud/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cloudStatus.statusCode).toBe(200);
    expect(cloudStatus.headers["cache-control"]).toBe("no-store");
    expect(cloudStatus.json()).toEqual({
      v: 1,
      mode: "managed",
      configured: true,
      sync: { state: "expired", lastSuccessfulAt: 1_000 },
      authorization: { status: "expired", revision: 1, expiresAt: 1_500, expired: true },
      action: "check-host-connectivity",
    });
    expect(cloudStatus.body).not.toMatch(/rch_|publicKey|signature|grants|controlPlane|organizationId|hostId/);

    const recovery = await server.app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(recovery.statusCode).toBe(200);
    await server.app.close();
  });

  test("rechecks operate permission when a terminal client renews its input lease", async () => {
    const { server, socket, sessionId, applyPermissions } = await managedTerminalFixture({
      principalType: "device",
      recheckMs: 60_000,
    });

    applyPermissions(2, ["sessions:read"], 2_000);
    socket.send(JSON.stringify({ t: "lease", action: "renew" }));

    await expect.poll(() => server.inputLeases.get(sessionId)).toBeUndefined();
    expect(socket.readyState).toBe(socket.OPEN);
    socket.send(JSON.stringify({ t: "i", d: "must-not-reach-pty" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.fakePty.writesFor(sessionId)).not.toContain("must-not-reach-pty");
    socket.close();
  });

  test("periodically downgrades lost operate access and closes a device socket after read grant removal", async () => {
    const { server, socket, sessionId, applyPermissions } = await managedTerminalFixture({
      principalType: "device",
      recheckMs: 20,
    });
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

    applyPermissions(2, ["sessions:read"], 2_000);
    await expect.poll(() => server.inputLeases.get(sessionId)).toBeUndefined();
    expect(socket.readyState).toBe(socket.OPEN);

    applyPermissions(3, [], 3_000);
    await expect(closed).resolves.toBe(4403);
    expect(server.inputLeases.get(sessionId)).toBeUndefined();
  });

  test("periodically closes a relay-ticket terminal when its signed authorization snapshot expires", async () => {
    const { server, socket, sessionId, clock } = await managedTerminalFixture({
      principalType: "relay",
      recheckMs: 20,
      expiresAt: 1_100,
    });
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

    clock.now = 1_100;
    await expect(closed).resolves.toBe(4403);
    expect(server.inputLeases.get(sessionId)).toBeUndefined();
  });

  test("keeps the exact self-hosted device behavior when cloud config and authorizer are absent", async () => {
    const token = `rcd_${"s".repeat(43)}`;
    const deviceStore = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => `rcp_${"q".repeat(43)}`,
      generateToken: () => token,
      generateId: () => "self-host-device",
    });
    const server = await buildTestServer({ terminalAvailable: false, deps: { deviceStore } });
    const pairing = server.issuePairing();
    await server.app.inject({
      method: "POST",
      url: "/pairing/claim",
      payload: { secret: pairing.secret, name: "Self-host browser" },
    });

    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/v1/sessions",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    const status = await server.app.inject({
      method: "GET",
      url: "/api/v1/cloud/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.json()).toEqual({
      v: 1,
      mode: "self-hosted",
      configured: false,
      sync: { state: "not-configured", lastSuccessfulAt: null },
      authorization: { status: "not-configured", revision: null, expiresAt: null, expired: false },
      action: "none",
    });
    await server.app.close();
  });
});
