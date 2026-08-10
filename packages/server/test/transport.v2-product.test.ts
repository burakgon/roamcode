import { afterEach, describe, expect, test } from "vitest";
import { agentRuntimeId, openCommandCenterStore } from "../src/index.js";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.app.close()));
});

async function productServer(codexAccount?: "ready" | "required" | "error") {
  const commandStore = openCommandCenterStore({
    dbPath: ":memory:",
    generateHostId: () => "node-local",
    generateWorkspaceId: () => "workspace-local",
  });
  const server = await buildTestServer({
    terminalAvailable: true,
    deps: {
      commandStore,
      ...(codexAccount
        ? {
            codexMetadata: {
              getAccount: async () => {
                if (codexAccount === "error") throw new Error("metadata unavailable");
                return { authenticated: codexAccount === "ready", authMethod: "chatgpt" as const };
              },
            } as never,
          }
        : {}),
    },
  });
  servers.push(server);
  return server;
}

describe("v2 Node product surface", () => {
  test("projects context, Node, runtimes, and neutral terminal Sessions", async () => {
    const server = await productServer();
    const auth = { authorization: `Bearer ${server.token}` };

    const context = await server.app.inject({ method: "GET", url: "/api/v2/context", headers: auth });
    expect(context.json()).toEqual({ context: { kind: "personal", id: "node-local", name: "Personal" } });

    const nodes = await server.app.inject({ method: "GET", url: "/api/v2/nodes", headers: auth });
    expect(nodes.json().nodes).toEqual([
      expect.objectContaining({
        id: "node-local",
        owner: { type: "person", id: "node-local" },
        status: "online",
        platform: `${process.platform}-${process.arch}`,
      }),
    ]);

    const runtimes = await server.app.inject({
      method: "GET",
      url: "/api/v2/nodes/node-local/runtimes",
      headers: auth,
    });
    expect(runtimes.json().runtimes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: agentRuntimeId("node-local", "claude"),
          nodeId: "node-local",
          provider: "claude",
          capabilities: expect.arrayContaining(["launch"]),
        }),
      ]),
    );
    expect(runtimes.body).not.toMatch(/detail|secret|token|private\/bin/i);

    const created = await server.app.inject({
      method: "POST",
      url: "/api/v2/nodes/node-local/sessions",
      headers: auth,
      payload: { cwd: process.cwd() },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().session).toMatchObject({
      nodeId: "node-local",
      launch: { kind: "shell" },
      cwd: process.cwd(),
      workspaceId: "workspace-local",
    });
    expect(created.json().session).not.toHaveProperty("agentRuntimeId");
    expect(created.json().session).not.toHaveProperty("provider");

    const listed = await server.app.inject({
      method: "GET",
      url: "/api/v2/nodes/node-local/sessions",
      headers: auth,
    });
    expect(listed.json().sessions).toEqual([
      expect.objectContaining({ nodeId: "node-local", launch: { kind: "shell" } }),
    ]);
  });

  test.each([
    ["ready", "ready"],
    ["required", "required"],
    ["error", "error"],
  ] as const)("projects Codex account state %s without exposing account metadata", async (account, authState) => {
    const server = await productServer(account);
    const response = await server.app.inject({
      method: "GET",
      url: "/api/v2/nodes/node-local/runtimes",
      headers: { authorization: `Bearer ${server.token}` },
    });
    const codex = response.json().runtimes.find((runtime: { provider: string }) => runtime.provider === "codex");
    expect(codex).toMatchObject({ provider: "codex", authState });
    expect(codex).not.toHaveProperty("account");
    expect(codex).not.toHaveProperty("authMethod");
  });

  test("rejects provider fields from the neutral Node Session contract", async () => {
    const server = await productServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v2/nodes/node-local/sessions",
      headers: { authorization: `Bearer ${server.token}` },
      payload: { cwd: process.cwd(), provider: "codex" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_NODE_SESSION");
  });
});
