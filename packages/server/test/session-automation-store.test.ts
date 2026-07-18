import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  openSessionAutomationStore,
  SessionAutomationRevisionConflictError,
  type OpenSessionAutomationStoreOptions,
  type SessionAutomationStore,
} from "../src/session-automation-store.js";

const stores: SessionAutomationStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function input() {
  return {
    owner: { type: "person" as const, id: "person_local" },
    name: "Review release",
    nodeId: "node_1",
    agentRuntimeId: "runtime_codex",
    provider: "codex",
    cwd: process.cwd(),
    instruction: "Review the release diff and report blockers.",
    runtimeOptions: { model: "gpt-5", reasoningEffort: "high" },
    trigger: { type: "manual" as const },
  };
}

function open(options: Partial<OpenSessionAutomationStoreOptions> = {}): SessionAutomationStore {
  const store = openSessionAutomationStore({
    dbPath: ":memory:",
    generateAutomationId: () => "rca2_test",
    generateRunId: () => "rcar_test",
    ...options,
  });
  stores.push(store);
  return store;
}

describe("session automation store", () => {
  test("persists exact node/runtime/cwd placement and links a run to its real session", () => {
    const store = open();
    const created = store.create(input(), 10);

    expect(created).toMatchObject({
      id: "rca2_test",
      owner: { type: "person", id: "person_local" },
      nodeId: "node_1",
      agentRuntimeId: "runtime_codex",
      provider: "codex",
      cwd: process.cwd(),
      trigger: { type: "manual" },
      revision: 1,
    });

    const starting = store.createRun(
      {
        automationId: created.id,
        definitionRevision: created.revision,
        invocationId: "invoke_1",
        sessionId: "session_1",
        nodeId: created.nodeId,
        agentRuntimeId: created.agentRuntimeId,
        cwd: created.cwd,
      },
      20,
    );
    expect(starting).toMatchObject({
      id: "rcar_test",
      automationId: created.id,
      definitionRevision: 1,
      invocationId: "invoke_1",
      sessionId: "session_1",
      status: "starting",
    });
    expect(store.beginRunBootstrap(starting.id)).toBe("claimed");
    expect(store.beginRunBootstrap(starting.id)).toBe("already-started");
    const running = store.completeRunBootstrap(starting.id, 21);
    expect(running).toMatchObject({ status: "running", sessionId: "session_1", updatedAt: 21 });
    expect(store.getRun(starting.id)).toEqual(running);
    expect(store.getRunByInvocationId("invoke_1")).toEqual(running);
    expect(store.getRunBySessionId("session_1")).toEqual(running);
    expect(store.listRuns(created.id)).toEqual([running]);
    expect(store.getRunInputSnapshot(starting.id)).toEqual({
      runId: starting.id,
      automationId: created.id,
      definitionRevision: 1,
      provider: "codex",
      instruction: "Review the release diff and report blockers.",
      runtimeOptions: { model: "gpt-5", reasoningEffort: "high" },
      bootstrapState: "submitted",
    });
  });

  test("uses optimistic revisions and returns the current record on conflict", () => {
    const store = open();
    const created = store.create(input(), 10);
    const updated = store.update(created.id, { name: "Review stable release" }, 1, 11)!;
    expect(updated).toMatchObject({ name: "Review stable release", revision: 2, createdAt: 10, updatedAt: 11 });

    expect(() => store.update(created.id, { enabled: false }, 1, 12)).toThrow(SessionAutomationRevisionConflictError);
    try {
      store.update(created.id, { enabled: false }, 1, 12);
    } catch (error) {
      expect((error as SessionAutomationRevisionConflictError).current).toEqual(updated);
    }
  });

  test("falls back to memory without weakening validation", () => {
    const store = open({
      loadDatabase: () => {
        throw new Error("native unavailable");
      },
    });
    expect(store.mode).toBe("memory-fallback");
    expect(() => store.create({ ...input(), cwd: "", instruction: "\u0000" })).toThrow();
    expect(() => store.create({ ...input(), nodeId: "bad/node" })).toThrow();
    expect(store.list()).toEqual([]);
  });

  test("survives a SQLite reopen and preserves immutable runs when a definition is removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "roamcode-automation-"));
    dirs.push(dir);
    const dbPath = join(dir, "automations.db");
    const first = open({ dbPath });
    const created = first.create(input(), 10);
    first.createRun(
      {
        automationId: created.id,
        definitionRevision: created.revision,
        invocationId: "invoke_1",
        sessionId: "session_1",
        nodeId: created.nodeId,
        agentRuntimeId: created.agentRuntimeId,
        cwd: created.cwd,
      },
      20,
    );
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = open({ dbPath });
    expect(reopened.list()).toEqual([created]);
    expect(reopened.listRuns(created.id)).toHaveLength(1);
    expect(reopened.getRunInputSnapshot("rcar_test")).toMatchObject({
      runId: "rcar_test",
      automationId: created.id,
      provider: "codex",
      instruction: created.instruction,
      runtimeOptions: created.runtimeOptions,
      bootstrapState: "pending",
    });
    expect(reopened.remove(created.id)).toBe(true);
    expect(reopened.get(created.id)).toBeUndefined();
    expect(reopened.list()).toEqual([]);
    expect(reopened.listRuns(created.id)).toHaveLength(1);
    expect(() =>
      reopened.createRun({
        automationId: created.id,
        definitionRevision: created.revision,
        invocationId: "invoke_after_delete",
        sessionId: "session_after_delete",
        nodeId: created.nodeId,
        agentRuntimeId: created.agentRuntimeId,
        cwd: created.cwd,
      }),
    ).toThrow("automation not found");
    expect(reopened.remove(created.id)).toBe(false);
  });

  test("persists configured triggers, scheduler cursors, and queued activity across a SQLite reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "roamcode-automation-triggers-"));
    dirs.push(dir);
    const dbPath = join(dir, "automations.db");
    const first = open({ dbPath });
    const created = first.create(
      {
        ...input(),
        triggers: [
          {
            id: "trigger_schedule",
            type: "schedule",
            enabled: true,
            cron: "0 9 * * 1-5",
            timeZone: "Europe/Istanbul",
            missedRunPolicy: "skip",
          },
          {
            id: "trigger_webhook",
            type: "webhook",
            enabled: true,
            hookId: "rcwh_abcdefghijklmnopqrstuvwx",
            secretHash: "a".repeat(64),
          },
        ],
      },
      10,
    );
    first.setTriggerCursor("trigger_schedule", 1234);
    const activity = first.createActivity(
      {
        automationId: created.id,
        triggerId: "trigger_webhook",
        source: "webhook",
        status: "queued",
        invocationId: "managed_invocation",
      },
      20,
    );
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = open({ dbPath });
    expect(reopened.get(created.id)?.triggers).toEqual(created.triggers);
    expect(reopened.getTriggerCursor("trigger_schedule")).toBe(1234);
    expect(reopened.listActivities(created.id)).toEqual([activity]);
  });

  test.each(["sqlite", "memory"] as const)(
    "transfers active and removed definitions for an exact owner and Node in %s mode",
    (mode) => {
      let sequence = 0;
      const store = open({
        generateAutomationId: () => `automation_${++sequence}`,
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      const first = store.create(input(), 10);
      const otherNode = store.create({ ...input(), nodeId: "node_2", name: "Other Node" }, 11);
      const otherOwner = store.create(
        { ...input(), owner: { type: "person", id: "person_other" }, name: "Other Owner" },
        12,
      );
      const removed = store.create({ ...input(), name: "Removed" }, 13);
      store.createRun(
        {
          automationId: removed.id,
          definitionRevision: removed.revision,
          invocationId: "invoke_before_remove",
          sessionId: "session_before_remove",
          nodeId: removed.nodeId,
          agentRuntimeId: removed.agentRuntimeId,
          cwd: removed.cwd,
        },
        14,
      );
      expect(store.remove(removed.id)).toBe(true);
      expect(() =>
        store.createRun({
          automationId: removed.id,
          definitionRevision: removed.revision,
          invocationId: "invoke_removed",
          sessionId: "session_removed",
          nodeId: removed.nodeId,
          agentRuntimeId: removed.agentRuntimeId,
          cwd: removed.cwd,
        }),
      ).toThrow("automation not found");

      expect(
        store.transferOwner(
          { type: "person", id: "person_local" },
          { type: "organization", id: "organization_one" },
          "node_1",
          20,
        ),
      ).toBe(2);
      expect(store.get(first.id)).toMatchObject({
        owner: { type: "organization", id: "organization_one" },
        revision: 2,
        updatedAt: 20,
      });
      expect(store.get(otherNode.id)?.owner).toEqual({ type: "person", id: "person_local" });
      expect(store.get(otherOwner.id)?.owner).toEqual({ type: "person", id: "person_other" });
      expect(store.getIncludingRemoved(removed.id)).toMatchObject({
        owner: { type: "organization", id: "organization_one" },
        revision: 2,
        updatedAt: 20,
      });
      expect(store.listRuns(removed.id)).toEqual([
        expect.objectContaining({ invocationId: "invoke_before_remove", sessionId: "session_before_remove" }),
      ]);
      expect(store.getNodeOwner("node_1")).toEqual({ type: "organization", id: "organization_one" });
      expect(
        store.transferOwner(
          { type: "person", id: "person_local" },
          { type: "organization", id: "organization_one" },
          "node_1",
          21,
        ),
      ).toBe(0);
    },
  );

  test.each(["sqlite", "memory"] as const)(
    "records a same-owner Node transfer without revising definitions in %s mode",
    (mode) => {
      const store = open({
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      const created = store.create({ ...input(), owner: { type: "organization", id: "organization_one" } }, 10);

      expect(
        store.transferOwner(
          { type: "organization", id: "organization_one" },
          { type: "organization", id: "organization_one" },
          "node_1",
          20,
        ),
      ).toBe(0);
      expect(store.getNodeOwner("node_1")).toEqual({ type: "organization", id: "organization_one" });
      expect(store.get(created.id)).toEqual(created);

      expect(
        store.transferOwner(
          { type: "organization", id: "organization_one" },
          { type: "organization", id: "organization_one" },
          "node_1",
          30,
        ),
      ).toBe(0);
      expect(store.get(created.id)).toEqual(created);
    },
  );

  test("persists explicit Node ownership independently from cloud configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "roamcode-automation-owner-"));
    dirs.push(dir);
    const dbPath = join(dir, "automations.db");
    const first = open({ dbPath });
    first.create(input(), 10);
    expect(
      first.transferOwner(
        { type: "person", id: "person_local" },
        { type: "organization", id: "organization_one" },
        "node_1",
        20,
      ),
    ).toBe(1);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = open({ dbPath });
    expect(reopened.getNodeOwner("node_1")).toEqual({ type: "organization", id: "organization_one" });
    expect(reopened.list({ type: "organization", id: "organization_one" })).toHaveLength(1);
  });

  test.each(["sqlite", "memory"] as const)("enforces documented UTF-8 byte bounds in %s mode", (mode) => {
    let sequence = 0;
    const store = open({
      generateAutomationId: () => `automation_${++sequence}`,
      ...(mode === "memory"
        ? {
            loadDatabase: () => {
              throw new Error("native unavailable");
            },
          }
        : {}),
    });

    expect(store.create({ ...input(), instruction: "a".repeat(32 * 1024) })).toBeDefined();
    expect(() => store.create({ ...input(), instruction: `${"a".repeat(32 * 1024)}b` })).toThrow(
      "invalid automation instruction",
    );
    expect(() => store.create({ ...input(), instruction: "🙂".repeat(8 * 1024 + 1) })).toThrow(
      "invalid automation instruction",
    );
    expect(() => store.create({ ...input(), runtimeOptions: { value: "a".repeat(64 * 1024) } })).toThrow(
      "runtime options are too large",
    );
  });

  test.each(["sqlite", "memory"] as const)(
    "keeps an immutable private Run input snapshot across later definition edits in %s mode",
    (mode) => {
      const store = open({
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      const created = store.create(input(), 10);
      const run = store.createRun(
        {
          automationId: created.id,
          definitionRevision: created.revision,
          invocationId: "immutable_invocation",
          sessionId: "immutable_session",
          nodeId: created.nodeId,
          agentRuntimeId: created.agentRuntimeId,
          cwd: created.cwd,
          provider: created.provider,
          instruction: created.instruction,
          runtimeOptions: created.runtimeOptions,
        },
        11,
      );
      store.update(
        created.id,
        {
          instruction: "A later and unrelated instruction.",
          runtimeOptions: { model: "different-model" },
        },
        created.revision,
        12,
      );

      expect(store.getRunInputSnapshot(run.id)).toEqual({
        runId: run.id,
        automationId: created.id,
        definitionRevision: created.revision,
        provider: created.provider,
        instruction: created.instruction,
        runtimeOptions: created.runtimeOptions,
        bootstrapState: "pending",
      });
    },
  );
});
