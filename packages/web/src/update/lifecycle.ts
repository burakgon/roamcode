import type { UpdateStatus, VersionInfo } from "../types/server";

export type UpdateConnectionState = "connected" | "checking" | "reconnecting" | "slow";
export type UpdateOperationAction = "update" | "migrate" | "restart" | "rollback";

/** Minimal durable client context. The server remains authoritative; this only lets a reopened PWA
 * resume watching the exact operation instead of forgetting it or accepting a stale status file. */
export interface UpdateOperation {
  operationId?: string;
  target: string;
  fromVersion: string;
  action: UpdateOperationAction;
  startedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const UPDATE_OPERATION_KEY = "rc-update-operation-v1";
export const UPDATE_SLOW_MS = 45_000;

export function bareVersion(value: string | undefined): string | undefined {
  return value?.trim().replace(/^v/, "") || undefined;
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadUpdateOperation(storage: StorageLike | undefined = browserStorage()): UpdateOperation | undefined {
  if (!storage) return undefined;
  try {
    const value = JSON.parse(storage.getItem(UPDATE_OPERATION_KEY) ?? "null") as Partial<UpdateOperation> | null;
    if (
      !value ||
      typeof value.target !== "string" ||
      typeof value.fromVersion !== "string" ||
      typeof value.startedAt !== "number" ||
      !["update", "migrate", "restart", "rollback"].includes(value.action ?? "")
    )
      return undefined;
    return {
      ...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
      target: bareVersion(value.target) ?? value.target,
      fromVersion: bareVersion(value.fromVersion) ?? value.fromVersion,
      action: value.action as UpdateOperationAction,
      startedAt: value.startedAt,
    };
  } catch {
    return undefined;
  }
}

export function saveUpdateOperation(
  operation: UpdateOperation | undefined,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    if (operation) storage.setItem(UPDATE_OPERATION_KEY, JSON.stringify(operation));
    else storage.removeItem(UPDATE_OPERATION_KEY);
  } catch {
    // Storage can be blocked in private mode. The in-memory lifecycle still works.
  }
}

/** Only consume status belonging to this attempt. Old `failed`/`done` files must not end a new retry. */
export function statusBelongsToOperation(status: UpdateStatus, operation: UpdateOperation): boolean {
  if (operation.operationId && status.operationId && status.operationId !== operation.operationId) return false;
  if (!operation.operationId && status.operationId && (status.updatedAt ?? 0) < operation.startedAt) return false;
  const statusTarget = bareVersion(status.target);
  if (operation.action === "rollback" && operation.target === "previous") return true;
  return !statusTarget || statusTarget === operation.target;
}

/** Version/runtime truth is a second success signal in case the final status write races the restart. */
export function operationReachedTarget(info: VersionInfo, operation: UpdateOperation): boolean {
  if (bareVersion(info.current) !== operation.target) return false;
  if (operation.action === "restart") return info.installDrift === false;
  if (operation.action === "migrate") return info.installation === "managed" && info.installDrift === false;
  return operation.fromVersion !== operation.target;
}

export const UPDATE_STEPS = ["Prepare", "Install", "Verify", "Switch", "Reconnect"] as const;

export function updateStepIndex(state: UpdateStatus["state"] | undefined): number {
  switch (state) {
    case "installing":
      return 1;
    case "verifying":
      return 2;
    case "activating":
      return 3;
    case "restarting":
      return 4;
    case "done":
      return UPDATE_STEPS.length;
    default:
      return 0;
  }
}

export function updateProgressLabel(
  status: UpdateStatus | undefined,
  connection: UpdateConnectionState,
  target?: string,
): string {
  if (connection === "checking") return "Checking update progress…";
  if (connection === "reconnecting") return "Server restarting — reconnecting…";
  const version = bareVersion(target ?? status?.target);
  switch (status?.state) {
    case "downloading":
      return "Checking the release package…";
    case "installing":
      return `Installing${version ? ` v${version}` : " the update"}…`;
    case "verifying":
      return "Verifying the new version…";
    case "activating":
      return "Switching to the new version…";
    case "restarting":
      return "Restarting the server…";
    case "done":
      return "Update complete";
    default:
      return "Preparing the update…";
  }
}

export function updateProgressDetail(connection: UpdateConnectionState): string {
  if (connection === "checking") return "RoamCode is finding the background update and will resume its progress here.";
  if (connection === "reconnecting")
    return "A short disconnect is expected. RoamCode is checking when the server is back.";
  if (connection === "slow")
    return "This is taking longer than usual. The update continues in the background and your current version stays available if it fails.";
  return "You can hide this panel. The update continues safely in the background.";
}
