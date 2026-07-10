import { describe, expect, it, vi } from "vitest";
import { parsePushPayload, notificationOptions, clickTargetUrl, applyBadgeFromPush } from "./sw-handlers";

describe("parsePushPayload", () => {
  it("parses a well-formed push payload", () => {
    const p = parsePushPayload(
      JSON.stringify({ title: "Task done", body: "ok", url: "https://h/?session=S1", tag: "S1" }),
    );
    expect(p).toEqual({ title: "Task done", body: "ok", url: "https://h/?session=S1", tag: "S1" });
  });
  it("falls back for empty/malformed input (never throws)", () => {
    expect(parsePushPayload(undefined).title).toBe("RoamCode");
    expect(parsePushPayload("not json").title).toBe("RoamCode");
    const partial = parsePushPayload(JSON.stringify({ title: "X" }));
    expect(partial.title).toBe("X");
    expect(typeof partial.url).toBe("string"); // url defaults to "/"
  });
  it("carries a valid badgeCount and drops a malformed one", () => {
    expect(parsePushPayload(JSON.stringify({ title: "T", badgeCount: 3 })).badgeCount).toBe(3);
    expect(parsePushPayload(JSON.stringify({ title: "T", badgeCount: 0 })).badgeCount).toBe(0);
    // Absent / negative / non-integer / non-number → undefined (the SW then leaves the badge alone).
    expect(parsePushPayload(JSON.stringify({ title: "T" })).badgeCount).toBeUndefined();
    expect(parsePushPayload(JSON.stringify({ title: "T", badgeCount: -1 })).badgeCount).toBeUndefined();
    expect(parsePushPayload(JSON.stringify({ title: "T", badgeCount: 1.5 })).badgeCount).toBeUndefined();
    expect(parsePushPayload(JSON.stringify({ title: "T", badgeCount: "2" })).badgeCount).toBeUndefined();
  });
});

describe("applyBadgeFromPush", () => {
  it("sets the badge from a positive payload count", () => {
    const setAppBadge = vi.fn(async () => {});
    applyBadgeFromPush({ title: "T", body: "B", url: "/", tag: "S1", badgeCount: 4 }, { setAppBadge });
    expect(setAppBadge).toHaveBeenCalledWith(4);
  });
  it("clears the badge at 0 (clearAppBadge when present)", () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    applyBadgeFromPush({ title: "T", body: "B", url: "/", tag: "S1", badgeCount: 0 }, { setAppBadge, clearAppBadge });
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });
  it("leaves the badge alone when the payload has no badgeCount", () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    applyBadgeFromPush({ title: "T", body: "B", url: "/", tag: "S1" }, { setAppBadge, clearAppBadge });
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });
  it("is a silent no-op when the App Badging API is unsupported", () => {
    expect(() =>
      applyBadgeFromPush({ title: "T", body: "B", url: "/", tag: "S1", badgeCount: 2 }, undefined),
    ).not.toThrow();
    expect(() => applyBadgeFromPush({ title: "T", body: "B", url: "/", tag: "S1", badgeCount: 2 }, {})).not.toThrow();
  });
});

describe("notificationOptions", () => {
  it("carries body, tag, and the url in data", () => {
    const opts = notificationOptions({ title: "T", body: "B", url: "https://h/?session=S1", tag: "S1" });
    expect(opts.body).toBe("B");
    expect(opts.tag).toBe("S1");
    expect((opts.data as { url: string }).url).toBe("https://h/?session=S1");
  });
});

describe("clickTargetUrl", () => {
  it("returns the url from notification.data, defaulting to /", () => {
    expect(clickTargetUrl({ data: { url: "https://h/?session=S1" } })).toBe("https://h/?session=S1");
    expect(clickTargetUrl({ data: {} })).toBe("/");
    expect(clickTargetUrl({})).toBe("/");
  });
});
