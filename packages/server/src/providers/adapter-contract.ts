import { z } from "zod";

export const ADAPTER_CONTRACT_VERSION = 1 as const;

export const adapterCapabilityNames = [
  "probe",
  "launch",
  "resume",
  "state",
  "identity",
  "metadata",
  "usage",
  "login",
  "attachments",
  "cleanup",
] as const;

export type AdapterCapabilityName = (typeof adapterCapabilityNames)[number];
export type AdapterStateAuthority = "native-events" | "runtime-signals" | "pane-heuristics";

export interface AdapterManifestV1 {
  schemaVersion: typeof ADAPTER_CONTRACT_VERSION;
  id: string;
  version: string;
  displayName: string;
  platforms: Array<"darwin" | "linux">;
  resumeIdentity: "optional" | "required" | "unsupported";
  capabilities: Record<AdapterCapabilityName, boolean>;
  stateAuthority: AdapterStateAuthority[];
  /** JSON Schema for the adapter-owned launch options. */
  optionSchema: Record<string, unknown>;
}

const capabilityShape = Object.fromEntries(adapterCapabilityNames.map((name) => [name, z.boolean()])) as Record<
  AdapterCapabilityName,
  z.ZodBoolean
>;

const manifestSchema = z
  .object({
    schemaVersion: z.literal(ADAPTER_CONTRACT_VERSION),
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    displayName: z.string().trim().min(1).max(80),
    platforms: z
      .array(z.enum(["darwin", "linux"]))
      .min(1)
      .max(2),
    resumeIdentity: z.enum(["optional", "required", "unsupported"]),
    capabilities: z.object(capabilityShape).strict(),
    stateAuthority: z
      .array(z.enum(["native-events", "runtime-signals", "pane-heuristics"]))
      .min(1)
      .max(3)
      .refine((items) => new Set(items).size === items.length, "state authority entries must be unique"),
    optionSchema: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (!manifest.capabilities.resume && manifest.resumeIdentity !== "unsupported") {
      context.addIssue({
        code: "custom",
        path: ["resumeIdentity"],
        message: "resumeIdentity must be unsupported when resume is disabled",
      });
    }
    if (manifest.capabilities.resume && manifest.resumeIdentity === "unsupported") {
      context.addIssue({
        code: "custom",
        path: ["resumeIdentity"],
        message: "resumeIdentity must be optional or required when resume is enabled",
      });
    }
  });

export class AdapterManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterManifestError";
  }
}

const schemaBaseKeys = new Set(["type", "title", "description", "default", "enum", "const"]);
const schemaTypeKeys: Record<string, Set<string>> = {
  object: new Set(["properties", "required", "additionalProperties"]),
  array: new Set(["items", "minItems", "maxItems"]),
  string: new Set(["minLength", "maxLength", "pattern"]),
  integer: new Set(["minimum", "maximum"]),
  number: new Set(["minimum", "maximum"]),
  boolean: new Set(),
};

function schemaObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function isSafeAdapterSchemaPattern(pattern: string): boolean {
  if (
    pattern.length > 200 ||
    /\(\?[=!<:]/.test(pattern) ||
    /\\[1-9]/.test(pattern) ||
    /\([^)]*[+*][^)]*\)[+*{]/.test(pattern)
  ) {
    return false;
  }
  try {
    void new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

function scalarMatchesType(value: unknown, type: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return type === undefined;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSchemaDefault(value: unknown, schema: Record<string, unknown>, path: string, depth: number): void {
  const invalid = (detail: string): never => {
    throw new AdapterManifestError(`invalid adapter option schema: ${path}.default ${detail}`);
  };
  if (depth > 6) invalid("exceeds depth 6");
  if (schema.const !== undefined && !sameJsonValue(value, schema.const)) invalid("does not match const");
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJsonValue(value, candidate))) {
    invalid("is not an allowed enum value");
  }
  const type = schema.type;
  if (type === "object") {
    const parsedInput = schemaObject(value);
    if (!parsedInput) return invalid("must be an object");
    const input: Record<string, unknown> = parsedInput;
    const properties = schemaObject(schema.properties) ?? {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in input)) invalid(`is missing required property ${key}`);
    }
    for (const [key, childValue] of Object.entries(input)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) {
        invalid("contains an unsafe property");
      }
      const child = schemaObject(properties[key]);
      if (!child) {
        if (schema.additionalProperties === false) invalid(`contains unsupported property ${key}`);
        continue;
      }
      validateSchemaDefault(childValue, child, `${path}.${key}`, depth + 1);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return invalid("must be an array");
    const values: unknown[] = value;
    const min = typeof schema.minItems === "number" ? schema.minItems : 0;
    const max = typeof schema.maxItems === "number" ? schema.maxItems : 64;
    if (values.length < min || values.length > max) invalid("violates item bounds");
    const parsedItems = schemaObject(schema.items);
    if (!parsedItems) return invalid("has no item schema");
    const items: Record<string, unknown> = parsedItems;
    values.forEach((item, index) => validateSchemaDefault(item, items, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!scalarMatchesType(value, type)) invalid(`must match type ${String(type)}`);
  if (type === "string") {
    const text = value as string;
    const min = typeof schema.minLength === "number" ? schema.minLength : 0;
    const max = typeof schema.maxLength === "number" ? schema.maxLength : 4096;
    if (text.length < min || text.length > max || /[\0\r\n]/.test(text)) invalid("violates string bounds");
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(text)) {
      invalid("does not match pattern");
    }
  }
  if (type === "integer" || type === "number") {
    const number = value as number;
    if (typeof schema.minimum === "number" && number < schema.minimum) invalid("is below minimum");
    if (typeof schema.maximum === "number" && number > schema.maximum) invalid("is above maximum");
  }
}

