import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createAutomationTriggerEngine,
  cronMatches,
  validateCronExpression,
} from "../src/automation-trigger-engine.js";
import { openSessionAutomationStore, type SessionAutomationStore } from "../src/session-automation-store.js";

const stores: SessionAutomationStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function store(): SessionAutomationStore {
  let activity = 0;
  const opened = openSessionAutomationStore({
    dbPath: ":memory:",
    generateAutomationId: () => "automation_one",
    generateActivityId: () => `rcae_${++activity}`,
    loadDatabase: () => {
      throw new Error("exercise memory implementation");
    },
  });
  stores.push(opened);
  return opened;
}

function createDefinition(opened: SessionAutomationStore, type: "schedule" | "webhook") {
  return opened.create(
    {
      owner: { type: "person", id: "person_local" },
      name: "Repository review",
      nodeId: "node_local",
      agentRuntimeId: "runtime_local",
      provider: "codex",
      cwd: process.cwd(),
      instruction: "Review the repository.",
      triggers:
        type === "schedule"
          ? [
              {
                id: "trigger_schedule",
                type: "schedule",
                enabled: true,
                cron: "* * * * *",
                timeZone: "UTC",
                missedRunPolicy: "skip",
              },
            ]
          : [
              {
                id: "trigger_webhook",
                type: "webhook",
                enabled: true,
                hookId: "rcwh_abcdefghijklmnopqrstuvwx",
                secretHash: "a".repeat(64),
              },
            ],
    },
    1,
  );
}

describe("automation trigger engine", () => {
  test("validates five-field cron and evaluates it in the configured IANA timezone", () => {
    expect(validateCronExpression(" 0  9 * * 1-5 ")).toBe("0 9 * * 1-5");
    const mondayAtNineInIstanbul = Date.UTC(2026, 6, 20, 6, 0, 0);
    expect(cronMatches("0 9 * * 1-5", "Europe/Istanbul", mondayAtNineInIstanbul)).toBe(true);
    expect(cronMatches("0 9 * * 1-5", "UTC", mondayAtNineInIstanbul)).toBe(false);
    expect(() => validateCronExpression("0 9 * *")).toThrow("five fields");
    expect(() => validateCronExpression("60 9 * * *")).toThrow("invalid cron field");
  });

  test("skips downtime backlog explicitly and launches only the current matching minute", async () => {
    const opened = store();
    const definition = createDefinition(opened, "schedule");
    const currentMinute = Math.floor(Date.UTC(2026, 6, 20, 6, 5) / 60_000);
    opened.setTriggerCursor("trigger_schedule", currentMinute - 3);
    const execute = vi.fn(async () => ({ runId: "run_current" }));
    const engine = createAutomationTriggerEngine({ store: opened, execute, concurrency: 1 });

    await engine.tick(currentMinute * 60_000);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(opened.listActivities(definition.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "schedule",
            status: "missed",
            missedCount: 2,
            failureCode: "NODE_OFFLINE_MISSED_SCHEDULE",
          }),
          expect.objectContaining({ source: "schedule", status: "started", runId: "run_current" }),
        ]),
      ),
    );
    expect(opened.getTriggerCursor("trigger_schedule")).toBe(currentMinute);
  });

  test("recovers a durable queue in FIFO order and enforces launch concurrency", async () => {
    const opened = store();
    const definition = createDefinition(opened, "webhook");
    const trigger = definition.triggers[0]!;
    const first = opened.createActivity(
      {
        automationId: definition.id,
        triggerId: trigger.id,
        source: "webhook",
        status: "queued",
        invocationId: "invocation_first",
      },
      10,
    );
    const second = opened.createActivity(
      {
        automationId: definition.id,
        triggerId: trigger.id,
        source: "webhook",
        status: "queued",
        invocationId: "invocation_second",
      },
      20,
    );
    const releases: Array<(value: { runId: string }) => void> = [];
    const execute = vi.fn(
      () =>
        new Promise<{ runId: string }>((resolve) => {
          releases.push(resolve);
        }),
    );
    const engine = createAutomationTriggerEngine({
      store: opened,
      execute,
      concurrency: 1,
      setInterval: (() => 1) as never,
      clearInterval: vi.fn() as never,
    });

    engine.start();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]?.[0].id).toBe(first.id);
    releases.shift()?.({ runId: "run_first" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls[1]?.[0].id).toBe(second.id);
    releases.shift()?.({ runId: "run_second" });
    await vi.waitFor(() =>
      expect(opened.listActivities(definition.id).every((item) => item.status === "started")).toBe(true),
    );
    engine.stop();
  });

  test("deduplicates a redelivered managed webhook invocation", async () => {
    const opened = store();
    const definition = createDefinition(opened, "webhook");
    const trigger = definition.triggers[0]!;
    const execute = vi.fn(async () => ({ runId: "run_webhook" }));
    const engine = createAutomationTriggerEngine({ store: opened, execute, concurrency: 1 });

    const first = engine.enqueueWebhook(definition, trigger, "11111111-1111-4111-8111-111111111111");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    for (let index = 0; index < 1_001; index += 1) {
      opened.createActivity(
        {
          automationId: definition.id,
          triggerId: trigger.id,
          source: "webhook",
          status: "missed",
          invocationId: `historical_${index}`,
        },
        Date.now() + 1_000 + index,
      );
    }
    const replay = engine.enqueueWebhook(definition, trigger, "11111111-1111-4111-8111-111111111111");
    expect(replay.id).toBe(first.id);
    expect(execute).toHaveBeenCalledOnce();
    expect(opened.getActivityByInvocationId(first.invocationId)?.id).toBe(first.id);
  });

  test("does not launch a redelivered invocation twice while its durable activity is in flight", async () => {
    const opened = store();
    const definition = createDefinition(opened, "webhook");
    const trigger = definition.triggers[0]!;
    let release: ((value: { runId: string }) => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<{ runId: string }>((resolve) => {
          release = resolve;
        }),
    );
    const engine = createAutomationTriggerEngine({ store: opened, execute, concurrency: 2 });

    const first = engine.enqueueWebhook(definition, trigger, "22222222-2222-4222-8222-222222222222");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const replay = engine.enqueueWebhook(definition, trigger, "22222222-2222-4222-8222-222222222222");

    expect(replay.id).toBe(first.id);
    expect(execute).toHaveBeenCalledOnce();
    release?.({ runId: "run_webhook" });
    await vi.waitFor(() =>
      expect(opened.getActivityByInvocationId(first.invocationId)).toMatchObject({ status: "started" }),
    );
  });
});
