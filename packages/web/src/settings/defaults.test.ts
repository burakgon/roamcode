import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDefaults, saveDefaults } from "./defaults";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("session defaults", () => {
  it("returns safe fallbacks when nothing is stored", () => {
    expect(loadDefaults()).toEqual({ effort: "medium", dangerouslySkip: false });
  });
  it("round-trips saved defaults", () => {
    saveDefaults({ effort: "high", model: "opus[1m]", dangerouslySkip: true });
    expect(loadDefaults()).toEqual({ effort: "high", model: "opus[1m]", dangerouslySkip: true });
  });
  it("ignores corrupt storage and falls back", () => {
    localStorage.setItem("roamcode.defaults", "not json");
    expect(loadDefaults().effort).toBe("medium");
    expect(JSON.parse(localStorage.getItem("roamcode.defaults")!)).toEqual({
      effort: "medium",
      dangerouslySkip: false,
    });
  });
  it("round-trips a known default permission mode and drops an invalid one", () => {
    saveDefaults({ effort: "medium", dangerouslySkip: false, permissionMode: "plan" });
    expect(loadDefaults().permissionMode).toBe("plan");
    localStorage.setItem(
      "roamcode.defaults",
      JSON.stringify({ effort: "medium", dangerouslySkip: false, permissionMode: "bogus" }),
    );
    expect(loadDefaults().permissionMode).toBeUndefined();
  });

  it("drops the ordinary Claude permission mode when dangerous defaults are armed", () => {
    localStorage.setItem(
      "roamcode.defaults",
      JSON.stringify({ effort: "high", dangerouslySkip: true, permissionMode: "plan" }),
    );
    expect(loadDefaults()).toEqual({ effort: "high", dangerouslySkip: true });
    expect(JSON.parse(localStorage.getItem("roamcode.defaults")!)).toEqual({
      effort: "high",
      dangerouslySkip: true,
    });
  });

  it("never loads or saves a provider choice and strips malformed or unknown keys", () => {
    localStorage.setItem(
      "roamcode.defaults",
      JSON.stringify({
        provider: "codex",
        effort: "high",
        unknown: "drop-me",
        codex: {
          model: "gpt-future-custom",
          reasoningEffort: "high",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          webSearch: true,
          provider: "codex",
          malformed: "drop-me",
        },
      }),
    );

    const migrated = loadDefaults();
    expect(migrated).toEqual({
      effort: "high",
      dangerouslySkip: false,
      codex: {
        model: "gpt-future-custom",
        reasoningEffort: "high",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        webSearch: true,
      },
    });
    expect(JSON.parse(localStorage.getItem("roamcode.defaults")!)).toEqual(migrated);

    saveDefaults({
      effort: "medium",
      dangerouslySkip: false,
      codex: { model: "gpt-future-custom", reasoningEffort: "xhigh" },
      provider: "codex",
      malformed: true,
    } as never);
    expect(JSON.parse(localStorage.getItem("roamcode.defaults")!)).toEqual({
      effort: "medium",
      dangerouslySkip: false,
      codex: { model: "gpt-future-custom", reasoningEffort: "xhigh" },
    });
  });

  it("round-trips bounded future Codex reasoning tokens", () => {
    const future: Parameters<typeof saveDefaults>[0] = {
      effort: "medium",
      dangerouslySkip: false,
      codex: { model: "gpt-future", reasoningEffort: "ultra.reasoning_2" },
    };

    saveDefaults(future);

    expect(loadDefaults()).toEqual(future);
    expect(JSON.parse(localStorage.getItem("roamcode.defaults")!)).toEqual(future);
  });

  it("drops unsafe or overlong Codex tokens but preserves bounded unknown custom models", () => {
    localStorage.setItem(
      "roamcode.defaults",
      JSON.stringify({
        effort: "medium",
        codex: {
          model: `g${"x".repeat(128)}`,
          profile: "bad profile",
          reasoningEffort: "bad effort",
          sandbox: "host-root",
        },
      }),
    );
    expect(loadDefaults().codex).toBeUndefined();

    localStorage.setItem(
      "roamcode.defaults",
      JSON.stringify({ effort: "medium", codex: { model: "vendor/gpt-next:preview" } }),
    );
    expect(loadDefaults().codex?.model).toBe("vendor/gpt-next:preview");
  });

  it("keeps valid normalized values when the canonical storage rewrite fails", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("storage is read-only", "QuotaExceededError");
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() =>
        JSON.stringify({
          provider: "codex",
          effort: "high",
          codex: { model: "vendor/gpt-next:preview", reasoningEffort: "xhigh" },
        }),
      ),
      setItem,
    });

    expect(loadDefaults()).toEqual({
      effort: "high",
      dangerouslySkip: false,
      codex: { model: "vendor/gpt-next:preview", reasoningEffort: "xhigh" },
    });
  });

  it("sanitizes save input and does not throw when storage writes fail", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("storage is read-only", "QuotaExceededError");
    });
    vi.stubGlobal("localStorage", { setItem });

    expect(() =>
      saveDefaults({
        effort: "high",
        dangerouslySkip: false,
        codex: { model: "vendor/gpt-next:preview" },
        provider: "codex",
        malformed: true,
      } as never),
    ).not.toThrow();
    expect(setItem).toHaveBeenCalledWith(
      "roamcode.defaults",
      JSON.stringify({
        effort: "high",
        dangerouslySkip: false,
        codex: { model: "vendor/gpt-next:preview" },
      }),
    );
  });
});
