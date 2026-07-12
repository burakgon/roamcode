import { z } from "zod";

export interface SessionDefaults {
  effort: string;
  model?: string;
  dangerouslySkip: boolean;
  permissionMode?: string;
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
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
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
    const { sandbox: _sandbox, approvalPolicy: _approvalPolicy, ...dangerousCodex } = codex;
    return dangerousCodex;
  });

const sessionDefaultsSchema = z
  .object({
    effort: effortToken.default("medium"),
    model: modelToken.optional(),
    dangerouslySkip: z.boolean().default(false),
    permissionMode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
    codex: codexDefaultsSchema.optional(),
  })
  .strict()
  .transform((defaults): SessionDefaults => {
    if (!defaults.dangerouslySkip) return defaults;
    const { permissionMode: _permissionMode, ...dangerousDefaults } = defaults;
    return dangerousDefaults;
  });

export function normalizeSessionDefaults(value: unknown): SessionDefaults {
  return sessionDefaultsSchema.parse(value === undefined ? {} : value);
}

export class SessionDefaultsConflictError extends Error {
  constructor(readonly current: StoredSessionDefaults | undefined) {
    super("Session defaults revision conflict");
    this.name = "SessionDefaultsConflictError";
  }
}
