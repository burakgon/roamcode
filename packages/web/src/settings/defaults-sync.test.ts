import { describe, expect, it, vi } from "vitest";
import { hydrateSessionDefaults, sessionDefaultsStateFromEnvelope } from "./defaults-sync";

describe("server-owned remembered session choices", () => {
  it("hydrates the complete last-launch document from the server", async () => {
    const getSessionDefaults = vi.fn(async () => ({
      defaults: {
        provider: "codex" as const,
        effort: "high",
        model: "claude-next",
        dangerouslySkip: false,
        permissionMode: "plan",
        addDirs: ["/claude/extra"],
        codex: {
          model: "gpt-next",
          reasoningEffort: "future-depth",
          sandbox: "workspace-write" as const,
          approvalPolicy: "on-request" as const,
          addDirs: ["/codex/extra"],
        },
      },
      revision: 7,
      updatedAt: 123,
    }));

    await expect(hydrateSessionDefaults({ api: { getSessionDefaults } })).resolves.toEqual({
      status: "synced",
      defaults: {
        provider: "codex",
        effort: "high",
        model: "claude-next",
        dangerouslySkip: false,
        permissionMode: "plan",
        addDirs: ["/claude/extra"],
        codex: {
          model: "gpt-next",
          reasoningEffort: "future-depth",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          addDirs: ["/codex/extra"],
        },
      },
      revision: 7,
    });
  });

  it("uses built-in choices for an unset server without creating a settings document", async () => {
    const getSessionDefaults = vi.fn(async () => ({ defaults: null, revision: 0 }));

    await expect(hydrateSessionDefaults({ api: { getSessionDefaults } })).resolves.toEqual({
      status: "synced",
      defaults: { effort: "medium", dangerouslySkip: false },
      revision: 0,
    });
    expect(getSessionDefaults).toHaveBeenCalledOnce();
  });

  it("falls back in memory when the server cannot be reached", async () => {
    const getSessionDefaults = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(hydrateSessionDefaults({ api: { getSessionDefaults } })).resolves.toEqual({
      status: "unsynced",
      defaults: { effort: "medium", dangerouslySkip: false },
      revision: 0,
      error: "Couldn't load the last session choices from the server. Using built-in defaults.",
    });
  });

  it("adopts a create response immediately and preserves additive effort tokens", () => {
    expect(
      sessionDefaultsStateFromEnvelope({
        defaults: {
          provider: "claude",
          effort: "future-depth_2",
          dangerouslySkip: false,
          addDirs: ["/work/shared"],
        },
        revision: 8,
      }),
    ).toEqual({
      status: "synced",
      defaults: {
        provider: "claude",
        effort: "future-depth_2",
        dangerouslySkip: false,
        addDirs: ["/work/shared"],
      },
      revision: 8,
    });
  });

  it.each([
    undefined,
    { defaults: null, revision: 1 },
    { defaults: { effort: "high", dangerouslySkip: false }, revision: 0 },
    { defaults: { provider: "other", effort: "high", dangerouslySkip: false }, revision: 1 },
    { defaults: { effort: "bad effort", dangerouslySkip: false }, revision: 1 },
    { defaults: { effort: "high", dangerouslySkip: false, addDirs: ["relative"] }, revision: 1 },
    { defaults: { effort: "high", dangerouslySkip: false, unknown: true }, revision: 1 },
  ])("rejects malformed server envelopes %#", (value) => {
    expect(sessionDefaultsStateFromEnvelope(value)).toBeUndefined();
  });
});
