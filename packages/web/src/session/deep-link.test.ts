import { describe, expect, it } from "vitest";
import { sessionIdFromLocation } from "./deep-link";

describe("sessionIdFromLocation", () => {
  it("extracts the session id from ?session=", () => {
    expect(sessionIdFromLocation("?session=abc-123")).toBe("abc-123");
    expect(sessionIdFromLocation("?foo=1&session=xyz")).toBe("xyz");
  });
  it("returns undefined when absent or empty", () => {
    expect(sessionIdFromLocation("")).toBeUndefined();
    expect(sessionIdFromLocation("?foo=1")).toBeUndefined();
    expect(sessionIdFromLocation("?session=")).toBeUndefined();
  });
});
