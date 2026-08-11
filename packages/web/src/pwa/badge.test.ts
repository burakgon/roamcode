import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAppBadge, badgeCount } from "./badge";
import type { SessionMeta } from "../types/server";

function meta(id: string, awaiting?: boolean): SessionMeta {
  return { id, cwd: `/p/${id}`, dangerouslySkip: false, status: "running", createdAt: 1, awaiting };
}

describe("badgeCount", () => {
  it("is 0 for an empty list", () => {
    expect(badgeCount([])).toBe(0);
  });
  it("is 0 when no session is awaiting", () => {
    expect(badgeCount([meta("a"), meta("b", false)])).toBe(0);
  });
  it("counts a single awaiting session", () => {
    expect(badgeCount([meta("a", true), meta("b")])).toBe(1);
  });
  it("counts N awaiting sessions (only awaiting ones)", () => {
    expect(badgeCount([meta("a", true), meta("b", true), meta("c"), meta("d", true)])).toBe(3);
  });
  it("counts a provider-reported blocked agent before the compatibility flag catches up", () => {
    const blocked = meta("blocked", false);
    blocked.agent = { provider: "codex", source: "process", activity: "blocked" };
    expect(badgeCount([blocked, meta("idle")])).toBe(1);
  });
});

describe("applyAppBadge", () => {
  let setAppBadge: ReturnType<typeof vi.fn>;
  let clearAppBadge: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setAppBadge = vi.fn(async () => {});
    clearAppBadge = vi.fn(async () => {});
  });
  afterEach(() => {
    // Remove anything we stubbed onto navigator so tests don't leak.
    delete (navigator as unknown as { setAppBadge?: unknown }).setAppBadge;
    delete (navigator as unknown as { clearAppBadge?: unknown }).clearAppBadge;
  });

  it("sets the badge to a positive count", () => {
    (navigator as unknown as { setAppBadge: unknown }).setAppBadge = setAppBadge;
    (navigator as unknown as { clearAppBadge: unknown }).clearAppBadge = clearAppBadge;
    applyAppBadge(3);
    expect(setAppBadge).toHaveBeenCalledWith(3);
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it("clears the badge at 0 (via clearAppBadge when available)", () => {
    (navigator as unknown as { setAppBadge: unknown }).setAppBadge = setAppBadge;
    (navigator as unknown as { clearAppBadge: unknown }).clearAppBadge = clearAppBadge;
    applyAppBadge(0);
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("falls back to setAppBadge(0) at 0 when clearAppBadge is unavailable", () => {
    (navigator as unknown as { setAppBadge: unknown }).setAppBadge = setAppBadge;
    applyAppBadge(0);
    expect(setAppBadge).toHaveBeenCalledWith(0);
  });

  it("is a silent no-op when the App Badging API is unsupported", () => {
    // No setAppBadge on navigator → nothing thrown, nothing called.
    expect(() => applyAppBadge(5)).not.toThrow();
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("swallows a rejected setAppBadge promise (no unhandled rejection)", () => {
    (navigator as unknown as { setAppBadge: unknown }).setAppBadge = vi.fn(async () => {
      throw new Error("denied");
    });
    expect(() => applyAppBadge(2)).not.toThrow();
  });
});
