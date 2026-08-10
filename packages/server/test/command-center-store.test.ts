import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { openCommandCenterStore } from "../src/command-center-store.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "roamcode-command-center-"));
  dirs.push(dir);
  return join(dir, "command-center.db");
}

function generators() {
  let workspace = 0;
  let attention = 0;
  return {
    generateHostId: () => "rch_host",
    generateWorkspaceId: () => `rcw_${++workspace}`,
    generateAttentionId: () => `rci_${++attention}`,
  };
}

describe.each(["sqlite", "memory-fallback"] as const)("command center store (%s)", (mode) => {
  function open(dbPath = databasePath()) {
    return openCommandCenterStore({
      dbPath,
      hostLabel: "  My workstation  ",
      ...generators(),
      ...(mode === "memory-fallback"
        ? {
            loadDatabase: () => {
              throw new Error("native module unavailable");
            },
          }
        : {}),
    });
  }

  test("creates a privacy-light host identity and durable workspace/session/agent hierarchy", () => {
    const store = open();
    expect(store.mode).toBe(mode);
    expect(store.getHost()).toMatchObject({ id: "rch_host", label: "My workstation" });
    expect(store.renameHost("Build host", 20)).toMatchObject({ label: "Build host", updatedAt: 20 });

    const placement = store.ensureSession("session-1", "/projects/app", 100);
    const samePlacement = store.ensureSession("session-1", "/ignored", 101);
    const sibling = store.ensureSession("session-2", "/projects/app", 102);
    expect(samePlacement).toEqual(placement);
    expect(sibling.workspaceId).toBe(placement.workspaceId);
    expect(store.listWorkspaces()).toEqual([
      expect.objectContaining({
        id: placement.workspaceId,
        label: "app",
        cwd: "/projects/app",
        projectId: placement.workspaceId,
        checkoutRoot: "/projects/app",
        origin: "session",
      }),
    ]);

    const agent = store.upsertAgent(
      {
        sessionId: "session-1",
        workspaceId: placement.workspaceId,
        provider: "codex",
        activity: "working",
        createdAt: 100,
      },
      110,
    );
    expect(agent).toMatchObject({ id: placement.agentId, provider: "codex", activity: "working" });
    expect(store.listAgents()).toEqual([agent]);
    store.close();
  });

  test("places an explicit worktree checkout under its project root", () => {
    const store = open();
    const project = store.createWorkspace({ cwd: "/projects/storefront", label: "Storefront" }, 1);
    const checkout = store.createWorkspace(
      {
        cwd: "/projects/storefront.worktrees/feature/apps/storefront",
        label: "feature/cart",
        kind: "worktree",
        projectId: project.id,
        checkoutRoot: "/projects/storefront.worktrees/feature",
      },
      2,
    );
    expect(project).toMatchObject({
      projectId: project.id,
      checkoutRoot: "/projects/storefront",
      origin: "explicit",
    });
    expect(checkout).toMatchObject({
      kind: "worktree",
      projectId: project.id,
      checkoutRoot: "/projects/storefront.worktrees/feature",
    });
    store.close();
  });

  test("reconciles missing Sessions and archives only empty session-derived projects", () => {
    const store = open();
    const automatic = store.ensureSession("gone", "/projects/automatic", 10);
    store.ensureSession("live", "/projects/automatic", 11);
    store.upsertAgent(
      {
        sessionId: "gone",
        workspaceId: automatic.workspaceId,
        provider: "claude",
        activity: "idle",
        createdAt: 10,
      },
      12,
    );
    const explicit = store.createWorkspace({ cwd: "/projects/explicit", label: "Pinned project" }, 13);
    const explicitPlacement = store.ensureSession("explicit-gone", explicit.cwd, 14);
    store.upsertAgent(
      {
        sessionId: "explicit-gone",
        workspaceId: explicitPlacement.workspaceId,
        provider: "codex",
        activity: "ended",
        createdAt: 14,
      },
      15,
    );

    expect(store.reconcileSessions!(["live"], 20)).toEqual({ removedSessions: 2, archivedWorkspaces: 0 });
    expect(store.placementForSession("gone")).toBeUndefined();
    expect(store.placementForSession("live")).toBeDefined();
    expect(store.getWorkspace(automatic.workspaceId)?.archivedAt).toBeUndefined();
    expect(store.getWorkspace(explicit.id)?.origin).toBe("explicit");
    expect(store.getWorkspace(explicit.id)?.archivedAt).toBeUndefined();

    expect(store.reconcileSessions!([], 21)).toEqual({ removedSessions: 1, archivedWorkspaces: 1 });
    expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual([explicit.id]);
    expect(store.getWorkspace(automatic.workspaceId)).toMatchObject({ origin: "session", archivedAt: 21 });

    const restored = store.ensureSession("replacement", "/projects/automatic", 22);
    expect(restored.workspaceId).toBe(automatic.workspaceId);
    expect(store.getWorkspace(automatic.workspaceId)?.archivedAt).toBeUndefined();
    store.close();
  });

  test("promotes a session-derived project when the user explicitly keeps or edits it", () => {
    const store = open();
    const placement = store.ensureSession("session", "/projects/promoted", 1);
    expect(store.getWorkspace(placement.workspaceId)?.origin).toBe("session");

    const promoted = store.createWorkspace({ cwd: "/projects/promoted", label: "Promoted" }, 2);
    expect(promoted.origin).toBe("explicit");
    store.removeSession("session", 3);
    expect(store.getWorkspace(promoted.id)?.archivedAt).toBeUndefined();

    const second = store.ensureSession("second", "/projects/edit", 4);
    expect(store.updateWorkspace(second.workspaceId, { label: "Keep me" }, 5)?.origin).toBe("explicit");
    store.removeSession("second", 6);
    expect(store.getWorkspace(second.workspaceId)?.archivedAt).toBeUndefined();
    store.close();
  });

  test("records, deduplicates, sorts, and resolves internal needs signals", () => {
    const store = open();
    const first = store.ensureSession("s1", "/projects/one", 1);
    const second = store.ensureSession("s2", "/projects/two", 2);
    const done = store.recordAttention(
      {
        workspaceId: first.workspaceId,
        sessionId: "s1",
        agentId: first.agentId,
        kind: "done",
        title: "Agent finished",
        dedupeKey: "done:s1",
      },
      10,
    );
    const blocked = store.recordAttention(
      {
        workspaceId: second.workspaceId,
        sessionId: "s2",
        agentId: second.agentId,
        kind: "blocked",
        title: "Agent needs a decision",
        dedupeKey: "blocked:s2",
      },
      11,
    );
    expect(store.listAttention().map((item) => item.id)).toEqual([blocked.id, done.id]);

    const duplicate = store.recordAttention(
      {
        workspaceId: second.workspaceId,
        sessionId: "s2",
        agentId: second.agentId,
        kind: "blocked",
        title: "Agent still needs a decision",
        dedupeKey: "blocked:s2",
      },
      13,
    );
    expect(duplicate).toMatchObject({ id: blocked.id, occurrenceCount: 2, title: "Agent still needs a decision" });
    expect(store.resolveAttentionByDedupeKey("blocked:s2", 60)).toBe(1);
    expect(store.markSessionViewed("s1", 61)).toBe(1);
    expect(store.listAttention()).toEqual([]);
    expect(store.listEvents().filter((event) => event.type === "attention.resolved")).toHaveLength(2);
    store.close();
  });

  test("emits an ordered, resumable event log and resolves items when a session is removed", () => {
    const store = open();
    const liveIds: number[] = [];
    const unsubscribe = store.subscribeEvents((event) => liveIds.push(event.id));
    const placement = store.ensureSession("s1", "/projects/app", 1);
    store.recordAttention(
      {
        workspaceId: placement.workspaceId,
        sessionId: "s1",
        agentId: placement.agentId,
        kind: "error",
        title: "Agent failed",
        dedupeKey: "error:s1",
      },
      2,
    );
    const before = store.listEvents();
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(before.map((event) => event.id)).toEqual([...before.map((event) => event.id)].sort((a, b) => a - b));
    const cursor = before.at(-2)!.id;
    expect(store.listEvents(cursor).every((event) => event.id > cursor)).toBe(true);
    expect(store.eventBounds()).toEqual({ earliest: before[0]!.id, latest: before.at(-1)!.id });
    expect(liveIds).toEqual(before.map((event) => event.id));

    store.removeSession("s1", 3);
    unsubscribe();
    const observed = liveIds.length;
    store.appendEvent("after.unsubscribe", "host", "host", {}, 4);
    expect(liveIds).toHaveLength(observed);
    expect(store.placementForSession("s1")).toBeUndefined();
    expect(store.listAttention()).toEqual([]);
    expect(store.listEvents().some((event) => event.type === "attention.resolved" && event.createdAt === 3)).toBe(true);
    store.close();
  });

  test("stores a revisioned cross-device layout and rejects stale writers", () => {
    const store = open();
    expect(store.getLayout()).toEqual({ document: null, revision: 0 });
    const first = store.putLayout({ tree: { type: "leaf", id: "one" }, focusedLeafId: "one" }, 0, 10);
    expect(first).toMatchObject({ revision: 1, updatedAt: 10, document: { focusedLeafId: "one" } });
    expect(() => store.putLayout({ focusedLeafId: "stale" }, 0, 11)).toThrow(/revision conflict/i);
    expect(store.getLayout()).toEqual(first);
    store.close();
  });
});

