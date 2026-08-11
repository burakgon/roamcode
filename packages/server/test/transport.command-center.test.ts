import { afterEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { openCommandCenterStore } from "../src/command-center-store.js";
import type { CommandCenterStore } from "../src/command-center-store.js";
import type { CreateServerDeps } from "../src/index.js";
import { buildTestServer } from "./helpers/test-server.js";
import type { TestServer } from "./helpers/test-server.js";

const auth = { authorization: "Bearer test-token" };
let current: TestServer | undefined;
let commandStore: CommandCenterStore | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
  commandStore = undefined;
});

async function makeServer(extraDeps: Partial<CreateServerDeps> = {}): Promise<TestServer> {
  let workspaceId = 0;
  commandStore = openCommandCenterStore({
    dbPath: ":memory:",
    hostLabel: "Test host",
    generateHostId: () => "rch_test",
    generateWorkspaceId: () => (workspaceId++ === 0 ? "rcw_test" : `rcw_test_${workspaceId}`),
    generateAttentionId: () => "rci_test",
  });
  current = await buildTestServer({ terminalAvailable: true, deps: { commandStore, ...extraDeps } });
  return current;
}

describe("versioned command-center API", () => {
  test("advertises stable capabilities without exposing machine-private identity", async () => {
    const server = await makeServer();
    const response = await server.app.inject({ method: "GET", url: "/api/v1/capabilities", headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      apiVersion: "v1",
      protocolVersion: 1,
      serverTime: expect.any(Number),
      host: { id: "rch_test", label: "Test host" },
      features: {
        workspaces: true,
        agents: true,
        resumableEvents: true,
        presence: true,
      },
      providers: [
        { id: "claude", displayName: "Claude Code", resumeIdentity: "optional" },
        { id: "codex", displayName: "Codex", resumeIdentity: "required" },
      ],
    });
    expect(response.body).not.toContain(process.cwd());
  });

  test("creates, summarizes, renames, reorders, and archives workspaces", async () => {
    const server = await makeServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: auth,
      payload: { cwd: process.cwd(), label: "RoamCode" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().workspace).toMatchObject({ id: "rcw_test", label: "RoamCode", cwd: process.cwd() });

    const updated = await server.app.inject({
      method: "PATCH",
      url: "/api/v1/workspaces/rcw_test",
      headers: auth,
      payload: { label: "Command center", sortOrder: 4, archived: true },
    });
    expect(updated.json().workspace).toMatchObject({ label: "Command center", sortOrder: 4 });
    expect(updated.json().workspace.archivedAt).toEqual(expect.any(Number));

    const active = await server.app.inject({ method: "GET", url: "/api/v1/workspaces", headers: auth });
    expect(active.json().workspaces).toEqual([]);
    const all = await server.app.inject({
      method: "GET",
      url: "/api/v1/workspaces?includeArchived=1",
      headers: auth,
    });
    expect(all.json().workspaces[0]).toMatchObject({ id: "rcw_test", attentionCount: 0, agentCount: 0 });

    const renamedHost = await server.app.inject({
      method: "PATCH",
      url: "/api/v1/host",
      headers: auth,
      payload: { label: "Studio Mac" },
    });
    expect(renamedHost.json().host.label).toBe("Studio Mac");
  });

  test("persists cross-device layout with optimistic conflict recovery", async () => {
    const server = await makeServer();
    const initial = await server.app.inject({ method: "GET", url: "/api/v1/layout", headers: auth });
    expect(initial.json()).toEqual({ document: null, revision: 0 });
    const saved = await server.app.inject({
      method: "PUT",
      url: "/api/v1/layout",
      headers: auth,
      payload: { document: { tree: { type: "leaf", id: "one" }, focusedLeafId: "one" }, expectedRevision: 0 },
    });
    expect(saved.json()).toMatchObject({ revision: 1, document: { focusedLeafId: "one" } });
    const stale = await server.app.inject({
      method: "PUT",
      url: "/api/v1/layout",
      headers: auth,
      payload: { document: { focusedLeafId: "stale" }, expectedRevision: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "LAYOUT_CONFLICT", current: { revision: 1 } });
  });

  test("places a neutral terminal in its workspace without inventing an agent", async () => {
    const server = await makeServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { cwd: process.cwd() },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().session).toMatchObject({
      workspaceId: "rcw_test",
      launch: { kind: "shell" },
    });
    expect(created.json().session).not.toHaveProperty("agentId");

    const sessions = await server.app.inject({ method: "GET", url: "/api/v1/sessions", headers: auth });
    expect(sessions.json().sessions[0]).toMatchObject({
      workspaceId: "rcw_test",
      launch: { kind: "shell" },
    });
    expect(sessions.json().sessions[0]).not.toHaveProperty("agentId");
    const agents = await server.app.inject({ method: "GET", url: "/api/v1/agents", headers: auth });
    expect(agents.json().agents).toEqual([]);
  });

  test("prunes stale command hierarchy only after a definitive startup inventory", async () => {
    const seeded = openCommandCenterStore({
      dbPath: ":memory:",
      hostLabel: "Test host",
      generateHostId: () => "rch_test",
      generateWorkspaceId: (() => {
        let id = 0;
        return () => `rcw_reconcile_${++id}`;
      })(),
    });
    const automatic = seeded.ensureSession("stale-session", join(process.cwd(), "automatic"), 10);
    seeded.upsertAgent(
      {
        sessionId: "stale-session",
        workspaceId: automatic.workspaceId,
        provider: "claude",
        activity: "idle",
        createdAt: 10,
      },
      11,
    );
    const explicit = seeded.createWorkspace({ cwd: join(process.cwd(), "explicit"), label: "Explicit project" }, 12);
    const tmuxSessionLister = vi.fn((): string[] => []);

    commandStore = seeded;
    current = await buildTestServer({
      terminalAvailable: true,
      deps: { commandStore: seeded, tmuxSessionLister },
    });

    expect(tmuxSessionLister).toHaveBeenCalledTimes(1);
    expect(seeded.placementForSession("stale-session")).toBeUndefined();
    expect(seeded.listAgents()).toEqual([]);
    expect(seeded.getWorkspace(automatic.workspaceId)?.archivedAt).toEqual(expect.any(Number));
    expect(seeded.listWorkspaces()).toEqual([expect.objectContaining({ id: explicit.id, origin: "explicit" })]);
    const inventory = await current.app.inject({ method: "GET", url: "/api/v1/workspaces", headers: auth });
    expect(inventory.json().workspaces).toEqual([
      expect.objectContaining({ id: explicit.id, origin: "explicit", agentCount: 0 }),
    ]);
  });

  test("keeps command hierarchy intact when the startup tmux inventory is unavailable", async () => {
    const seeded = openCommandCenterStore({
      dbPath: ":memory:",
      hostLabel: "Test host",
      generateHostId: () => "rch_test",
      generateWorkspaceId: () => "rcw_transient",
    });
    const placement = seeded.ensureSession("unverified-session", join(process.cwd(), "unverified"), 10);
    seeded.upsertAgent(
      {
        sessionId: "unverified-session",
        workspaceId: placement.workspaceId,
        provider: "codex",
        activity: "working",
        createdAt: 10,
      },
      11,
    );
    const tmuxSessionLister = vi.fn((): undefined => undefined);

    commandStore = seeded;
    current = await buildTestServer({
      terminalAvailable: true,
      deps: { commandStore: seeded, tmuxSessionLister },
    });

    expect(tmuxSessionLister).toHaveBeenCalledTimes(3);
    expect(seeded.placementForSession("unverified-session")).toEqual(placement);
    expect(seeded.listAgents()).toHaveLength(1);
    expect(seeded.getWorkspace(placement.workspaceId)?.archivedAt).toBeUndefined();
  });

  test("keeps attention signals internal while exposing workspace counts and event cursors", async () => {
    const server = await makeServer();
    const placement = commandStore!.ensureSession("session-1", process.cwd(), 1);
    commandStore!.recordAttention(
      {
        workspaceId: placement.workspaceId,
        sessionId: placement.sessionId,
        agentId: placement.agentId,
        kind: "blocked",
        title: "Agent needs a decision",
        dedupeKey: "blocked:session-1",
      },
      2,
    );

    const removedInbox = await server.app.inject({ method: "GET", url: "/api/v1/attention", headers: auth });
    expect(removedInbox.statusCode).toBe(404);
    const workspaces = await server.app.inject({ method: "GET", url: "/api/v1/workspaces", headers: auth });
    expect(workspaces.json().workspaces[0]).toMatchObject({ attentionCount: 1, urgency: 100 });
    const host = await server.app.inject({ method: "GET", url: "/api/v1/host", headers: auth });
    expect(host.json().summary).toMatchObject({ attentionCount: 1, urgency: 100 });

    const firstEvents = await server.app.inject({ method: "GET", url: "/api/v1/events?limit=2", headers: auth });
    const cursor = firstEvents.json().nextCursor as number;
    expect(firstEvents.json().events).toHaveLength(2);
    const laterEvents = await server.app.inject({
      method: "GET",
      url: `/api/v1/events?after=${cursor}`,
      headers: auth,
    });
    expect(laterEvents.json().events.every((event: { id: number }) => event.id > cursor)).toBe(true);

    commandStore!.resolveAttentionByDedupeKey("blocked:session-1", 3);
    const updated = await server.app.inject({ method: "GET", url: "/api/v1/workspaces", headers: auth });
    expect(updated.json().workspaces[0]).toMatchObject({ attentionCount: 0, urgency: 0 });
  });

  test("provides an authenticated resumable SSE snapshot and bounded diagnostics mode", async () => {
    const server = await makeServer();
    commandStore!.ensureSession("session-1", process.cwd(), 1);
    const response = await server.app.inject({
      method: "GET",
      url: "/api/v1/events/stream?once=1",
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: snapshot");
    expect(response.body).toContain('\"protocolVersion\":1');
    expect(response.body).toContain('\"sessions\":[]');
    expect(response.body).toContain("event: ready");

    const denied = await server.app.inject({ method: "GET", url: "/api/v1/events/stream?once=1" });
    expect(denied.statusCode).toBe(401);
  });

  test("searches metadata deterministically without indexing terminal content", async () => {
    const server = await makeServer();
    const workspace = commandStore!.createWorkspace({ cwd: process.cwd(), label: "RoamCode workspace" }, 1);
    const placement = commandStore!.ensureSession("session-search", process.cwd(), 2);
    commandStore!.upsertAgent(
      {
        sessionId: placement.sessionId,
        workspaceId: workspace.id,
        provider: "claude",
        activity: "blocked",
        createdAt: 2,
      },
      3,
    );
    commandStore!.recordAttention(
      {
        workspaceId: workspace.id,
        sessionId: placement.sessionId,
        agentId: placement.agentId,
        kind: "blocked",
        title: "Approve deployment decision",
        dedupeKey: "search-decision",
      },
      4,
    );

    const response = await server.app.inject({ method: "GET", url: "/api/v1/search?q=RoamCode", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      query: "RoamCode",
      results: [
        {
          kind: "workspace",
          id: workspace.id,
          label: "RoamCode workspace",
        },
      ],
    });
    const privateSignal = await server.app.inject({ method: "GET", url: "/api/v1/search?q=decision", headers: auth });
    expect(privateSignal.json().results).toEqual([]);
    expect(response.body).not.toContain("terminal text");
    expect((await server.app.inject({ method: "GET", url: "/api/v1/search?q=", headers: auth })).statusCode).toBe(400);
  });

  test("keeps every v1 resource default-deny", async () => {
    const server = await makeServer();
    for (const url of [
      "/api/v1/capabilities",
      "/api/v1/host",
      "/api/v1/workspaces",
      "/api/v1/attention",
      "/api/v1/search?q=test",
    ]) {
      const response = await server.app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
  });
});
