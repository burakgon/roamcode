import { describe, expect, it } from "vitest";
import { basename, displaySessionName } from "./names";

describe("displaySessionName", () => {
  const s = { id: "s1", cwd: "/home/u/remote-coder" };

  it("prefers the SERVER name over the local map and the basename", () => {
    expect(displaySessionName({ ...s, name: "Prod fixes" }, { s1: "local label" })).toBe("Prod fixes");
  });

  it("falls back to the local (legacy/optimistic) label when the server has no name", () => {
    expect(displaySessionName(s, { s1: "local label" })).toBe("local label");
    // An undefined vs missing server name behaves the same.
    expect(displaySessionName({ ...s, name: undefined }, { s1: "local label" })).toBe("local label");
  });

  it("falls back to the cwd basename when neither layer names it", () => {
    expect(displaySessionName(s, {})).toBe("remote-coder");
  });

  it("treats whitespace-only names as unset at EVERY layer (a cleared name reverts cleanly)", () => {
    expect(displaySessionName({ ...s, name: "   " }, { s1: "  " })).toBe("remote-coder");
    expect(displaySessionName({ ...s, name: "  " }, { s1: "local label" })).toBe("local label");
  });
});

describe("basename", () => {
  it("takes the trailing segment, ignoring trailing slashes", () => {
    expect(basename("/a/b/c")).toBe("c");
    expect(basename("/a/b/c///")).toBe("c");
    expect(basename("/")).toBe("/");
  });
});
