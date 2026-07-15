import { describe, expect, test } from "vitest";
import type { StorageLike } from "./direct-hosts";
import { loadHostActiveSession, loadTerminalDraft, saveHostActiveSession, saveTerminalDraft } from "./host-ui-state";

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("host-scoped UI state", () => {
  test("keeps active sessions and unsent terminal drafts isolated by host", () => {
    const storage = memoryStorage();
    saveHostActiveSession("host_a", "session_a", storage);
    saveHostActiveSession("host_b", "session_b", storage);
    saveTerminalDraft("host_a", "shared_session", "draft A", storage);
    saveTerminalDraft("host_b", "shared_session", "draft B", storage);

    expect(loadHostActiveSession("host_a", storage)).toBe("session_a");
    expect(loadHostActiveSession("host_b", storage)).toBe("session_b");
    expect(loadTerminalDraft("host_a", "shared_session", storage)).toBe("draft A");
    expect(loadTerminalDraft("host_b", "shared_session", storage)).toBe("draft B");
  });

  test("removes empty values and rejects an oversized draft", () => {
    const storage = memoryStorage();
    saveHostActiveSession("host_a", "session_a", storage);
    saveHostActiveSession("host_a", undefined, storage);
    expect(loadHostActiveSession("host_a", storage)).toBeUndefined();

    saveTerminalDraft("host_a", "session_a", "draft", storage);
    saveTerminalDraft("host_a", "session_a", "", storage);
    expect(loadTerminalDraft("host_a", "session_a", storage)).toBe("");
    expect(() => saveTerminalDraft("host_a", "session_a", "x".repeat(65 * 1024), storage)).toThrow("64 KiB");
  });
});
