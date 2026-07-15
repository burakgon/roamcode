import { z } from "zod";
import { ProviderError } from "./types.js";
import type { ClaudeSessionOptions, ProviderId, ProviderSessionOptions } from "./types.js";
import { isSafeAdapterSchemaPattern } from "./adapter-contract.js";

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

export function parseProviderOptions(
  provider: ProviderId,
  raw: unknown,
  optionSchema?: Record<string, unknown>,
): ProviderSessionOptions {
  try {
    if (provider === "claude") {
      return { provider, ...claudeOptionsSchema.parse(raw) };
    }
    if (provider === "codex") {
      return { provider, ...codexOptionsSchema.parse(raw) };
    }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider) || !optionSchema) {
      throw new ProviderOptionsError(`Invalid provider options: unknown provider ${String(provider)}`);
    }
    const value = validateJsonSchemaValue(raw, optionSchema, "options", 0);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ProviderOptionsError("Invalid provider options: options must be an object");
    }
    return { provider, ...(value as Record<string, unknown>) };
  } catch (error) {
    if (error instanceof z.ZodError) throw invalidOptions(error);
    throw error;
  }
}

function schemaError(path: string, detail: string): never {
  throw new ProviderOptionsError(`Invalid provider options: ${path} ${detail}`);
}

function validateJsonSchemaValue(
  value: unknown,
  rawSchema: Record<string, unknown>,
  path: string,
  depth: number,
): unknown {
  if (depth > 6) schemaError(path, "exceeds the supported schema depth");
  if (rawSchema.const !== undefined && JSON.stringify(value) !== JSON.stringify(rawSchema.const)) {
    schemaError(path, "does not match const");
  }
  if (Array.isArray(rawSchema.enum) && !rawSchema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    schemaError(path, "is not an allowed value");
  }
  const type = rawSchema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) schemaError(path, "must be an object");
    const input = value as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > 16 * 1024) schemaError(path, "exceeds 16 KiB");
    const properties =
      rawSchema.properties && typeof rawSchema.properties === "object" && !Array.isArray(rawSchema.properties)
        ? (rawSchema.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(rawSchema.required)
      ? rawSchema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) if (!(key in input)) schemaError(`${path}.${key}`, "is required");
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) {
        schemaError(path, "contains an unsafe key");
      }
      const child = properties[key];
      if (child === undefined) {
        if (rawSchema.additionalProperties === false) schemaError(`${path}.${key}`, "is not supported");
        output[key] = JSON.parse(JSON.stringify(item)) as unknown;
        continue;
      }
      if (!child || typeof child !== "object" || Array.isArray(child))
        schemaError(`${path}.${key}`, "has invalid schema");
      output[key] = validateJsonSchemaValue(item, child as Record<string, unknown>, `${path}.${key}`, depth + 1);
    }
    return output;
  }
  if (type === "array") {
    if (!Array.isArray(value)) schemaError(path, "must be an array");
    const maxItems = typeof rawSchema.maxItems === "number" ? rawSchema.maxItems : 64;
    const minItems = typeof rawSchema.minItems === "number" ? rawSchema.minItems : 0;
    if (value.length < minItems || value.length > Math.min(maxItems, 64))
      schemaError(path, "has an invalid item count");
    const itemSchema = rawSchema.items;
    if (!itemSchema || typeof itemSchema !== "object" || Array.isArray(itemSchema))
      schemaError(path, "has no item schema");
    return value.map((item, index) =>
      validateJsonSchemaValue(item, itemSchema as Record<string, unknown>, `${path}[${index}]`, depth + 1),
    );
  }
  if (type === "string") {
    if (typeof value !== "string") schemaError(path, "must be a string");
    const min = typeof rawSchema.minLength === "number" ? rawSchema.minLength : 0;
    const max = typeof rawSchema.maxLength === "number" ? Math.min(rawSchema.maxLength, 4096) : 4096;
    if (value.length < min || value.length > max || /[\0\r\n]/.test(value))
      schemaError(path, "has invalid length or controls");
    if (typeof rawSchema.pattern === "string") {
      if (!isSafeAdapterSchemaPattern(rawSchema.pattern)) schemaError(path, "has an unsupported pattern");
      try {
        if (!new RegExp(rawSchema.pattern, "u").test(value)) schemaError(path, "does not match its pattern");
      } catch (error) {
        if (error instanceof ProviderOptionsError) throw error;
        schemaError(path, "has an invalid pattern");
      }
    }
    return value;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") schemaError(path, "must be a boolean");
    return value;
  }
  if (type === "integer" || type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isSafeInteger(value))) {
      schemaError(path, `must be a ${type}`);
    }
    if (typeof rawSchema.minimum === "number" && value < rawSchema.minimum) schemaError(path, "is below minimum");
    if (typeof rawSchema.maximum === "number" && value > rawSchema.maximum) schemaError(path, "is above maximum");
    return value;
  }
  if (type === undefined && (rawSchema.enum !== undefined || rawSchema.const !== undefined)) return value;
  schemaError(path, "uses an unsupported schema type");
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
