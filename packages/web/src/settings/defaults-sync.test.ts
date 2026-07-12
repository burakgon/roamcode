import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { loadDefaults, saveDefaults } from "./defaults";
import { hydrateSessionDefaults, persistSessionDefaults } from "./defaults-sync";

describe("session defaults synchronization", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("adopts an existing server value and refreshes the local cache", async () => {
    saveDefaults({ effort: "low", dangerouslySkip: false });
    const api = {
      getSessionDefaults: vi.fn().mockResolvedValue({
        defaults: {
          effort: "high",
          model: "claude-opus",
          dangerouslySkip: false,
          permissionMode: "plan",
          provider: "codex",
        },
        revision: 4,
        updatedAt: 123,
      }),
      putSessionDefaults: vi.fn(),
    };

    await expect(hydrateSessionDefaults({ api, local: { effort: "low", dangerouslySkip: false } })).resolves.toEqual({
      status: "synced",
      defaults: {
        effort: "high",
        model: "claude-opus",
        dangerouslySkip: false,
        permissionMode: "plan",
      },
      revision: 4,
    });
    expect(api.putSessionDefaults).not.toHaveBeenCalled();
    expect(loadDefaults()).toEqual({
      effort: "high",
      model: "claude-opus",
      dangerouslySkip: false,
      permissionMode: "plan",
    });
  });

  it("uploads the normalized local value at revision zero when the server is unset", async () => {
    const api = {
      getSessionDefaults: vi.fn().mockResolvedValue({ defaults: null, revision: 0 }),
      putSessionDefaults: vi.fn().mockResolvedValue({
        defaults: { effort: "low", dangerouslySkip: true, permissionMode: "plan" },
        revision: 1,
        updatedAt: 456,
      }),
    };

    const result = await hydrateSessionDefaults({
      api,
      local: { effort: "invalid", dangerouslySkip: true, permissionMode: "plan" },
    });

    expect(api.putSessionDefaults).toHaveBeenCalledWith({ effort: "medium", dangerouslySkip: true }, 0);
    expect(result).toEqual({
      status: "synced",
      defaults: { effort: "low", dangerouslySkip: true },
      revision: 1,
    });
    expect(loadDefaults()).toEqual({ effort: "low", dangerouslySkip: true });
  });

  it("adopts and caches the current server document when the migration PUT conflicts", async () => {
    const current = {
      defaults: { effort: "xhigh", dangerouslySkip: false },
      revision: 7,
      updatedAt: 789,
    };
    const api = {
      getSessionDefaults: vi.fn().mockResolvedValue({ defaults: null, revision: 0 }),
      putSessionDefaults: vi.fn().mockRejectedValue(
        new ApiError(409, "Session defaults revision conflict", "SETTINGS_CONFLICT", {
          code: "SETTINGS_CONFLICT",
          error: "Session defaults revision conflict",
          current,
        }),
      ),
    };

    await expect(hydrateSessionDefaults({ api, local: { effort: "low", dangerouslySkip: false } })).resolves.toEqual({
      status: "synced",
      defaults: current.defaults,
      revision: current.revision,
    });
    expect(loadDefaults()).toEqual(current.defaults);
  });

  it("keeps the normalized local value unsynced when GET fails", async () => {
    saveDefaults({ effort: "low", dangerouslySkip: false });
    const api = {
      getSessionDefaults: vi.fn().mockRejectedValue(new Error("offline")),
      putSessionDefaults: vi.fn(),
    };

    const result = await hydrateSessionDefaults({
      api,
      local: { effort: "invalid", dangerouslySkip: false },
    });

    expect(result).toEqual({
      status: "unsynced",
      defaults: { effort: "medium", dangerouslySkip: false },
      revision: 0,
      error: expect.stringMatching(/couldn.t load defaults from the server/i),
    });
    expect(api.putSessionDefaults).not.toHaveBeenCalled();
    expect(loadDefaults()).toEqual({ effort: "low", dangerouslySkip: false });
  });

  it("uses and caches the normalized server response after a successful save", async () => {
    const api = {
      putSessionDefaults: vi.fn().mockResolvedValue({
        defaults: {
          effort: "high",
          dangerouslySkip: true,
          permissionMode: "plan",
          provider: "claude",
        },
        revision: 3,
        updatedAt: 999,
      }),
    };

    const result = await persistSessionDefaults({
      api,
      defaults: { effort: "high", dangerouslySkip: true, permissionMode: "plan" },
      revision: 2,
    });

    expect(api.putSessionDefaults).toHaveBeenCalledWith({ effort: "high", dangerouslySkip: true }, 2);
    expect(result).toEqual({
      status: "synced",
      defaults: { effort: "high", dangerouslySkip: true },
      revision: 3,
    });
    expect(loadDefaults()).toEqual({ effort: "high", dangerouslySkip: true });
  });

  it("adopts the current server document and reports a visible save conflict", async () => {
    const current = {
      defaults: { effort: "low", dangerouslySkip: false, permissionMode: "acceptEdits" },
      revision: 9,
      updatedAt: 1_111,
    };
    const api = {
      putSessionDefaults: vi.fn().mockRejectedValue(
        new ApiError(409, "Session defaults revision conflict", "SETTINGS_CONFLICT", {
          code: "SETTINGS_CONFLICT",
          error: "Session defaults revision conflict",
          current,
        }),
      ),
    };

    const result = await persistSessionDefaults({
      api,
      defaults: { effort: "high", dangerouslySkip: false },
      revision: 8,
    });

    expect(result).toEqual({
      status: "unsynced",
      defaults: current.defaults,
      revision: current.revision,
      error: expect.stringMatching(/changed on another device/i),
    });
    expect(loadDefaults()).toEqual(current.defaults);
  });

  it("keeps the submitted authoritative value uncached and reports a generic save failure", async () => {
    const previous = { effort: "medium", dangerouslySkip: false, permissionMode: "plan" } as const;
    saveDefaults(previous);
    const api = {
      putSessionDefaults: vi.fn().mockRejectedValue(new Error("offline")),
    };

    const result = await persistSessionDefaults({ api, defaults: previous, revision: 5 });

    expect(result).toEqual({
      status: "unsynced",
      defaults: previous,
      revision: 5,
      error: expect.stringMatching(/couldn.t save defaults to the server/i),
    });
    expect(loadDefaults()).toEqual(previous);
  });

  it("does not adopt or cache a malformed conflict body", async () => {
    const previous = { effort: "medium", dangerouslySkip: false } as const;
    saveDefaults(previous);
    const api = {
      putSessionDefaults: vi.fn().mockRejectedValue(
        new ApiError(409, "conflict", "SETTINGS_CONFLICT", {
          code: "SETTINGS_CONFLICT",
          current: { defaults: null, revision: "9" },
        }),
      ),
    };

    const result = await persistSessionDefaults({ api, defaults: previous, revision: 5 });

    expect(result).toEqual({
      status: "unsynced",
      defaults: previous,
      revision: 5,
      error: expect.stringMatching(/couldn.t save defaults to the server/i),
    });
    expect(loadDefaults()).toEqual(previous);
  });
});
