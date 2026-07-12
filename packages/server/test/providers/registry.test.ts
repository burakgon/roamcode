import { describe, expect, test } from "vitest";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { ProviderError, type AgentProvider, type ProviderId } from "../../src/providers/types.js";

function provider(id: ProviderId): AgentProvider {
  return {
    id,
    displayName: id,
    resumeIdentity: id === "codex" ? "required" : "optional",
    probe: () => Promise.resolve({ terminalAvailable: true, metadataAvailable: true }),
    buildProcess: () => Promise.resolve({ executable: id, args: [], env: {}, cleanupPaths: [] }),
    runtimeSignals: () => [],
    classifyPane: () => "idle",
    cleanup: () => {},
  };
}

describe("ProviderRegistry", () => {
  test("returns the provider registered for an exact id", () => {
    const codex = provider("codex");
    expect(new ProviderRegistry([provider("claude"), codex]).get("codex")).toBe(codex);
  });

  test("rejects duplicate ids", () => {
    expect(() => new ProviderRegistry([provider("codex"), provider("codex")])).toThrow(/duplicate.*codex/i);
  });

  test("fails closed when a provider is unavailable", () => {
    try {
      new ProviderRegistry([]).get("codex");
      throw new Error("expected unavailable provider to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe("PROVIDER_UNAVAILABLE");
    }
  });
});
