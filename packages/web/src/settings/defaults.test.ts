import { afterEach, describe, expect, it } from "vitest";
import { loadDefaults, saveDefaults } from "./defaults";

afterEach(() => localStorage.clear());

describe("session defaults", () => {
  it("returns safe fallbacks when nothing is stored", () => {
    expect(loadDefaults()).toEqual({ effort: "medium", dangerouslySkip: false });
  });
  it("round-trips saved defaults", () => {
    saveDefaults({ effort: "high", model: "opus", dangerouslySkip: true });
    expect(loadDefaults()).toEqual({ effort: "high", model: "opus", dangerouslySkip: true });
  });
  it("ignores corrupt storage and falls back", () => {
    localStorage.setItem("roamcode.defaults", "not json");
    expect(loadDefaults().effort).toBe("medium");
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
});
