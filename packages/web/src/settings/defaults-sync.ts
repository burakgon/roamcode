import type { ApiClient } from "../api/client";
import { defaultSessionDefaults, normalizeSessionDefaults } from "./defaults";
import type { SessionDefaults } from "./defaults";

export type DefaultsSyncState =
  | { status: "loading"; defaults: SessionDefaults; revision: number }
  | { status: "synced"; defaults: SessionDefaults; revision: number }
  | { status: "unsynced"; defaults: SessionDefaults; revision: number; error: string };

const LOAD_ERROR = "Couldn't load the last session choices from the server. Using built-in defaults.";
const TOP_LEVEL_KEYS = new Set([
  "provider",
  "effort",
  "model",
  "dangerouslySkip",
  "permissionMode",
  "addDirs",
  "codex",
]);
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
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/\u005b\u005d-]*$/;
const SAFE_EFFORT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PATH = /^\/[^\x00-\x1f\x7f]*$/;
const PROVIDERS = new Set(["claude", "codex"]);
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

function optionalPaths(value: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return true;
  const paths = value[key];
  return Array.isArray(paths) && paths.length <= 32 && paths.every((path) => token(path, SAFE_PATH, 4096));
}

function isServerCodexDefaults(value: unknown): boolean {
  const codex = record(value);
  if (!codex || !hasOnlyKeys(codex, CODEX_KEYS)) return false;
  if (!optionalToken(codex, "model", SAFE_MODEL)) return false;
  if (!optionalToken(codex, "reasoningEffort", SAFE_EFFORT)) return false;
  if (!optionalToken(codex, "profile", SAFE_PROFILE)) return false;
  if (!optionalEnum(codex, "sandbox", SANDBOXES)) return false;
  if (!optionalEnum(codex, "approvalPolicy", APPROVAL_POLICIES)) return false;
  if (!optionalPaths(codex, "addDirs")) return false;
  if (Object.prototype.hasOwnProperty.call(codex, "webSearch") && typeof codex.webSearch !== "boolean") return false;
  if (
    Object.prototype.hasOwnProperty.call(codex, "dangerouslyBypassApprovalsAndSandbox") &&
    typeof codex.dangerouslyBypassApprovalsAndSandbox !== "boolean"
  ) {
    return false;
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
  if (!optionalEnum(defaults, "provider", PROVIDERS)) return false;
  if (!optionalToken(defaults, "model", SAFE_MODEL)) return false;
  if (!optionalEnum(defaults, "permissionMode", PERMISSION_MODES)) return false;
  if (!optionalPaths(defaults, "addDirs")) return false;
  if (defaults.dangerouslySkip && Object.prototype.hasOwnProperty.call(defaults, "permissionMode")) return false;
  return !Object.prototype.hasOwnProperty.call(defaults, "codex") || isServerCodexDefaults(defaults.codex);
}

/** Validate and adopt a server response without ever consulting browser persistence. */
export function sessionDefaultsStateFromEnvelope(value: unknown): DefaultsSyncState | undefined {
  const envelope = record(value);
  if (!envelope || !Number.isSafeInteger(envelope.revision) || (envelope.revision as number) < 0) return undefined;
  const revision = envelope.revision as number;
  if (envelope.defaults === null && revision === 0) {
    return { status: "synced", defaults: defaultSessionDefaults(), revision: 0 };
  }
  if (revision < 1 || !isServerSessionDefaults(envelope.defaults)) return undefined;
  return { status: "synced", defaults: normalizeSessionDefaults(envelope.defaults), revision };
}

export async function hydrateSessionDefaults(options: {
  api: Pick<ApiClient, "getSessionDefaults">;
}): Promise<DefaultsSyncState> {
  try {
    const state = sessionDefaultsStateFromEnvelope(await options.api.getSessionDefaults());
    if (state) return state;
  } catch {
    // Fall through to the non-persistent built-in choices.
  }
  return { status: "unsynced", defaults: defaultSessionDefaults(), revision: 0, error: LOAD_ERROR };
}
