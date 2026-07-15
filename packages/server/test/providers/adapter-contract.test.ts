import { describe, expect, test } from "vitest";
import {
  ADAPTER_CONTRACT_VERSION,
  AdapterManifestError,
  createClaudeProvider,
  createCodexProvider,
  ProviderRegistry,
  validateAdapterManifest,
} from "../../src/index.js";

describe("public provider adapter v1 contract", () => {
  test("built-in Claude and Codex adapters use the same validated public contract", () => {
    const claude = createClaudeProvider({ claudeBin: "claude", env: {} });
    const codex = createCodexProvider({ codexBin: "codex", env: {} });
    const registry = new ProviderRegistry([claude, codex]);

    expect(registry.descriptors()).toEqual([
      expect.objectContaining({
        id: "claude",
        schemaVersion: ADAPTER_CONTRACT_VERSION,
        source: "built-in",
        capabilities: expect.objectContaining({ launch: true, resume: true, attachments: true }),
      }),
      expect.objectContaining({
        id: "codex",
        schemaVersion: ADAPTER_CONTRACT_VERSION,
        stateAuthority: ["native-events", "runtime-signals", "pane-heuristics"],
      }),
    ]);
    expect(registry.manifest("claude")).toEqual(claude.manifest);
    expect(Object.isFrozen(claude.manifest)).toBe(true);
    expect(Object.isFrozen(codex.manifest.capabilities)).toBe(true);
    expect(Object.isFrozen(registry.manifest("claude").optionSchema.properties)).toBe(true);
  });

  test("rejects unknown fields, unsafe ids, and contradictory resume declarations", () => {
    const valid = createClaudeProvider({ claudeBin: "claude" }).manifest;
    expect(() => validateAdapterManifest({ ...valid, id: "../../escape" })).toThrow(AdapterManifestError);
    expect(() => validateAdapterManifest({ ...valid, unexpected: true })).toThrow(/unrecognized/i);
    expect(() =>
      validateAdapterManifest({
        ...valid,
        capabilities: { ...valid.capabilities, resume: false },
        resumeIdentity: "required",
      }),
    ).toThrow(/resumeIdentity/);
  });

  test("publishes a closed JSON Schema for each adapter's launch options", () => {
    for (const adapter of [createClaudeProvider({ claudeBin: "claude" }), createCodexProvider({ codexBin: "codex" })]) {
      expect(adapter.manifest.optionSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(Object.keys(adapter.manifest.capabilities)).toHaveLength(10);
    }
  });

  test("rejects schema features the runtime and generated form cannot enforce safely", () => {
    const valid = createClaudeProvider({ claudeBin: "claude" }).manifest;
    expect(() =>
      validateAdapterManifest({
        ...valid,
        optionSchema: { type: "object", properties: { mode: { oneOf: [{ const: "a" }, { const: "b" }] } } },
      }),
    ).toThrow(/type is required|oneOf is unsupported/);
    expect(() =>
      validateAdapterManifest({
        ...valid,
        optionSchema: {
          type: "object",
          properties: { input: { type: "string", pattern: "^(a+)+$" } },
        },
      }),
    ).toThrow(/pattern is unsafe/);
    expect(() =>
      validateAdapterManifest({
        ...valid,
        optionSchema: { type: "object", properties: { mode: { enum: [{ nested: true }] } }, required: ["mode"] },
      }),
    ).toThrow(/scalar values/);
    expect(() =>
      validateAdapterManifest({
        ...valid,
        optionSchema: {
          type: "object",
          properties: { retries: { type: "integer", minimum: 1, maximum: 3, default: 9 } },
        },
      }),
    ).toThrow(/default is above maximum/);
    expect(() =>
      validateAdapterManifest({
        ...valid,
        optionSchema: {
          type: "object",
          properties: { mode: { type: "string", enum: [1, 2] } },
        },
      }),
    ).toThrow(/enum must match its type/);
  });
});
