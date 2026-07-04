import { describe, expect, it } from "vitest";
import { searchBuffer } from "./terminal-search";

describe("searchBuffer", () => {
  it("finds a case-insensitive substring and reports row/col/length", () => {
    const lines = ["hello world", "nothing here", "say HELLO again"];
    expect(searchBuffer(lines, "hello")).toEqual([
      { row: 0, col: 0, length: 5 },
      { row: 2, col: 4, length: 5 },
    ]);
    // The query's own case is irrelevant too.
    expect(searchBuffer(lines, "HeLLo")).toHaveLength(2);
  });

  it("finds MULTIPLE (non-overlapping) matches on one line, left to right", () => {
    expect(searchBuffer(["ab ab ab"], "ab")).toEqual([
      { row: 0, col: 0, length: 2 },
      { row: 0, col: 3, length: 2 },
      { row: 0, col: 6, length: 2 },
    ]);
    // Non-overlapping: "aaaa" contains "aa" at 0 and 2 (not 1) — the scan resumes AFTER each hit.
    expect(searchBuffer(["aaaa"], "aa")).toEqual([
      { row: 0, col: 0, length: 2 },
      { row: 0, col: 2, length: 2 },
    ]);
  });

  it("returns [] for an empty query (searching nothing must not 'match everywhere')", () => {
    expect(searchBuffer(["hello"], "")).toEqual([]);
  });

  it("returns [] when nothing matches, and handles empty buffers", () => {
    expect(searchBuffer(["hello world"], "zebra")).toEqual([]);
    expect(searchBuffer([], "hello")).toEqual([]);
    expect(searchBuffer(["", "", ""], "x")).toEqual([]);
  });

  it("length always mirrors the QUERY length (what xterm.select needs), rows are buffer-absolute", () => {
    const m = searchBuffer(["", "", "  Error: boom"], "error");
    expect(m).toEqual([{ row: 2, col: 2, length: 5 }]);
  });
});
