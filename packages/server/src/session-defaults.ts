import { z } from "zod";
import type { ProviderId, ProviderSessionOptions } from "./providers/types.js";

export interface SessionDefaults {
  /** The provider used by the most recently created session. Absent only for legacy saved documents. */
  provider?: ProviderId;
  effort: string;
  model?: string;
  dangerouslySkip: boolean;
  permissionMode?: string;
  addDirs?: string[];
  codex?: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-request" | "never";
    profile?: string;
    webSearch?: boolean;
    addDirs?: string[];
    dangerouslyBypassApprovalsAndSandbox?: boolean;
  };
}

export interface StoredSessionDefaults {
  defaults: SessionDefaults;
  revision: number;
  updatedAt: number;
}

const MAX_MODEL = 128;
const MAX_PROFILE = 128;
const MAX_PATH = 4096;
const MAX_ADD_DIRS = 32;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/\u005b\u005d-]*$/;
const SAFE_EFFORT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PATH = /^\/[^\x00-\x1f\x7f]*$/;

const modelToken = z.string().min(1).max(MAX_MODEL).regex(SAFE_MODEL, "must be a safe model token");
const effortToken = z.string().min(1).max(128).regex(SAFE_EFFORT, "must be a safe effort token");
const profileToken = z.string().min(1).max(MAX_PROFILE).regex(SAFE_PROFILE, "must be a safe profile token");
const pathToken = z.string().min(1).max(MAX_PATH).regex(SAFE_PATH, "must be a safe absolute path");

const codexDefaultsSchema = z
  .object({
    model: modelToken.optional(),
    reasoningEffort: effortToken.optional(),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
    profile: profileToken.optional(),
    webSearch: z.boolean().optional(),
    addDirs: z.array(pathToken).max(MAX_ADD_DIRS).optional(),
    dangerouslyBypassApprovalsAndSandbox: z.boolean().optional(),
  })
  .strict()
  .transform((codex) => {
    if (codex.dangerouslyBypassApprovalsAndSandbox !== true) return codex;
    const dangerousCodex = { ...codex };
    delete dangerousCodex.sandbox;
    delete dangerousCodex.approvalPolicy;
    return dangerousCodex;
  });

const sessionDefaultsSchema = z
  .object({
    provider: z.enum(["claude", "codex"]).optional(),
    effort: effortToken.default("medium"),
    model: modelToken.optional(),
    dangerouslySkip: z.boolean().default(false),
    permissionMode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
    addDirs: z.array(pathToken).max(MAX_ADD_DIRS).optional(),
    codex: codexDefaultsSchema.optional(),
  })
  .strict()
  .transform((defaults): SessionDefaults => {
    if (!defaults.dangerouslySkip) return defaults;
    const dangerousDefaults = { ...defaults };
    delete dangerousDefaults.permissionMode;
    return dangerousDefaults;
  });

export function normalizeSessionDefaults(value: unknown): SessionDefaults {
  return sessionDefaultsSchema.parse(value === undefined ? {} : value);
}

/**
 * Convert the exact options accepted for a successful launch into the next wizard's remembered choices.
 * The selected provider becomes the next provider, while the other provider's last choices are retained so
 * switching providers does not erase them. Per-session cwd/name and legacy passthrough args are never remembered.
 */
export function sessionDefaultsForLaunch(
  previous: SessionDefaults | undefined,
  options: ProviderSessionOptions,
): SessionDefaults {
  const current = normalizeSessionDefaults(previous);
  if (options.provider === "claude") {
    const retained = { ...current };
    delete retained.model;
    delete retained.permissionMode;
    delete retained.addDirs;
    delete retained.provider;
    return normalizeSessionDefaults({
      ...retained,
      provider: "claude",
      effort: options.effort ?? "medium",
      dangerouslySkip: options.dangerouslySkip === true,
      ...(options.model ? { model: options.model } : {}),
      ...(options.dangerouslySkip !== true && options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.addDirs?.length ? { addDirs: [...options.addDirs] } : {}),
    });
  }

  const retained = { ...current };
  delete retained.codex;
  delete retained.provider;
  const codex = {
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(typeof options.webSearch === "boolean" ? { webSearch: options.webSearch } : {}),
    ...(options.addDirs?.length ? { addDirs: [...options.addDirs] } : {}),
    ...(options.dangerouslyBypassApprovalsAndSandbox === true ? { dangerouslyBypassApprovalsAndSandbox: true } : {}),
  };
  return normalizeSessionDefaults({ ...retained, provider: "codex", codex });
}

export class SessionDefaultsConflictError extends Error {
  constructor(readonly current: StoredSessionDefaults | undefined) {
    super("Session defaults revision conflict");
    this.name = "SessionDefaultsConflictError";
  }
}
