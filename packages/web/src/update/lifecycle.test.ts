import { describe, expect, it } from "vitest";
import type { VersionInfo } from "../types/server";
import {
  loadUpdateOperation,
  operationReachedTarget,
  saveUpdateOperation,
  statusBelongsToOperation,
  updateProgressDetail,
  updateProgressLabel,
  type StorageLike,
  type UpdateOperation,
} from "./lifecycle";

const operation: UpdateOperation = {
  operationId: "new-op",
  target: "1.1.0",
  fromVersion: "1.0.0",
  action: "update",
  startedAt: 100,
};

function info(over: Partial<VersionInfo> = {}): VersionInfo {
  return {
    current: "v1.0.0",
    latest: "v1.1.0",
    behind: 1,
    releaseCount: 1,
    updatable: true,
    updateAvailable: true,
    updateAction: "update",
    installation: "managed",
    changelog: [],
    runningVersion: "1.0.0",
    activeVersion: "1.0.0",
    installDrift: false,
    checkStatus: "fresh",
    runningBuild: "1.0.0",
    buildDrift: false,
    ...over,
  };
}

describe("OTA lifecycle", () => {
  it("persists enough context to resume after a PWA reload", () => {
    const values = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
    saveUpdateOperation(operation, storage);
    expect(loadUpdateOperation(storage)).toEqual(operation);
    saveUpdateOperation(undefined, storage);
    expect(loadUpdateOperation(storage)).toBeUndefined();
  });

  it("ignores stale status from an earlier attempt", () => {
    expect(statusBelongsToOperation({ operationId: "old-op", state: "failed", target: "1.1.0" }, operation)).toBe(
      false,
    );
    expect(statusBelongsToOperation({ operationId: "new-op", state: "installing", target: "1.1.0" }, operation)).toBe(
      true,
    );
  });

  it("accepts the target runtime as success even if the final status write was lost", () => {
    expect(operationReachedTarget(info({ current: "v1.1.0", runningVersion: "1.1.0" }), operation)).toBe(true);
    expect(operationReachedTarget(info(), operation)).toBe(false);
  });

  it("uses explicit reconnecting and slow copy instead of leaving users on Starting", () => {
    expect(updateProgressLabel({ state: "starting" }, "reconnecting", "1.1.0")).toMatch(/reconnecting/i);
    expect(updateProgressDetail("slow")).toMatch(/longer than usual/i);
  });
});
