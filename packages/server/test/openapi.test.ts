import { describe, expect, test } from "vitest";
import { buildOpenApiDocument, createClaudeProvider, createCodexProvider, ProviderRegistry } from "../src/index.js";

describe("generated command-center OpenAPI", () => {
  test("documents every stable v1 product resource and the non-stealing agent operations", () => {
    const registry = new ProviderRegistry([
      createClaudeProvider({ claudeBin: "claude" }),
      createCodexProvider({ codexBin: "codex" }),
    ]);
    const document = buildOpenApiDocument({ serverVersion: "1.2.3", adapters: registry.descriptors() }) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
      "x-roamcode-adapters": Array<{ id: string }>;
    };
    expect(document.openapi).toBe("3.1.0");
    for (const path of [
      "/api/v1/hosts",
      "/api/v1/workspaces",
      "/api/v1/sessions",
      "/api/v1/agents",
      "/api/v1/attention",
      "/api/v1/devices",
      "/api/v1/relay/pairing",
      "/api/v1/relay/pairing/cancel",
      "/api/v1/relay/status",
      "/api/v1/cloud/status",
      "/api/v1/team",
      "/api/v1/team/members",
      "/api/v1/team/roles",
      "/api/v1/team/principals",
      "/api/v1/policy",
      "/api/v1/fleet",
      "/api/v1/peers",
      "/api/v1/peers/{id}",
      "/api/v1/peers/{id}/verify",
      "/api/v1/peers/{id}/discover",
      "/api/v1/peers/{id}/credential",
      "/api/v1/peers/{peerId}/workspaces",
      "/api/v1/peers/{peerId}/agents",
      "/api/v1/peers/{peerId}/sessions",
      "/api/v1/presence",
      "/api/v1/presence/stream",
      "/api/v1/adapters",
      "/api/v1/automations",
      "/api/v1/events/stream",
      "/api/v1/audit",
      "/api/v1/audit/verify",
      "/api/v1/audit/export",
    ]) {
      expect(document.paths[path], `missing ${path}`).toBeDefined();
    }
    expect(document.paths["/api/v1/sessions/{id}/input"]?.post).toBeDefined();
    expect(document.paths["/api/v1/sessions/{id}/input-lease"]?.get).toBeDefined();
    expect(document.paths["/api/v1/sessions/{id}/input-lease"]?.post).toBeDefined();
    expect(document.paths["/api/v1/agents/{id}/wait"]?.get).toBeDefined();
    expect(document.paths["/api/v1/agents/{id}/focus"]?.post).toBeDefined();
    expect(document.paths["/api/v1/peers/{peerId}/sessions/{sessionId}/input"]?.post).toBeDefined();
    expect(document.paths["/api/v1/peers/{peerId}/sessions/{sessionId}/input-lease"]?.get).toBeDefined();
    expect(document.paths["/api/v1/peers/{peerId}/sessions/{sessionId}/input-lease"]?.post).toBeDefined();
    expect(document.paths["/api/v1/peers/{peerId}/agents/{agentId}/wait"]?.get).toBeDefined();
    expect(document.paths["/api/v1/peers/{peerId}/agents/{agentId}/focus"]?.post).toBeDefined();
    expect(document.components.securitySchemes.bearerAuth).toBeDefined();
    expect(document.components.schemas.AdapterManifestV1).toBeDefined();
    expect(document.components.schemas.AdapterDescriptor).toBeDefined();
    expect(document.components.schemas.InputLeaseRequest).toBeDefined();
    expect(document.components.schemas.InputLeaseGrant).toBeDefined();
    expect(document.components.schemas.TeamEnvelope).toBeDefined();
    expect(document.components.schemas.TeamRoleBinding).toBeDefined();
    expect(document.components.schemas.EnterprisePolicy).toBeDefined();
    expect(document.components.schemas.EnterprisePolicyPatch).toBeDefined();
    expect(document.components.schemas.FleetInventory).toBeDefined();
    expect(document.components.schemas.FleetHost).toBeDefined();
    expect(document.components.schemas.PeerRecord).toBeDefined();
    expect(document.components.schemas.PeerCreate).toBeDefined();
    expect(document.components.schemas.PeerUpdate).toBeDefined();
    expect(document.components.schemas.PeerSessionCreate).toBeDefined();
    expect(document.components.schemas.PeerDiscovery).toBeDefined();
    const peerRecord = document.components.schemas.PeerRecord as { properties: Record<string, unknown> };
    expect(peerRecord.properties).not.toHaveProperty("credential");
    expect(peerRecord.properties).not.toHaveProperty("baseUrl");
    const peerCreate = document.components.schemas.PeerCreate as {
      oneOf: Array<{ required: string[] }>;
      properties: Record<string, { writeOnly?: boolean }>;
    };
    expect(peerCreate.oneOf.map((branch) => branch.required)).toEqual([["pairingUrl"], ["baseUrl", "credential"]]);
    expect(peerCreate.properties.pairingUrl?.writeOnly).toBe(true);
    expect(peerCreate.properties.credential?.writeOnly).toBe(true);
    expect(document.components.schemas.AuditRecord).toBeDefined();
    expect(document.components.schemas.AuditVerification).toBeDefined();
    expect(document.components.schemas.PresenceHeartbeat).toBeDefined();
    expect(document.components.schemas.Presence).toBeDefined();
    expect(document.components.schemas.RelayPairingPackage).toBeDefined();
    expect(document.components.schemas.RelayStatus).toBeDefined();
    const sessionCreate = document.components.schemas.SessionCreate as {
      oneOf: Array<{ properties: { provider: { const: string }; options: Record<string, unknown> } }>;
    };
    expect(sessionCreate.oneOf.map((schema) => schema.properties.provider.const)).toEqual(["claude", "codex"]);
    expect(sessionCreate.oneOf.every((schema) => schema.properties.options.type === "object")).toBe(true);
    expect(document["x-roamcode-adapters"].map((adapter) => adapter.id)).toEqual(["claude", "codex"]);
    expect(JSON.stringify(document)).not.toContain("?token=");

    registry.setEnabled("codex", false);
    const disabledDocument = buildOpenApiDocument({ serverVersion: "1.2.3", adapters: registry.descriptors() }) as {
      components: {
        schemas: {
          SessionCreate: { oneOf: Array<{ properties: { provider: { const: string } } }> };
        };
      };
      "x-roamcode-adapters": Array<{ id: string; enabled: boolean }>;
    };
    expect(
      disabledDocument.components.schemas.SessionCreate.oneOf.map((schema) => schema.properties.provider.const),
    ).toEqual(["claude"]);
    expect(disabledDocument["x-roamcode-adapters"].find((adapter) => adapter.id === "codex")?.enabled).toBe(false);
  });

  test("documents the additive node-first v2 contract without legacy placement identifiers", () => {
    const registry = new ProviderRegistry([
      createClaudeProvider({ claudeBin: "claude" }),
      createCodexProvider({ codexBin: "codex" }),
    ]);
    const document = buildOpenApiDocument({ serverVersion: "1.2.3", adapters: registry.descriptors() }) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            requestBody?: { content: { "application/json": { schema: { $ref: string } } } };
            responses?: Record<string, unknown>;
          }
        >
      >;
      components: {
        schemas: Record<
          string,
          {
            required?: string[];
            properties?: Record<string, unknown>;
            additionalProperties?: boolean;
          }
        >;
      };
    };

    for (const path of [
      "/api/v2/context",
      "/api/v2/nodes",
      "/api/v2/nodes/{nodeId}",
      "/api/v2/nodes/{nodeId}/runtimes",
      "/api/v2/nodes/{nodeId}/sessions",
      "/api/v2/nodes/{nodeId}/access-grants",
      "/api/v2/nodes/{nodeId}/access-grants/{grantId}",
      "/api/v2/automations",
      "/api/v2/automations/{automationId}",
      "/api/v2/automations/{automationId}/activity",
      "/api/v2/automations/{automationId}/triggers/{triggerId}/secret",
      "/api/v2/automations/{automationId}/runs",
      "/api/v2/automation-hooks/{hookId}",
    ]) {
      expect(document.paths[path], `missing ${path}`).toBeDefined();
    }
    expect(document.paths["/api/v2/nodes/{nodeId}/sessions"]?.get?.operationId).toBe("listNodeSessionsV2");
    expect(
      document.paths["/api/v2/nodes/{nodeId}/sessions"]?.post?.requestBody?.content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/V2SessionCreate" });
    const nodeSessionCreated = document.paths["/api/v2/nodes/{nodeId}/sessions"]?.post?.responses?.["201"] as {
      content: { "application/json": { schema: { required: string[]; properties: Record<string, unknown> } } };
    };
    expect(nodeSessionCreated.content["application/json"].schema.required).toEqual(["session"]);
    expect(nodeSessionCreated.content["application/json"].schema.properties).toHaveProperty("rememberedSessionOptions");
    expect(nodeSessionCreated.content["application/json"].schema.properties).toHaveProperty("warnings");
    expect(document.paths["/api/v2/automations/{automationId}"]?.get).toBeDefined();
    expect(document.paths["/api/v2/automations/{automationId}"]?.patch).toBeDefined();
    expect(document.paths["/api/v2/automations/{automationId}"]?.delete).toBeDefined();
    expect(document.paths["/api/v2/automations/{automationId}/runs"]?.get).toBeDefined();
    expect(document.paths["/api/v2/automations/{automationId}/runs"]?.post?.responses).toHaveProperty("201");
    expect(document.paths["/api/v2/automation-hooks/{hookId}"]?.post?.responses).toHaveProperty("202");
    const automationCreated = document.paths["/api/v2/automations"]?.post?.responses?.["201"] as {
      content: { "application/json": { schema: { required: string[] } } };
    };
    expect(automationCreated.content["application/json"].schema.required).toEqual(["automation", "webhookSecrets"]);
    const manualRunCreated = document.paths["/api/v2/automations/{automationId}/runs"]?.post?.responses?.["201"] as {
      content: { "application/json": { schema: { required: string[]; properties: Record<string, unknown> } } };
    };
    expect(manualRunCreated.content["application/json"].schema.required).toEqual(["run", "session"]);
    expect(manualRunCreated.content["application/json"].schema.properties).toHaveProperty("session");
    const bootstrapFailed = document.paths["/api/v2/automations/{automationId}/runs"]?.post?.responses?.["502"] as {
      content: {
        "application/json": { schema: { required: string[]; properties: Record<string, unknown> } };
      };
    };
    expect(bootstrapFailed.content["application/json"].schema.required).toEqual(["code", "error", "run"]);
    expect(bootstrapFailed.content["application/json"].schema.properties).toHaveProperty("session");

    for (const schema of [
      "ProductContext",
      "Node",
      "AgentRuntime",
      "NodeAccessGrant",
      "V2Session",
      "V2SessionCreate",
      "SessionAutomationDefinition",
      "SessionAutomationConfiguredTrigger",
      "SessionAutomationWebhookSecret",
      "SessionAutomationActivity",
      "SessionAutomationRun",
    ]) {
      expect(document.components.schemas[schema], `missing ${schema}`).toBeDefined();
    }

    const node = document.components.schemas.Node;
    expect(node.required).toEqual(["id", "owner", "name", "status", "platform", "lastSeenAt", "aliases"]);
    expect(node.additionalProperties).toBe(false);

    const runtime = document.components.schemas.AgentRuntime;
    expect(runtime.required).toEqual(
      expect.arrayContaining(["nodeId", "provider", "availability", "authState", "activeSessionCount", "observedAt"]),
    );
    expect(runtime.properties).not.toHaveProperty("detail");
    expect(runtime.properties).not.toHaveProperty("cwd");
    expect(runtime.properties).not.toHaveProperty("optionSchema");

    const session = document.components.schemas.V2Session;
    expect(session.required).toEqual(expect.arrayContaining(["nodeId", "agentRuntimeId", "provider", "cwd"]));
    expect(session.additionalProperties).toBe(false);
    expect(session.properties).not.toHaveProperty("workspaceId");
    expect(session.properties).not.toHaveProperty("agentId");
    expect(session.properties).not.toHaveProperty("projectId");

    const sessionCreate = document.components.schemas.V2SessionCreate;
    expect(sessionCreate.required).toEqual(["agentRuntimeId", "cwd"]);
    expect(Object.keys(sessionCreate.properties ?? {})).toEqual(["agentRuntimeId", "cwd", "runtimeOptions"]);
    expect(sessionCreate.properties).not.toHaveProperty("provider");
    expect(sessionCreate.properties).not.toHaveProperty("workspaceId");

    const automation = document.components.schemas.SessionAutomationDefinition;
    expect(automation.required).toEqual(
      expect.arrayContaining(["nodeId", "agentRuntimeId", "provider", "cwd", "instruction"]),
    );
    expect(automation.additionalProperties).toBe(false);
    expect(automation.properties?.runtimeId).toBeUndefined();
    const instruction = automation.properties?.instruction as { maxLength: number; "x-maxBytes": number };
    expect(instruction.maxLength).toBe(32 * 1024);
    expect(instruction["x-maxBytes"]).toBe(32 * 1024);
    expect((automation.properties?.runtimeOptions as { "x-maxBytes": number })["x-maxBytes"]).toBe(64 * 1024);
    expect(JSON.stringify(document.components.schemas.SessionAutomationConfiguredTrigger)).not.toContain("secretHash");
    const automationCreate = document.components.schemas.SessionAutomationCreate;
    expect(automationCreate.required).toEqual(["name", "nodeId", "agentRuntimeId", "cwd", "instruction"]);
    expect(automationCreate.properties).not.toHaveProperty("provider");
    expect((automationCreate.properties?.instruction as { "x-maxBytes": number })["x-maxBytes"]).toBe(32 * 1024);
    expect((automationCreate.properties?.runtimeOptions as { "x-maxBytes": number })["x-maxBytes"]).toBe(64 * 1024);
    expect(document.components.schemas.SessionAutomationPatch.properties).not.toHaveProperty("provider");
    expect(
      (document.components.schemas.SessionAutomationPatch.properties?.runtimeOptions as { "x-maxBytes": number })[
        "x-maxBytes"
      ],
    ).toBe(64 * 1024);
    const trigger = document.components.schemas.SessionAutomationTrigger as {
      properties: { type: { const: string } };
    };
    expect(trigger.properties.type.const).toBe("manual");
    const automationRun = document.components.schemas.SessionAutomationRun;
    const runStatus = automationRun.properties?.status as { enum: string[] };
    expect(automationRun.required).toEqual([
      "id",
      "automationId",
      "definitionRevision",
      "invocationId",
      "sessionId",
      "nodeId",
      "agentRuntimeId",
      "cwd",
      "status",
      "createdAt",
      "updatedAt",
    ]);
    expect(runStatus.enum).toEqual(["starting", "running", "needs-input", "ready", "failed", "cancelled"]);

    const grantRole = document.components.schemas.NodeAccessGrant.properties?.role as { enum: string[] };
    const grantCreateRole = document.components.schemas.NodeAccessGrantCreate.properties?.role as { enum: string[] };
    expect(grantRole.enum).toEqual(["viewer", "operator", "admin"]);
    expect(grantCreateRole.enum).toEqual(grantRole.enum);
    const grantSource = document.components.schemas.NodeAccessGrant.properties?.source as { enum: string[] };
    const subjectType = document.components.schemas.NodeAccessSubject.properties?.type as { enum: string[] };
    expect(grantSource.enum).toEqual(["local-implicit", "team", "cloud"]);
    expect(subjectType.enum).toEqual(["member", "device", "service-account", "relay"]);
    const createSubject = document.components.schemas.NodeAccessGrantCreate.properties?.subject as {
      properties: { type: { const: string } };
    };
    expect(createSubject.properties.type.const).toBe("member");

    // The additive v2 contract must not rewrite the existing v1 launch or Agent projections.
    const v1SessionCreate = document.components.schemas.SessionCreate as {
      oneOf: Array<{ required: string[]; properties: Record<string, unknown> }>;
    };
    expect(v1SessionCreate.oneOf.every((branch) => branch.required.includes("provider"))).toBe(true);
    expect(document.components.schemas.Agent.required).toContain("workspaceId");
  });
});
