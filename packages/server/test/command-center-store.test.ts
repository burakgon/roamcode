import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
      expect.objectContaining({ id: placement.workspaceId, label: "app", cwd: "/projects/app" }),
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

  test("records, deduplicates, sorts, snoozes, acknowledges, and resolves attention", () => {
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
    expect(store.listAttention({ now: 12 }).map((item) => item.id)).toEqual([blocked.id, done.id]);

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
    expect(store.acknowledgeAttention(blocked.id, 14)).toMatchObject({ state: "acknowledged", acknowledgedAt: 14 });
    expect(store.snoozeAttention(blocked.id, 50, 15)).toMatchObject({ state: "snoozed", snoozedUntil: 50 });
    expect(store.listAttention({ now: 20 }).map((item) => item.id)).toEqual([done.id]);
    expect(store.listAttention({ now: 50 }).map((item) => item.id)).toContain(blocked.id);
    expect(store.resolveAttentionByDedupeKey("blocked:s2", 60)).toBe(1);
    expect(store.markSessionViewed("s1", 61)).toBe(1);
    expect(store.listAttention({ now: 62 })).toEqual([]);
    expect(store.listAttention({ includeResolved: true, now: 62 })).toHaveLength(2);
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
    expect(store.listAttention({ includeResolved: true })[0]).toMatchObject({ state: "resolved", resolvedAt: 3 });
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
