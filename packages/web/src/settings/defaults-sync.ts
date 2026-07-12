import { ApiError } from "../api/client";
import type { ApiClient } from "../api/client";
import { normalizeSessionDefaults, saveDefaults } from "./defaults";
import type { SessionDefaults } from "./defaults";

export type DefaultsSyncState =
  | { status: "loading"; defaults: SessionDefaults; revision: number }
  | { status: "synced"; defaults: SessionDefaults; revision: number }
  | { status: "unsynced"; defaults: SessionDefaults; revision: number; error: string };

type AuthoritativeDefaults = { defaults: SessionDefaults; revision: number };

const LOAD_ERROR = "Couldn't load defaults from the server. Using this device's cached defaults.";
const SAVE_ERROR = "Couldn't save defaults to the server. Your previous server defaults are still active.";
const CONFLICT_ERROR = "Settings changed on another device. Loaded the latest server defaults.";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function authoritativeDefaults(value: unknown): AuthoritativeDefaults | undefined {
  const envelope = record(value);
  if (!envelope || !record(envelope.defaults)) return undefined;
  if (!Number.isSafeInteger(envelope.revision) || (envelope.revision as number) < 0) return undefined;
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

function cacheAuthoritative(authoritative: AuthoritativeDefaults): DefaultsSyncState {
  saveDefaults(authoritative.defaults);
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
  if (authoritative) return cacheAuthoritative(authoritative);

  if (server.defaults !== null || server.revision !== 0) {
    return { status: "unsynced", defaults: local, revision: 0, error: LOAD_ERROR };
  }

  try {
    const migrated = authoritativeDefaults(await options.api.putSessionDefaults(local, 0));
    if (!migrated) return { status: "unsynced", defaults: local, revision: 0, error: SAVE_ERROR };
    return cacheAuthoritative(migrated);
  } catch (error: unknown) {
    const current = conflictDefaults(error);
    if (current) return cacheAuthoritative(current);
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
    return cacheAuthoritative(saved);
  } catch (error: unknown) {
    const current = conflictDefaults(error);
    if (current) {
      saveDefaults(current.defaults);
      return { status: "unsynced", ...current, error: CONFLICT_ERROR };
    }
    return { status: "unsynced", defaults, revision: options.revision, error: SAVE_ERROR };
  }
}
