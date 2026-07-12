import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionOrder, saveSessionOrder } from "./order-preference";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("session order preference", () => {
  it("defaults missing and invalid values to created", () => {
    expect(loadSessionOrder()).toBe("created");
    localStorage.setItem("roamcode.session-order", "manual");
    expect(loadSessionOrder()).toBe("created");
  });

  it("round-trips both supported values", () => {
    saveSessionOrder("activity");
    expect(loadSessionOrder()).toBe("activity");
    saveSessionOrder("created");
    expect(loadSessionOrder()).toBe("created");
  });

  it("falls back safely when storage reads or writes throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadSessionOrder()).toBe("created");
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => saveSessionOrder("activity")).not.toThrow();
  });
});
