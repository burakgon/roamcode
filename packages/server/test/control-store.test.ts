import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { CONTROL_IDEMPOTENCY_TTL_MS, openControlStore, privacySafeAuditMetadata } from "../src/control-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "roamcode-control-"));
  dirs.push(dir);
  return join(dir, "control.db");
}

describe("control store", () => {
  test("persists idempotent responses per actor and expires them", () => {
    const dbPath = databasePath();
    const store = openControlStore({ dbPath });
    store.putIdempotency({
      actorId: "device-1",
      key: "create-workspace-1",
      fingerprint: "sha256:request",
      statusCode: 201,
      body: '{"workspace":{"id":"w1"}}',
      createdAt: 10,
      expiresAt: 10 + CONTROL_IDEMPOTENCY_TTL_MS,
    });
    expect(store.getIdempotency("device-1", "create-workspace-1", 11)?.statusCode).toBe(201);
    expect(store.getIdempotency("device-2", "create-workspace-1", 11)).toBeUndefined();
    store.close();

    const reopened = openControlStore({ dbPath });
    expect(reopened.getIdempotency("device-1", "create-workspace-1", 12)?.body).toContain("w1");
    expect(reopened.getIdempotency("device-1", "create-workspace-1", 10 + CONTROL_IDEMPOTENCY_TTL_MS)).toBeUndefined();
    reopened.close();
  });

  test("creates an append-only, integrity-verifiable audit chain without private metadata", () => {
    const dbPath = databasePath();
    const store = openControlStore({ dbPath });
    const first = store.appendAudit({
      actorType: "device",
      actorId: "device-1",
      action: "POST /api/v1/workspaces",
      targetType: "workspace",
      targetId: "w1",
      result: "success",
      metadata: { statusCode: 201, cwd: "/private/project", terminalContent: "secret", retry: false },
      createdAt: 100,
    });
    const second = store.appendAudit({
      actorType: "device",
      actorId: "device-1",
      action: "PATCH /api/v1/workspaces/:id",
      targetType: "workspace",
      targetId: "w1",
      result: "denied",
      metadata: { statusCode: 403 },
      createdAt: 101,
    });
    expect(second.previousHash).toBe(first.hash);
    expect(store.listAudit()[0]?.metadata).toEqual({ statusCode: 201, retry: false });
    expect(store.listAuditLatest(1)).toEqual([second]);
    expect(store.verifyAuditChain()).toMatchObject({ valid: true, count: 2, head: second.hash });
    store.close();

    const raw = new Database(dbPath);
    expect(() => raw.prepare("DELETE FROM control_audit").run()).toThrow(/append-only/);
    raw.close();
  });

  test("validates and persists explainable automation definitions and bounded runs", () => {
    const dbPath = databasePath();
    const store = openControlStore({ dbPath, generateAutomationId: () => "rca_test" });
    const created = store.createAutomation(
      {
        name: "Archive acknowledged decisions",
        trigger: { eventType: "attention.acknowledged", resourceType: "attention" },
        action: { type: "resolve_attention", target: "event-resource" },
        permissions: ["attention:write"],
      },
      1,
    );
    expect(created).toMatchObject({ id: "rca_test", enabled: true });
    expect(store.updateAutomation(created.id, { enabled: false }, 2)).toMatchObject({ enabled: false, updatedAt: 2 });
    expect(
      store.recordAutomationRun({ automationId: created.id, eventId: 7, status: "succeeded", createdAt: 3 }),
    ).toMatchObject({ id: 1, eventId: 7 });
    expect(store.listAutomationRuns(created.id)).toHaveLength(1);
    store.close();

    const reopened = openControlStore({ dbPath });
    expect(reopened.getAutomation(created.id)?.enabled).toBe(false);
    expect(reopened.removeAutomation(created.id)).toBe(true);
    reopened.close();
  });

  test("falls back to memory and applies the same privacy boundary", () => {
    const store = openControlStore({
      dbPath: ":memory:",
      loadDatabase: () => {
        throw new Error("unavailable");
      },
    });
    expect(store.mode).toBe("memory-fallback");
    expect(privacySafeAuditMetadata({ token: "no", detail: "safe", count: 2 })).toEqual({ detail: "safe", count: 2 });
    expect(() =>
      store.createAutomation({
        name: "bad",
        trigger: { eventType: "not allowed spaces" },
        action: { type: "resolve_attention", target: "event-resource" },
        permissions: ["attention:write"],
      }),
    ).toThrow(/invalid automation/);
    store.close();
  });
});