function validateSchemaNode(schema: Record<string, unknown>, path: string, depth: number): void {
  if (depth > 6) throw new AdapterManifestError(`invalid adapter option schema: ${path} exceeds depth 6`);
  const type = schema.type;
  if (type !== undefined && (typeof type !== "string" || !(type in schemaTypeKeys))) {
    throw new AdapterManifestError(`invalid adapter option schema: ${path}.type is unsupported`);
  }
  if (type === undefined && schema.enum === undefined && schema.const === undefined) {
    throw new AdapterManifestError(`invalid adapter option schema: ${path}.type is required`);
  }
  const allowed = new Set([...schemaBaseKeys, ...(typeof type === "string" ? schemaTypeKeys[type]! : [])]);
  const unknown = Object.keys(schema).find((key) => !allowed.has(key));
  if (unknown) throw new AdapterManifestError(`invalid adapter option schema: ${path}.${unknown} is unsupported`);
  if (schema.title !== undefined && (typeof schema.title !== "string" || schema.title.length > 80)) {
    throw new AdapterManifestError(`invalid adapter option schema: ${path}.title is invalid`);
  }
  if (schema.description !== undefined && (typeof schema.description !== "string" || schema.description.length > 500)) {
    throw new AdapterManifestError(`invalid adapter option schema: ${path}.description is invalid`);
  }
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      schema.enum.length < 1 ||
      schema.enum.length > 64 ||
      schema.enum.some(
        (item) =>
          !["string", "number", "boolean"].includes(typeof item) ||
          (typeof item === "number" && !Number.isFinite(item)),
      ))
  ) {
    throw new AdapterManifestError(`invalid adapter option schema: ${path}.enum must contain bounded scalar values`);
  }
  if (
    Array.isArray(schema.enum) &&
    (new Set(schema.enum.map((item) => JSON.stringify(item))).size !== schema.enum.length ||
      schema.enum.some((item) => !scalarMatchesType(item, type)))
  ) {
    throw new AdapterManifestError(`invalid adapter option schema: ${path}.enum must match its type and be unique`);
  }
  if (
    schema.const !== undefined &&
    (!["string", "number", "boolean"].includes(typeof schema.const) ||
      (typeof schema.const === "number" && !Number.isFinite(schema.const)))
  ) {
    throw new AdapterManifestError(`invalid adapter option schema: ${path}.const must be a scalar value`);
  }
  if (schema.const !== undefined && !scalarMatchesType(schema.const, type)) {
    throw new AdapterManifestError(`invalid adapter option schema: ${path}.const must match its type`);
  }
  if (type === "object") {
    const properties = schemaObject(schema.properties);
    if (schema.properties !== undefined && !properties) {
      throw new AdapterManifestError(`invalid adapter option schema: ${path}.properties must be an object`);
    }
    const entries = Object.entries(properties ?? {});
    if (entries.length > 64)
      throw new AdapterManifestError(`invalid adapter option schema: ${path} has too many properties`);
    for (const [key, child] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) {
        throw new AdapterManifestError(`invalid adapter option schema: ${path} contains an unsafe property`);
      }
      const childSchema = schemaObject(child);
      if (!childSchema) throw new AdapterManifestError(`invalid adapter option schema: ${path}.${key} is invalid`);
      validateSchemaNode(childSchema, `${path}.${key}`, depth + 1);
    }
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.length > 64 ||
        new Set(schema.required).size !== schema.required.length ||
        schema.required.some((key) => typeof key !== "string" || !properties?.[key]))
    ) {
      throw new AdapterManifestError(`invalid adapter option schema: ${path}.required is invalid`);
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
      throw new AdapterManifestError(`invalid adapter option schema: ${path}.additionalProperties must be boolean`);
    }
  } else if (type === "array") {
    const items = schemaObject(schema.items);
    if (!items) throw new AdapterManifestError(`invalid adapter option schema: ${path}.items is required`);
    validateSchemaNode(items, `${path}[]`, depth + 1);
    for (const key of ["minItems", "maxItems"] as const) {
      const value = schema[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 64)) {
        throw new AdapterManifestError(`invalid adapter option schema: ${path}.${key} is invalid`);
      }
    }
    if (
      typeof schema.minItems === "number" &&
      typeof schema.maxItems === "number" &&
      schema.minItems > schema.maxItems
    ) {
      throw new AdapterManifestError(`invalid adapter option schema: ${path} item bounds are inverted`);
    }
  } else if (type === "string") {
    for (const key of ["minLength", "maxLength"] as const) {
      const value = schema[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4096)) {
        throw new AdapterManifestError(`invalid adapter option schema: ${path}.${key} is invalid`);
      }
    }
    if (
      typeof schema.pattern === "string" ? !isSafeAdapterSchemaPattern(schema.pattern) : schema.pattern !== undefined
    ) {
      throw new AdapterManifestError(`invalid adapter option schema: ${path}.pattern is unsafe or invalid`);
    }
    if (
      typeof schema.minLength === "number" &&
      typeof schema.maxLength === "number" &&
      schema.minLength > schema.maxLength
    ) {
      throw new AdapterManifestError(`invalid adapter option schema: ${path} string bounds are inverted`);
    }
  } else if (type === "integer" || type === "number") {
    for (const key of ["minimum", "maximum"] as const) {
      const value = schema[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new AdapterManifestError(`invalid adapter option schema: ${path}.${key} is invalid`);
      }
    }
    if (typeof schema.minimum === "number" && typeof schema.maximum === "number" && schema.minimum > schema.maximum) {
      throw new AdapterManifestError(`invalid adapter option schema: ${path} numeric bounds are inverted`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, "default")) {
    validateSchemaDefault(schema.default, schema, path, depth);
  }
}

