import { afterEach, describe, expect, it, vi } from "vitest";
import { clearLegacyDefaultsCache, defaultSessionDefaults, normalizeSessionDefaults } from "./defaults";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("remembered session choices", () => {
  it("returns safe non-persistent choices for an unset server document", () => {
    expect(defaultSessionDefaults()).toEqual({ effort: "medium", dangerouslySkip: false });
    expect(normalizeSessionDefaults(undefined)).toEqual({ effort: "medium", dangerouslySkip: false });
  });

  it("normalizes the remembered provider and both providers' launch choices", () => {
    expect(
      normalizeSessionDefaults({
        provider: "codex",
        effort: "high",
        model: "claude-next",
        permissionMode: "plan",
        addDirs: ["/work/claude"],
        codex: {
          model: "gpt-next",
          reasoningEffort: "ultra.reasoning_2",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          profile: "team.default",
          webSearch: true,
          addDirs: ["/work/codex"],
        },
      }),
    ).toEqual({
      provider: "codex",
      effort: "high",
      model: "claude-next",
      dangerouslySkip: false,
      permissionMode: "plan",
      addDirs: ["/work/claude"],
      codex: {
        model: "gpt-next",
        reasoningEffort: "ultra.reasoning_2",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        profile: "team.default",
        webSearch: true,
        addDirs: ["/work/codex"],
      },
    });
  });

  it("drops malformed fields and mutually exclusive ordinary safety choices", () => {
    expect(
      normalizeSessionDefaults({
        provider: "other",
        effort: "bad effort",
        dangerouslySkip: true,
        permissionMode: "plan",
        addDirs: ["relative"],
        unknown: true,
        codex: {
          model: "bad model",
          profile: "bad profile",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          dangerouslyBypassApprovalsAndSandbox: true,
          unknown: true,
        },
      }),
    ).toEqual({
      effort: "medium",
      dangerouslySkip: true,
      codex: { dangerouslyBypassApprovalsAndSandbox: true },
    });
  });

  it("defensively clones remembered directory arrays", () => {
    const source = { addDirs: ["/claude"], codex: { addDirs: ["/codex"] } };
    const normalized = normalizeSessionDefaults(source);
    source.addDirs[0] = "/changed";
    source.codex.addDirs[0] = "/changed";
    expect(normalized.addDirs).toEqual(["/claude"]);
    expect(normalized.codex?.addDirs).toEqual(["/codex"]);
  });

  it("removes the retired browser cache without reading or rewriting it", () => {
    const removeItem = vi.fn();
    const getItem = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { removeItem, getItem, setItem });

    clearLegacyDefaultsCache();

    expect(removeItem).toHaveBeenCalledWith("roamcode.defaults");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("does not throw when the legacy cache cannot be removed", () => {
    vi.stubGlobal("localStorage", {
      removeItem: vi.fn(() => {
        throw new DOMException("storage is read-only", "SecurityError");
      }),
    });
    expect(() => clearLegacyDefaultsCache()).not.toThrow();
  });
});
