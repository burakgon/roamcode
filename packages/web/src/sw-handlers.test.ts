import { describe, expect, it } from "vitest";
import { parsePushPayload, notificationOptions, clickTargetUrl } from "./sw-handlers";

describe("parsePushPayload", () => {
  it("parses a well-formed push payload", () => {
    const p = parsePushPayload(
      JSON.stringify({ title: "Task done", body: "ok", url: "https://h/?session=S1", tag: "S1" }),
    );
    expect(p).toEqual({ title: "Task done", body: "ok", url: "https://h/?session=S1", tag: "S1" });
  });
  it("falls back for empty/malformed input (never throws)", () => {
    expect(parsePushPayload(undefined).title).toBe("Remote Coder");
    expect(parsePushPayload("not json").title).toBe("Remote Coder");
    const partial = parsePushPayload(JSON.stringify({ title: "X" }));
    expect(partial.title).toBe("X");
    expect(typeof partial.url).toBe("string"); // url defaults to "/"
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
