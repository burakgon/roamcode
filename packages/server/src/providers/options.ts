import { z } from "zod";
import { ProviderError } from "./types.js";
import type { ClaudeSessionOptions, ProviderId, ProviderSessionOptions } from "./types.js";

const MAX_MODEL_LENGTH = 128;
const MAX_PROFILE_LENGTH = 128;
const MAX_PATH_LENGTH = 4096;
const MAX_ADD_DIRS = 32;
const MAX_LEGACY_ARGS = 128;
const MAX_LEGACY_ARG_LENGTH = 4096;

const modelToken = z
  .string()
  .min(1)
  .max(MAX_MODEL_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/\u005b\u005d-]*$/, "must be a safe model token");

const profileToken = z
  .string()
  .min(1)
  .max(MAX_PROFILE_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe profile token");

const effortToken = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe effort token");

const pathToken = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .regex(/^\/[^\x00-\x1f\x7f]*$/, "must be an absolute path without control characters");

const addDirs = z.array(pathToken).max(MAX_ADD_DIRS);

const claudeOptionsSchema = z
  .object({
    model: modelToken.optional(),
    effort: effortToken.optional(),
    permissionMode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
    dangerouslySkip: z.boolean().optional(),
    addDirs: addDirs.optional(),
  })
  .strict()
  .superRefine((options, context) => {
    if (options.dangerouslySkip === true && options.permissionMode !== undefined) {
      context.addIssue({
        code: "custom",
        message: "dangerouslySkip and permissionMode are mutually exclusive",
      });
    }
  });

const codexOptionsSchema = z
  .object({
    model: modelToken.optional(),
    reasoningEffort: effortToken.optional(),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
    profile: profileToken.optional(),
    webSearch: z.boolean().optional(),
    dangerouslyBypassApprovalsAndSandbox: z.boolean().optional(),
    addDirs: addDirs.optional(),
  })
  .strict()
  .superRefine((options, context) => {
    if (
      options.dangerouslyBypassApprovalsAndSandbox === true &&
      (options.sandbox !== undefined || options.approvalPolicy !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "dangerouslyBypassApprovalsAndSandbox is mutually exclusive with sandbox and approvalPolicy",
      });
    }
  });

const legacyArgSchema = z
  .string()
  .max(MAX_LEGACY_ARG_LENGTH)
  .refine((arg) => !arg.includes("\0"), {
    message: "must not contain a null byte",
  });
const legacyArgsSchema = z.array(legacyArgSchema).max(MAX_LEGACY_ARGS);

export class ProviderOptionsError extends ProviderError {
  constructor(message: string) {
    super("INVALID_PROVIDER_OPTIONS", message);
    this.name = "ProviderOptionsError";
  }
}

function invalidOptions(error: z.ZodError): ProviderOptionsError {
  const detail = error.issues.map((issue) => issue.message).join("; ");
  return new ProviderOptionsError(`Invalid provider options: ${detail}`);
}

export function parseProviderOptions(provider: ProviderId, raw: unknown): ProviderSessionOptions {
  try {
    if (provider === "claude") {
      return { provider, ...claudeOptionsSchema.parse(raw) };
    }
    if (provider === "codex") {
      return { provider, ...codexOptionsSchema.parse(raw) };
    }
  } catch (error) {
    if (error instanceof z.ZodError) throw invalidOptions(error);
    throw error;
  }

  throw new ProviderOptionsError(`Invalid provider options: unknown provider ${String(provider)}`);
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ProviderOptionsError(`Invalid provider options: ${flag} requires a value`);
  }
  return value;
}

export function parseLegacyClaudeArgs(args: readonly string[]): ClaudeSessionOptions {
  let parsedArgs: string[];
  try {
    parsedArgs = legacyArgsSchema.parse(args);
  } catch (error) {
    if (error instanceof z.ZodError) throw invalidOptions(error);
    throw error;
  }

  const raw: Record<string, unknown> = {};
  const parsedAddDirs: string[] = [];
  const legacyArgs: string[] = [];

  for (let index = 0; index < parsedArgs.length; index += 1) {
    const arg = parsedArgs[index]!;
    if (arg === "--") {
      legacyArgs.push(...parsedArgs.slice(index));
      break;
    }

    switch (arg) {
      case "--model":
        raw.model = requireValue(parsedArgs, index, arg);
        index += 1;
        break;
      case "--effort":
        raw.effort = requireValue(parsedArgs, index, arg);
        index += 1;
        break;
      case "--permission-mode":
        raw.permissionMode = requireValue(parsedArgs, index, arg);
        index += 1;
        break;
      case "--dangerously-skip-permissions":
        raw.dangerouslySkip = true;
        break;
      case "--add-dir":
        parsedAddDirs.push(requireValue(parsedArgs, index, arg));
        index += 1;
        break;
      default:
        legacyArgs.push(arg);
    }
  }

  if (parsedAddDirs.length > 0) raw.addDirs = parsedAddDirs;
  const parsed = parseProviderOptions("claude", raw) as ClaudeSessionOptions;
  return legacyArgs.length > 0 ? { ...parsed, legacyArgs } : parsed;
}
