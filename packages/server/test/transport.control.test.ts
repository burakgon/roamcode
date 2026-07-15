import { afterEach, describe, expect, test } from "vitest";
import {
  createServer,
  openCommandCenterStore,
  openControlStore,
  type ControlStore,
  type CommandCenterStore,
  type CreateServerResult,
  type ServerRuntimeConfig,
} from "../src/index.js";

const TOKEN = "host-token";
let result: CreateServerResult | undefined;
let control: ControlStore | undefined;
let command: CommandCenterStore | undefined;

afterEach(async () => {
  await result?.app.close();
  result = undefined;
  control = undefined;
  command = undefined;
});

function config(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    dataDir: process.cwd(),
    maxUploadBytes: 1024,
    allowedOrigins: [],
    rateLimitRpm: 0,
    rateLimitBurst: 120,
    maxSessions: 25,
    codexBin: process.execPath,
    claude: { claudeBin: process.execPath },
  };
}

function makeServer(): CreateServerResult {
  control = openControlStore({ dbPath: ":memory:" });
  command = openCommandCenterStore({
    dbPath: ":memory:",
    generateHostId: () => "host-1",
    generateWorkspaceId: () => "workspace-1",
    generateAttentionId: () => "attention-1",
  });
  return createServer(config(), { terminalAvailable: false, controlStore: control, commandStore: command });
}

describe("v1 control-plane middleware", () => {
  test("replays an identical mutation for one actor and rejects key reuse with another payload", async () => {
    result = makeServer();
    const request = (label: string) =>
      result!.app.inject({
        method: "PATCH",
        url: "/api/v1/host",
        headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "rename-host-1" },
        payload: { label },
      });

    const first = await request("Studio");
    expect(first.statusCode).toBe(200);
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    const replay = await request("Studio");
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());

    const conflict = await request("Different studio");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("rejects malformed keys and records only privacy-safe mutation audit data", async () => {
    result = makeServer();
    const malformed = await result.app.inject({
      method: "PATCH",
      url: "/api/v1/host",
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "spaces are not accepted" },
      payload: { label: "Studio" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe("INVALID_IDEMPOTENCY_KEY");

    const changed = await result.app.inject({
      method: "PATCH",
      url: "/api/v1/host",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { label: "Studio" },
    });
    expect(changed.statusCode).toBe(200);
    const audit = control!.listAudit();
    expect(audit).toHaveLength(2);
    expect(audit.at(-1)).toMatchObject({
      actorType: "host",
      actorId: "host-1",
      action: "PATCH /api/v1/host",
      targetType: "host",
      result: "success",
      metadata: { statusCode: 200 },
    });
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    expect(JSON.stringify(audit)).not.toContain("Studio");
    expect(control!.verifyAuditChain().valid).toBe(true);
  });

  test("exports a bounded privacy-safe NDJSON audit page with a verified chain manifest", async () => {
    result = makeServer();
    const changed = await result.app.inject({
      method: "PATCH",
      url: "/api/v1/host",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { label: "Private workstation label" },
    });
    expect(changed.statusCode).toBe(200);

    const exported = await result.app.inject({
      method: "GET",
      url: "/api/v1/audit/export?after=0&limit=10",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/x-ndjson");
    expect(exported.headers["content-disposition"]).toBe('attachment; filename="roamcode-audit.ndjson"');
    expect(exported.headers["cache-control"]).toBe("no-store");
    const lines = exported.body
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      type: "manifest",
      schemaVersion: 1,
      range: { after: 0, limit: 10, count: 1, nextCursor: 1 },
      integrity: { algorithm: "sha256-chain", valid: true, count: 1 },
    });
    expect(lines[1]).toMatchObject({
      type: "record",
      record: { id: 1, action: "PATCH /api/v1/host", result: "success" },
    });
    expect(exported.body).not.toContain(TOKEN);
    expect(exported.body).not.toContain("Private workstation label");

    const latest = await result.app.inject({
      method: "GET",
      url: "/api/v1/audit?order=latest&limit=1",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({ records: [{ id: 1 }], nextCursor: 1 });

    const invalid = await result.app.inject({
      method: "GET",
      url: "/api/v1/audit/export?limit=1001",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("INVALID_AUDIT_CURSOR");
  });

  test("runs a permissioned event automation, persists its run, and exposes v1 resource inventories", async () => {
    result = makeServer();
    const created = await result.app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "automation-create-1" },
      payload: {
        name: "Resolve acknowledged decisions",
        trigger: { eventType: "attention.acknowledged", resourceType: "attention" },
        action: { type: "resolve_attention", target: "event-resource" },
        permissions: ["attention:write"],
      },
    });
    expect(created.statusCode).toBe(201);
    const automationId = created.json().automation.id as string;

    const placement = command!.ensureSession("session-1", process.cwd(), 1);
    command!.upsertAgent(
      {
        sessionId: "session-1",
        workspaceId: placement.workspaceId,
        provider: "claude",
        activity: "blocked",
        createdAt: 1,
      },
      2,
    );
    command!.recordAttention(
      {
        workspaceId: placement.workspaceId,
        sessionId: "session-1",
        agentId: placement.agentId,
        kind: "blocked",
        title: "Decision needed",
        dedupeKey: "blocked:session-1",
      },
      3,
    );

    const acknowledged = await result.app.inject({
      method: "PATCH",
      url: "/api/v1/attention/attention-1",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { action: "acknowledge" },
    });
    expect(acknowledged.statusCode).toBe(200);
    await Promise.resolve();
    await Promise.resolve();

    const attention = await result.app.inject({
      method: "GET",
      url: "/api/v1/attention?includeResolved=1",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(attention.json().items[0]).toMatchObject({ id: "attention-1", state: "resolved" });

    const runs = await result.app.inject({
      method: "GET",
      url: `/api/v1/automations/${automationId}/runs`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(runs.json().runs[0]).toMatchObject({ automationId, status: "succeeded" });
    expect(control!.listAudit().some((record) => record.actorType === "automation")).toBe(true);

    const [hosts, adapters, devices] = await Promise.all(
      ["/api/v1/hosts", "/api/v1/adapters", "/api/v1/devices"].map((url) =>
        result!.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } }),
      ),
    );
    expect(hosts.json().hosts).toHaveLength(1);
    expect(adapters.json().adapters.map((adapter: { id: string }) => adapter.id)).toEqual(["claude", "codex"]);
    expect(devices.json().devices).toEqual([]);
  });
});
