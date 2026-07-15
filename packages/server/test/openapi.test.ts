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
});
