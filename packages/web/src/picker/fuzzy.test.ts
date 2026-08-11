import { describe, expect, it } from "vitest";
import { fuzzyFilter } from "./fuzzy";
import type { DirEntry } from "../types/server";

function dir(name: string): DirEntry {
  return { name, path: `/x/${name}`, isDirectory: true };
}
const entries = [dir("packages"), dir("protocol"), dir("docs"), dir("scripts")];

describe("fuzzyFilter", () => {
  it("returns all entries for an empty query", () => {
    expect(fuzzyFilter(entries, "")).toHaveLength(4);
  });
  it("returns all entries for a whitespace-only query", () => {
    expect(fuzzyFilter(entries, "   ")).toHaveLength(4);
  });
  it("matches a case-insensitive subsequence", () => {
    expect(fuzzyFilter(entries, "doc").map((e) => e.name)).toEqual(["docs"]);
    expect(fuzzyFilter(entries, "PCKS").map((e) => e.name)).toEqual(["packages"]);
  });
  it("matches subsequence across the name (p..o..o)", () => {
    expect(fuzzyFilter(entries, "poo").map((e) => e.name)).toEqual(["protocol"]);
  });
  it("preserves input order among matches", () => {
    expect(fuzzyFilter(entries, "s").map((e) => e.name)).toEqual(["packages", "docs", "scripts"]);
  });
  it("returns nothing when no entry matches", () => {
    expect(fuzzyFilter(entries, "zzz")).toEqual([]);
  });
});
