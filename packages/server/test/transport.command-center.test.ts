import { afterEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { openCommandCenterStore } from "../src/command-center-store.js";
import type { CommandCenterStore } from "../src/command-center-store.js";
import { WorktreeError } from "../src/worktree-service.js";
import type { CreateServerDeps, WorktreeRecord } from "../src/index.js";
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

  test("creates worktrees idempotently and requires explicit force before dirty removal", async () => {
    const clean: WorktreeRecord = {
      path: `${process.cwd()}/feature-worktree`,
      repositoryPath: process.cwd(),
      branch: "feature/product",
      head: "abc123",
      dirty: false,
      changedFiles: 0,
      isMain: false,
    };
    const create = vi.fn().mockResolvedValue({ worktree: clean, created: true });
    const createManaged = vi.fn();
    const describeProject = vi.fn();
    const inspect = vi.fn().mockResolvedValue(clean);
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new WorktreeError("WORKTREE_DIRTY", "worktree has 2 changed files", 409))
      .mockResolvedValueOnce({ ...clean, dirty: true, changedFiles: 2 });
    const server = await makeServer({ worktreeService: { create, createManaged, describeProject, inspect, remove } });
    const request = {
      method: "POST" as const,
      url: "/api/v1/worktrees",
      headers: { ...auth, "idempotency-key": "create-feature-worktree" },
      payload: { repositoryPath: process.cwd(), path: clean.path, branch: "feature/product" },
    };
    const first = await server.app.inject(request);
    const replay = await server.app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(create).toHaveBeenCalledTimes(1);
    const workspaceId = first.json().workspace.id as string;

    const refused = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/worktree`,
      headers: { ...auth, "idempotency-key": "remove-safe" },
      payload: { confirm: true, force: false },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("WORKTREE_DIRTY");
    expect(commandStore!.getWorkspace(workspaceId)?.archivedAt).toBeUndefined();

    const forced = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/worktree`,
      headers: { ...auth, "idempotency-key": "remove-forced" },
      payload: { confirm: true, force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().workspace.archivedAt).toEqual(expect.any(Number));
    expect(remove).toHaveBeenLastCalledWith(clean.path, true);
  });

  test("creates a project-scoped worktree and stops its sessions only after explicit confirmation", async () => {
    const checkoutRoot = join(process.cwd(), "packages");
    const projectPath = join(checkoutRoot, "web");
    const worktree: WorktreeRecord = {
      path: checkoutRoot,
      repositoryPath: process.cwd(),
      branch: "feature/project-rail",
      head: "abc123",
      dirty: false,
      changedFiles: 0,
      isMain: false,
    };
    const create = vi.fn();
    const createManaged = vi.fn().mockResolvedValue({ worktree, projectPath, created: true });
    const describeProject = vi.fn().mockResolvedValue({
      projectPath: process.cwd(),
      relativePath: "web",
      worktree: { ...worktree, path: process.cwd(), isMain: true },
    });
    const inspect = vi.fn().mockResolvedValue(worktree);
    const remove = vi.fn().mockResolvedValue(worktree);
    const server = await makeServer({ worktreeService: { create, createManaged, describeProject, inspect, remove } });
    const project = commandStore!.createWorkspace({ cwd: process.cwd(), label: "RoamCode" });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/worktrees",
      headers: { ...auth, "idempotency-key": "managed-worktree" },
      payload: { projectId: project.id, branch: "feature/project-rail" },
    });
    expect(created.statusCode).toBe(201);
    expect(createManaged).toHaveBeenCalledWith({
      projectPath: process.cwd(),
      branch: "feature/project-rail",
    });
    expect(created.json().workspace).toMatchObject({
      cwd: projectPath,
      kind: "worktree",
      projectId: project.id,
      checkoutRoot,
    });
    const workspaceId = created.json().workspace.id as string;

    const imported = await server.app.inject({
      method: "POST",
      url: "/api/v1/worktrees/open",
      headers: { ...auth, "idempotency-key": "managed-worktree-import" },
      payload: { cwd: checkoutRoot, projectId: project.id },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().workspace.id).toBe(workspaceId);
    expect(describeProject).toHaveBeenCalledWith(process.cwd());

    const launched = await server.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { cwd: projectPath },
    });
    expect(launched.statusCode).toBe(201);
    const sessionId = launched.json().session.id as string;
    expect(launched.json().session.workspaceId).toBe(workspaceId);

    const preview = await server.app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/worktree`,
      headers: auth,
    });
    expect(preview.json()).toMatchObject({ runningSessions: 1 });

    const blocked = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/worktree`,
      headers: { ...auth, "idempotency-key": "managed-remove-blocked" },
      payload: { confirm: true, force: false },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "WORKTREE_SESSIONS_RUNNING", runningSessions: 1 });
    expect(server.terminalManager.get(sessionId)).toBeDefined();
    expect(remove).not.toHaveBeenCalled();

    const removed = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/worktree`,
      headers: { ...auth, "idempotency-key": "managed-remove-confirmed" },
      payload: { confirm: true, force: false, stopSessions: true },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ stoppedSessions: 1 });
    expect(server.terminalManager.get(sessionId)).toBeUndefined();
    expect(commandStore!.placementForSession(sessionId)).toBeUndefined();
    expect(remove).toHaveBeenCalledWith(checkoutRoot, false);
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