/** The supported, bounded JSON Schema subset shared by the server validator, generated UI, and OpenAPI. */
export function validateAdapterOptionSchema(value: unknown): Record<string, unknown> {
  const schema = schemaObject(value);
  if (!schema || schema.type !== "object") {
    throw new AdapterManifestError("invalid adapter option schema: root must be an object schema");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(schema);
  } catch {
    throw new AdapterManifestError("invalid adapter option schema: schema must be JSON serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
    throw new AdapterManifestError("invalid adapter option schema: schema exceeds 16 KiB");
  }
  validateSchemaNode(schema, "options", 0);
  return JSON.parse(encoded) as Record<string, unknown>;
}

export function validateAdapterManifest(value: unknown): AdapterManifestV1 {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    throw new AdapterManifestError(`invalid adapter manifest: ${detail}`);
  }
  const optionSchema = validateAdapterOptionSchema(parsed.data.optionSchema);
  return {
    ...parsed.data,
    platforms: [...parsed.data.platforms],
    capabilities: { ...parsed.data.capabilities },
    stateAuthority: [...parsed.data.stateAuthority],
    optionSchema,
  };
}

function deepFreezeJson<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

/** Validate and freeze the public metadata at the adapter boundary before any lifecycle code can run. */
export function defineAdapterManifest(value: AdapterManifestV1): Readonly<AdapterManifestV1> {
  const manifest = validateAdapterManifest(value);
  return deepFreezeJson({
    ...manifest,
    platforms: [...manifest.platforms],
    capabilities: { ...manifest.capabilities },
    stateAuthority: [...manifest.stateAuthority],
    optionSchema: JSON.parse(JSON.stringify(manifest.optionSchema)) as Record<string, unknown>,
  });
}

export function publicAdapterDescriptor(manifest: AdapterManifestV1, source: "built-in" | "installed") {
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    version: manifest.version,
    schemaVersion: manifest.schemaVersion,
    source,
    enabled: true,
    platforms: [...manifest.platforms],
    resumeIdentity: manifest.resumeIdentity,
    capabilities: { ...manifest.capabilities },
    stateAuthority: [...manifest.stateAuthority],
    optionSchema: JSON.parse(JSON.stringify(manifest.optionSchema)) as Record<string, unknown>,
  };
}
