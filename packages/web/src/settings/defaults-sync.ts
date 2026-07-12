import { ApiError } from "../api/client";
import type { ApiClient } from "../api/client";
import { normalizeSessionDefaults } from "./defaults";
import type { SessionDefaults } from "./defaults";

export type DefaultsSyncState =
  | { status: "loading"; defaults: SessionDefaults; revision: number }
  | { status: "synced"; defaults: SessionDefaults; revision: number }
  | { status: "unsynced"; defaults: SessionDefaults; revision: number; error: string };

type AuthoritativeDefaults = { defaults: SessionDefaults; revision: number };

const LOAD_ERROR = "Couldn't load defaults from the server. Using this device's cached defaults.";
const SAVE_ERROR = "Couldn't save defaults to the server. Your previous server defaults are still active.";
const CONFLICT_ERROR = "Settings changed on another device. Loaded the latest server defaults.";
const TOP_LEVEL_KEYS = new Set(["effort", "model", "dangerouslySkip", "permissionMode", "codex"]);
const CODEX_KEYS = new Set([
  "model",
  "reasoningEffort",
  "sandbox",
  "approvalPolicy",
  "profile",
  "webSearch",
  "addDirs",
  "dangerouslyBypassApprovalsAndSandbox",
]);
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_EFFORT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PATH = /^\/[^\x00-\x1f\x7f]*$/;
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"]);
const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function token(value: unknown, pattern: RegExp, maxLength = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && pattern.test(value);
}

function optionalToken(value: Record<string, unknown>, key: string, pattern: RegExp): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || token(value[key], pattern);
}

function optionalEnum(value: Record<string, unknown>, key: string, allowed: ReadonlySet<string>): boolean {
  return (
    !Object.prototype.hasOwnProperty.call(value, key) || (typeof value[key] === "string" && allowed.has(value[key]))
  );
}

function isServerCodexDefaults(value: unknown): boolean {
  const codex = record(value);
  if (!codex || !hasOnlyKeys(codex, CODEX_KEYS)) return false;
  if (!optionalToken(codex, "model", SAFE_MODEL)) return false;
  if (!optionalToken(codex, "reasoningEffort", SAFE_EFFORT)) return false;
  if (!optionalToken(codex, "profile", SAFE_PROFILE)) return false;
  if (!optionalEnum(codex, "sandbox", SANDBOXES)) return false;
  if (!optionalEnum(codex, "approvalPolicy", APPROVAL_POLICIES)) return false;
  if (Object.prototype.hasOwnProperty.call(codex, "webSearch") && typeof codex.webSearch !== "boolean") return false;
  if (
    Object.prototype.hasOwnProperty.call(codex, "dangerouslyBypassApprovalsAndSandbox") &&
    typeof codex.dangerouslyBypassApprovalsAndSandbox !== "boolean"
  ) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(codex, "addDirs")) {
    if (!Array.isArray(codex.addDirs) || codex.addDirs.length > 32) return false;
    if (!codex.addDirs.every((path) => token(path, SAFE_PATH, 4096))) return false;
  }
  if (
    codex.dangerouslyBypassApprovalsAndSandbox === true &&
    (Object.prototype.hasOwnProperty.call(codex, "sandbox") ||
      Object.prototype.hasOwnProperty.call(codex, "approvalPolicy"))
  ) {
    return false;
  }
  return true;
}

function isServerSessionDefaults(value: unknown): boolean {
  const defaults = record(value);
  if (!defaults || !hasOnlyKeys(defaults, TOP_LEVEL_KEYS)) return false;
  if (!Object.prototype.hasOwnProperty.call(defaults, "effort") || !token(defaults.effort, SAFE_EFFORT)) return false;
  if (
    !Object.prototype.hasOwnProperty.call(defaults, "dangerouslySkip") ||
    typeof defaults.dangerouslySkip !== "boolean"
  ) {
    return false;
  }
  if (!optionalToken(defaults, "model", SAFE_MODEL)) return false;
  if (!optionalEnum(defaults, "permissionMode", PERMISSION_MODES)) return false;
  if (defaults.dangerouslySkip && Object.prototype.hasOwnProperty.call(defaults, "permissionMode")) return false;
  return !Object.prototype.hasOwnProperty.call(defaults, "codex") || isServerCodexDefaults(defaults.codex);
}

function authoritativeDefaults(value: unknown): AuthoritativeDefaults | undefined {
  const envelope = record(value);
  if (!envelope || !isServerSessionDefaults(envelope.defaults)) return undefined;
  if (!Number.isSafeInteger(envelope.revision) || (envelope.revision as number) < 1) return undefined;
  return {
    defaults: normalizeSessionDefaults(envelope.defaults),
    revision: envelope.revision as number,
  };
}

function conflictDefaults(error: unknown): AuthoritativeDefaults | undefined {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== "SETTINGS_CONFLICT") return undefined;
  const body = record(error.body);
  if (!body || body.code !== "SETTINGS_CONFLICT") return undefined;
  return authoritativeDefaults(body.current);
}

function synced(authoritative: AuthoritativeDefaults): DefaultsSyncState {
  return { status: "synced", ...authoritative };
}

export async function hydrateSessionDefaults(options: {
  api: Pick<ApiClient, "getSessionDefaults" | "putSessionDefaults">;
  local: SessionDefaults;
}): Promise<DefaultsSyncState> {
  const local = normalizeSessionDefaults(options.local);
  let server;
  try {
    server = await options.api.getSessionDefaults();
  } catch {
    return { status: "unsynced", defaults: local, revision: 0, error: LOAD_ERROR };
  }

  const authoritative = authoritativeDefaults(server);
  if (authoritative) return synced(authoritative);

  if (server.defaults !== null || server.revision !== 0) {
    return { status: "unsynced", defaults: local, revision: 0, error: LOAD_ERROR };
  }

  try {
    const migrated = authoritativeDefaults(await options.api.putSessionDefaults(local, 0));
    if (!migrated) return { status: "unsynced", defaults: local, revision: 0, error: SAVE_ERROR };
    return synced(migrated);
  } catch (error: unknown) {
    const current = conflictDefaults(error);
    if (current) return synced(current);
    return { status: "unsynced", defaults: local, revision: 0, error: SAVE_ERROR };
  }
}

export async function persistSessionDefaults(options: {
  api: Pick<ApiClient, "putSessionDefaults">;
  defaults: SessionDefaults;
  revision: number;
}): Promise<DefaultsSyncState> {
  const defaults = normalizeSessionDefaults(options.defaults);
  try {
    const saved = authoritativeDefaults(await options.api.putSessionDefaults(defaults, options.revision));
    if (!saved) return { status: "unsynced", defaults, revision: options.revision, error: SAVE_ERROR };
    return synced(saved);
  } catch (error: unknown) {
    const current = conflictDefaults(error);
    if (current) {
      return { status: "unsynced", ...current, error: CONFLICT_ERROR };
    }
    return { status: "unsynced", defaults, revision: options.revision, error: SAVE_ERROR };
  }
}