test("sqlite host identity, hierarchy, and event cursors survive a reopen", () => {
  const dbPath = databasePath();
  const first = openCommandCenterStore({ dbPath, hostLabel: "Host A", ...generators() });
  const placement = first.ensureSession("session", "/projects/app", 1);
  first.putLayout({ tree: { type: "leaf", id: "one" }, focusedLeafId: "one" }, 0, 1);
  const lastEventId = first.listEvents().at(-1)!.id;
  first.close();

  const second = openCommandCenterStore({ dbPath, hostLabel: "Changed default" });
  expect(second.getHost()).toMatchObject({ id: "rch_host", label: "Host A" });
  expect(second.placementForSession("session")).toEqual(placement);
  expect(second.getLayout()).toMatchObject({ revision: 1, document: { focusedLeafId: "one" } });
  const event = second.appendEvent("test.event", "host", "rch_host", {}, 2);
  expect(event.id).toBeGreaterThan(lastEventId);
  second.close();
});

test("sqlite upgrades legacy workspaces with conservative retention provenance", () => {
  const dbPath = databasePath();
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE command_workspaces (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      cwd TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('directory', 'worktree')),
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE command_session_placements (
      session_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES command_workspaces(id),
      agent_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    INSERT INTO command_workspaces (
      id, label, cwd, kind, sort_order, created_at, updated_at, archived_at
    ) VALUES
      ('legacy-project', 'Legacy', '/projects/legacy', 'directory', 0, 1, 1, NULL),
      ('legacy-session-project', 'Automatic', '/projects/automatic', 'directory', 1, 10, 10, NULL),
      ('legacy-worktree', 'Feature', '/projects/legacy-worktree', 'worktree', 2, 20, 20, NULL),
      ('legacy-edited-project', 'Renamed', '/projects/renamed', 'directory', 3, 30, 31, NULL);
    INSERT INTO command_session_placements (
      session_id, workspace_id, agent_id, created_at
    ) VALUES
      ('stale-session', 'legacy-session-project', 'agent_stale-session', 10),
      ('stale-edited-session', 'legacy-edited-project', 'agent_stale-edited-session', 30);
  `);
  legacy.close();

  const store = openCommandCenterStore({ dbPath, hostLabel: "Migrated host" });
  expect(store.getWorkspace("legacy-project")).toMatchObject({
    projectId: "legacy-project",
    checkoutRoot: "/projects/legacy",
    origin: "explicit",
  });
  expect(store.getWorkspace("legacy-session-project")?.origin).toBe("session");
  expect(store.getWorkspace("legacy-worktree")?.origin).toBe("explicit");
  expect(store.getWorkspace("legacy-edited-project")?.origin).toBe("explicit");
  expect(store.reconcileSessions!([], 40)).toEqual({ removedSessions: 2, archivedWorkspaces: 1 });
  expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual([
    "legacy-project",
    "legacy-worktree",
    "legacy-edited-project",
  ]);
  store.close();
});

test("sqlite preserves an existing project root that owns a worktree during origin migration", () => {
  const dbPath = databasePath();
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE command_workspaces (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      cwd TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('directory', 'worktree')),
      project_id TEXT,
      checkout_root TEXT,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE command_session_placements (
      session_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES command_workspaces(id),
      agent_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    INSERT INTO command_workspaces (
      id, label, cwd, kind, project_id, checkout_root, sort_order, created_at, updated_at, archived_at
    ) VALUES
      ('project', 'Project', '/projects/root', 'directory', 'project', '/projects/root', 0, 10, 10, NULL),
      ('worktree', 'Feature', '/projects/tree', 'worktree', 'project', '/projects/tree', 1, 11, 11, NULL);
    INSERT INTO command_session_placements (
      session_id, workspace_id, agent_id, created_at
    ) VALUES ('stale-root-session', 'project', 'agent_stale-root-session', 10);
  `);
  legacy.close();

  const store = openCommandCenterStore({ dbPath, hostLabel: "Migrated host" });
  expect(store.getWorkspace("project")?.origin).toBe("explicit");
  expect(store.getWorkspace("worktree")?.origin).toBe("explicit");
  expect(store.reconcileSessions!([], 20)).toEqual({ removedSessions: 1, archivedWorkspaces: 0 });
  expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual(["project", "worktree"]);
  store.close();
});
