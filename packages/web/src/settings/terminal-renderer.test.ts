import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTerminalRenderer, saveTerminalRenderer, TERMINAL_RENDERER_STORAGE_KEY } from "./terminal-renderer";

describe("terminal renderer device preference", () => {
  beforeEach(() => localStorage.clear());

  it("keeps xterm as the safe default and rejects unknown persisted values", () => {
    expect(loadTerminalRenderer()).toBe("xterm");
    localStorage.setItem(TERMINAL_RENDERER_STORAGE_KEY, "future-renderer");
    expect(loadTerminalRenderer()).toBe("xterm");
  });

  it("persists Ghostty only on this browser", () => {
    saveTerminalRenderer("ghostty");
    expect(localStorage.getItem(TERMINAL_RENDERER_STORAGE_KEY)).toBe("ghostty");
    expect(loadTerminalRenderer()).toBe("ghostty");
  });

  it("falls back to xterm when browser storage fails", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadTerminalRenderer()).toBe("xterm");
    getItem.mockRestore();
  });
});
