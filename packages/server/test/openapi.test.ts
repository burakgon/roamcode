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
  oneOf: TestObject[];
}

function document() {
  const registry = new ProviderRegistry([
    createClaudeProvider({ claudeBin: "claude" }),
    createCodexProvider({ codexBin: "codex" }),
  ]);
  return buildOpenApiDocument({ serverVersion: "4.0.0", adapters: registry.descriptors() }) as {
    openapi: string;
    paths: Record<string, TestObject>;
    components: { securitySchemes: Record<string, unknown>; schemas: Record<string, TestObject> };
    "x-roamcode-adapters": Array<{ id: string; source?: string }>;
  };
}

describe("generated RoamCode OpenAPI", () => {
  test("documents the living Session surface", () => {
    const value = document();
    expect(value.openapi).toBe("3.1.0");
    for (const path of [
      "/api/v1/capabilities",
      "/api/v1/hosts",
      "/api/v1/workspaces",
      "/api/v1/worktrees",
      "/api/v1/sessions",
      "/api/v1/sessions/{id}/agent-state",
      "/api/v1/sessions/{id}/input",
      "/api/v1/agents",
      "/api/v1/layout",
      "/api/v1/events",
      "/api/v1/devices",
      "/api/v1/presence",
      "/api/v1/adapters",
      "/api/v2/context",
      "/api/v2/nodes",
      "/api/v2/nodes/{nodeId}/runtimes",
      "/api/v2/nodes/{nodeId}/sessions",
    ]) {
      expect(value.paths[path], `missing ${path}`).toBeDefined();
    }

    expect(JSON.stringify(value)).not.toContain("?token=");
  });

  test("keeps Session creation terminal-only and exposes no launch owner", () => {
    const value = document();
    const sessionCreate = value.components.schemas.SessionCreate;
    expect(sessionCreate.required).toEqual(["cwd"]);
    expect(sessionCreate.additionalProperties).toBe(false);
    expect(Object.keys(sessionCreate.properties)).toEqual(["cwd", "mode"]);

    const nodeSession = value.paths["/api/v2/nodes/{nodeId}/sessions"].post;
    expect(nodeSession.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/V2SessionCreate",
    });
    expect(nodeSession.responses["201"].content["application/json"].schema.required).toEqual(["session"]);
    expect(value.components.schemas.V2SessionCreate.required).toEqual(["cwd"]);

    const managedLaunch = value.components.schemas.TerminalLaunch.oneOf[1];
    expect(managedLaunch.required).toEqual(["kind", "provider"]);
    expect(managedLaunch.properties).not.toHaveProperty("owner");
  });

  test("keeps the personal Node and adapter contracts privacy-bounded", () => {
    const value = document();
    expect(value.components.securitySchemes.bearerAuth).toBeDefined();
    expect(value.components.schemas.ProductContext.properties.kind).toEqual({ const: "personal" });
    const node = value.components.schemas.Node;
    expect(node.required).toEqual(["id", "owner", "name", "status", "platform", "lastSeenAt"]);
    expect(node.properties).not.toHaveProperty("aliases");
    expect(node.properties.owner.properties.type).toEqual({ const: "person" });

    const adapter = value.components.schemas.AdapterDescriptor;
    expect(adapter.required).not.toContain("source");
    expect(adapter.properties).not.toHaveProperty("source");
    expect(value["x-roamcode-adapters"].map((item) => item.id)).toEqual(["claude", "codex"]);
    expect(value["x-roamcode-adapters"].every((item) => item.source === undefined)).toBe(true);
    expect(value.components.schemas).not.toHaveProperty("NodeAccessGrant");
    expect(value.components.schemas).not.toHaveProperty("TeamEnvelope");
    expect(value.components.schemas).not.toHaveProperty("EnterprisePolicy");
  });
});
