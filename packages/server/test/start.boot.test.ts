import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CLOUD_AUTHORIZATION_KEYSET_PATH,
  CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN,
  CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN,
  CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH,
  CLOUD_HOST_HEARTBEAT_PATH,
  CloudHostConfigV1Schema,
  cloudHostCapabilities,
  startServer,
  writeCloudHostConfig,
} from "../src/index.js";
import {
  cloudAuthorizationKeyset,
  cloudAuthorizationKeysetKey,
  cloudAuthorizationSnapshot,
  cloudSigningFixture,
  signCloudAuthorizationKeyset,
  signCloudAuthorizationSnapshot,
} from "./helpers/cloud-authorization.js";

let dir: string;
let running: Awaited<ReturnType<typeof startServer>> | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-boot-"));
});
afterEach(async () => {
  if (running) await running.app.close();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Env that drives startServer against the interactive mock on a sandboxed data dir. */
function envFor(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: "0",
    BIND_ADDRESS: "127.0.0.1",
    CLAUDE_BIN: process.execPath,
    CODEX_BIN: process.execPath,
    ROAMCODE_DATA_DIR: dir,
    ...extra,
  } as NodeJS.ProcessEnv;
}

test("advertises managed enrollment only when the Node has the complete relay enrollment stack", () => {
  expect(
    cloudHostCapabilities({
      authorizationVersion: 1,
      terminalAvailable: true,
      relayEnabled: true,
      managedDeviceEnrollmentEnabled: false,
    }),
  ).toEqual(["authorization.v1", "terminal.v1", "relay.v1"]);
  expect(
    cloudHostCapabilities({
      authorizationVersion: 1,
      terminalAvailable: true,
      relayEnabled: true,
      managedDeviceEnrollmentEnabled: true,
    }),
  ).toEqual(["authorization.v1", "terminal.v1", "relay.v1", "managed-device-enrollment.v1"]);
  expect(
    cloudHostCapabilities({
      authorizationVersion: 1,
      terminalAvailable: false,
      relayEnabled: true,
      managedDeviceEnrollmentEnabled: true,
    }),
  ).toEqual(["authorization.v1", "relay.v1"]);
});

test("first run on loopback generates + persists + reports a token", async () => {
  running = await startServer(envFor());
  expect(running.cloudHostRuntime).toBeUndefined();
  expect(running.tokenGenerated).toBe(true);
  expect(typeof running.token).toBe("string");
  expect((running.token ?? "").length).toBeGreaterThan(20);

  // Persisted to the data dir so the SECOND boot reuses it (not regenerated).
  const persisted = (await readFile(join(dir, "token"), "utf8")).trim();
  expect(persisted).toBe(running.token);

  // The token actually gates: an unauthenticated request is rejected.
  const res = await running.app.inject({ method: "GET", url: "/sessions" });
  expect(res.statusCode).toBe(401);
  const ok = await running.app.inject({
    method: "GET",
    url: "/sessions",
    headers: { authorization: `Bearer ${running.token}` },
  });
  expect(ok.statusCode).toBe(200);

  const health = await running.app.inject({ method: "GET", url: "/health" });
  expect(health.statusCode).toBe(200);
  expect(health.headers["x-roamcode-instance"]).toMatch(/^[a-f0-9-]{36}$/);
  expect(health.headers["cache-control"]).toBe("no-store");
});

test("second boot reuses the persisted token (tokenGenerated false)", async () => {
  const first = await startServer(envFor());
  const token = first.token;
  await first.app.close();

  running = await startServer(envFor());
  expect(running.tokenGenerated).toBe(false);
  expect(running.token).toBe(token);
});

test("NO_TOKEN=1 on loopback boots tokenless (no token required)", async () => {
  running = await startServer(envFor({ NO_TOKEN: "1" }));
  expect(running.token).toBeUndefined();
  expect(running.tokenGenerated).toBe(false);
  // No token configured -> the gate allows.
  const res = await running.app.inject({ method: "GET", url: "/sessions" });
  expect(res.statusCode).toBe(200);
});

test("a separate cloud-host config starts heartbeat and signed authorization synchronization", async () => {
  const now = Date.now();
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const hostId = "22222222-2222-4222-8222-222222222222";
  const signing = cloudSigningFixture("startup-key");
  const keyset = cloudAuthorizationKeyset(
    [cloudAuthorizationKeysetKey(signing, { status: "current", notBefore: now - 1_000 })],
    { issuedAt: now - 1_000, expiresAt: now + 600_000 },
  );
  const config = CloudHostConfigV1Schema.parse({
    v: 1,
    kind: "roamcode-cloud-host-config",
    organizationId,
    hostId,
    controlPlaneOrigin: "https://control.roamcode.ai",
    hostCredential: `rch_${"a".repeat(64)}`,
    authorization: {
      algorithm: "Ed25519",
      signatureDomain: CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN,
      keysetSignatureDomain: CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN,
      keyset,
    },
    heartbeatIntervalSeconds: 30,
    authorizationRefreshIntervalSeconds: 60,
  });
  writeCloudHostConfig(join(dir, "cloud-host.json"), config);
  const signedSnapshot = signCloudAuthorizationSnapshot(
    cloudAuthorizationSnapshot({
      organizationId,
      hostId,
      revision: 1,
      issuedAt: now,
      notBefore: now,
      expiresAt: now + 300_000,
    }),
    signing,
  );
  const urls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith(CLOUD_HOST_HEARTBEAT_PATH)) return new Response(null, { status: 204 });
    if (url.endsWith(CLOUD_AUTHORIZATION_KEYSET_PATH))
      return Response.json(signCloudAuthorizationKeyset(keyset, [signing]));
    if (url.includes(CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH)) return Response.json(signedSnapshot);
    throw new Error(`unexpected cloud request: ${url}`);
  }) as typeof globalThis.fetch;

  running = await startServer(envFor(), { fetch });
  expect(running.cloudHostRuntime).toBeDefined();
  await vi.waitFor(() => {
    expect(running?.cloudHostRuntime?.status().authorization).toMatchObject({ status: "active", revision: 1 });
  });
  const status = await running.app.inject({
    method: "GET",
    url: "/api/v1/cloud/status",
    headers: { authorization: `Bearer ${running.token}` },
  });
  expect(status.json()).toMatchObject({
    v: 1,
    mode: "managed",
    configured: true,
    sync: { state: "healthy" },
    authorization: { status: "active", revision: 1, expired: false },
    action: "none",
  });
  expect(urls).toEqual(
    expect.arrayContaining([
      `https://control.roamcode.ai${CLOUD_HOST_HEARTBEAT_PATH}`,
      `https://control.roamcode.ai${CLOUD_AUTHORIZATION_KEYSET_PATH}`,
      `https://control.roamcode.ai${CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH}`,
    ]),
  );

  const auth = { authorization: `Bearer ${running.token}` };
  const nodes = await running.app.inject({ method: "GET", url: "/api/v2/nodes", headers: auth });
  const nodeId = nodes.json().nodes[0].id as string;
  const runtimes = await running.app.inject({
    method: "GET",
    url: `/api/v2/nodes/${nodeId}/runtimes`,
    headers: auth,
  });
  const runtimeId = (runtimes.json().runtimes as Array<{ id: string; provider: string }>).find(
    (runtime) => runtime.provider === "claude",
  )!.id;
  const automation = await running.app.inject({
    method: "POST",
    url: "/api/v2/automations",
    headers: auth,
    payload: {
      name: "Persist managed ownership",
      nodeId,
      agentRuntimeId: runtimeId,
      cwd: process.cwd(),
      instruction: "Keep this definition attached to the managed organization.",
    },
  });
  expect(automation.statusCode).toBe(201);
  expect(automation.json().automation).toMatchObject({
    owner: { type: "organization", id: organizationId },
    revision: 1,
  });

  await running.app.close();
  running = await startServer(envFor(), { fetch });
  const restartedAuth = { authorization: `Bearer ${running.token}` };
  const afterManagedRestart = await running.app.inject({
    method: "GET",
    url: "/api/v2/automations",
    headers: restartedAuth,
  });
  expect(afterManagedRestart.json().automations).toEqual([
    expect.objectContaining({ owner: { type: "organization", id: organizationId }, revision: 1 }),
  ]);

  await running.app.close();
  await rm(join(dir, "cloud-host.json"), { force: true });
  running = await startServer(envFor());
  const detachedAuth = { authorization: `Bearer ${running.token}` };
  const detachedContext = await running.app.inject({ method: "GET", url: "/api/v2/context", headers: detachedAuth });
  expect(detachedContext.json()).toEqual({
    context: { kind: "organization", id: organizationId, name: "Organization" },
  });
  const afterConfigRemoval = await running.app.inject({
    method: "GET",
    url: "/api/v2/automations",
    headers: detachedAuth,
  });
  expect(afterConfigRemoval.json().automations).toEqual([
    expect.objectContaining({ owner: { type: "organization", id: organizationId }, revision: 1 }),
  ]);
});
