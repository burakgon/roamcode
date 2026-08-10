import { describe, expect, test } from "vitest";
import { buildOpenApiDocument, createClaudeProvider, createCodexProvider, ProviderRegistry } from "../src/index.js";

interface TestObject {
  [key: string]: unknown;
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, TestObject>;
  post: TestObject;
  requestBody: TestObject;
  content: Record<string, TestObject>;
  schema: TestObject;
  responses: Record<string, TestObject>;
}

function document() {
  const registry = new ProviderRegistry([
    createClaudeProvider({ claudeBin: "claude" }),
    createCodexProvider({ codexBin: "codex" }),
  ]);
  return {
    registry,
    value: buildOpenApiDocument({ serverVersion: "3.0.0", adapters: registry.descriptors() }) as {
      openapi: string;
      paths: Record<string, TestObject>;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, TestObject> };
      "x-roamcode-adapters": Array<{ id: string; source?: string }>;
    },
  };
}

describe("generated RoamCode OpenAPI", () => {
  test("documents the living v1 surface and omits removed experiments", () => {
    const { value } = document();
    expect(value.openapi).toBe("3.1.0");
    for (const path of [
      "/api/v1/capabilities",
      "/api/v1/hosts",
      "/api/v1/workspaces",
      "/api/v1/worktrees",
      "/api/v1/sessions",
      "/api/v1/sessions/{id}/agent-state",
      "/api/v1/sessions/{id}/input-lease",
      "/api/v1/sessions/{id}/input",
      "/api/v1/agents",
      "/api/v1/agents/{id}/wait",
      "/api/v1/agents/{id}/focus",
      "/api/v1/layout",
      "/api/v1/events",
      "/api/v1/events/stream",
      "/api/v1/devices",
      "/api/v1/presence",
      "/api/v1/presence/stream",
      "/api/v1/adapters",
    ]) {
      expect(value.paths[path], `missing ${path}`).toBeDefined();
    }
    for (const removed of [
      "/api/v1/attention",
      "/api/v1/automations",
      "/api/v1/audit",
      "/api/v1/team",
      "/api/v1/policy",
      "/api/v1/fleet",
      "/api/v1/peers",
      "/api/v1/extensions",
      "/api/v1/plugins",
    ]) {
      expect(value.paths).not.toHaveProperty(removed);
    }

    expect(value.components.securitySchemes.bearerAuth).toBeDefined();
    const sessionCreate = value.components.schemas.SessionCreate;
    expect(sessionCreate.required).toEqual(["cwd"]);
    expect(sessionCreate.additionalProperties).toBe(false);
    expect(Object.keys(sessionCreate.properties)).toEqual(["cwd", "mode"]);
    const adapter = value.components.schemas.AdapterDescriptor;
    expect(adapter.required).not.toContain("source");
    expect(adapter.properties).not.toHaveProperty("source");
    expect(value["x-roamcode-adapters"].map((item) => item.id)).toEqual(["claude", "codex"]);
    expect(value["x-roamcode-adapters"].every((item) => item.source === undefined)).toBe(true);
    expect(JSON.stringify(value)).not.toContain("?token=");
  });

  test("documents the personal Node and v2 Automation contract without access grants or aliases", () => {
    const { value } = document();
    for (const path of [
      "/api/v2/context",
      "/api/v2/nodes",
      "/api/v2/nodes/{nodeId}",
      "/api/v2/nodes/{nodeId}/runtimes",
      "/api/v2/nodes/{nodeId}/sessions",
      "/api/v2/automations",
      "/api/v2/automations/{automationId}",
      "/api/v2/automations/{automationId}/activity",
      "/api/v2/automations/{automationId}/triggers/{triggerId}/secret",
      "/api/v2/automations/{automationId}/runs",
      "/api/v2/automation-hooks/{hookId}",
    ]) {
      expect(value.paths[path], `missing ${path}`).toBeDefined();
    }
    expect(value.paths).not.toHaveProperty("/api/v2/nodes/{nodeId}/access-grants");

    const context = value.components.schemas.ProductContext;
    expect(context.properties.kind).toEqual({ const: "personal" });
    const node = value.components.schemas.Node;
    expect(node.required).toEqual(["id", "owner", "name", "status", "platform", "lastSeenAt"]);
    expect(node.properties).not.toHaveProperty("aliases");
    expect(node.properties.owner.properties.type).toEqual({ const: "person" });

    const nodeSession = value.paths["/api/v2/nodes/{nodeId}/sessions"].post;
    expect(nodeSession.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/V2SessionCreate",
    });
    expect(nodeSession.responses["201"].content["application/json"].schema.required).toEqual(["session"]);
    expect(value.components.schemas.V2SessionCreate.required).toEqual(["cwd"]);

    const automation = value.components.schemas.SessionAutomationDefinition;
    expect(automation.required).toEqual(
      expect.arrayContaining(["nodeId", "agentRuntimeId", "provider", "cwd", "instruction"]),
    );
    expect(automation.properties.owner.properties.type).toEqual({ const: "person" });
    expect(automation.properties.instruction["x-maxBytes"]).toBe(32 * 1024);
    expect(automation.properties.runtimeOptions["x-maxBytes"]).toBe(64 * 1024);
    expect(value.components.schemas.SessionAutomationCreate.properties).not.toHaveProperty("provider");
    expect(JSON.stringify(value.components.schemas.SessionAutomationConfiguredTrigger)).not.toContain("secretHash");
    expect(value.components.schemas).not.toHaveProperty("NodeAccessGrant");
    expect(value.components.schemas).not.toHaveProperty("TeamEnvelope");
    expect(value.components.schemas).not.toHaveProperty("EnterprisePolicy");
  });
});
