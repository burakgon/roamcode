import { describe, expect, it } from "vitest";
import { filterMentionEntries, matchMention, mentionInsertion, resolveMentionDir, splitToken } from "./mention";
import type { DirEntry, DirListing } from "../types/server";

const dir = (name: string): DirEntry => ({ name, path: `/abs/${name}`, isDirectory: true, isGitRepo: false });
const file = (name: string): DirEntry => ({ name, path: `/abs/${name}`, isDirectory: false, isGitRepo: false });
const listing = (entries: DirEntry[]): DirListing => ({ path: "/abs", entries });

describe("matchMention (detecting an @token at the caret)", () => {
  it("detects a bare @ at the start of the text", () => {
    const m = matchMention("@", 1);
    expect(m).toEqual({ start: 0, end: 1, dir: "", prefix: "" });
  });
  it("detects an @token mid-text (after whitespace) and splits dir/prefix", () => {
    const text = "look at @src/Comp";
    const m = matchMention(text, text.length);
    expect(m).toMatchObject({ dir: "src", prefix: "Comp" });
    // The replacement span covers exactly the @token.
    expect(text.slice(m!.start, m!.end)).toBe("@src/Comp");
  });
  it("lists the directory itself once a trailing slash is typed (@src/ → dir src, empty prefix)", () => {
    const m = matchMention("@src/", 5);
    expect(m).toMatchObject({ dir: "src", prefix: "" });
  });
  it("does NOT trigger on a mid-word @ (an email address is not a mention)", () => {
    const text = "mail me at burak@host.com";
    expect(matchMention(text, text.length)).toBeUndefined();
  });
  it("does NOT trigger once whitespace follows the @ (the reference ended)", () => {
    const text = "@src/Composer.tsx now";
    expect(matchMention(text, text.length)).toBeUndefined();
  });
  it("handles an absolute path token (dir keeps its leading slash)", () => {
    const m = matchMention("@/Users/me/co", 13);
    expect(m).toMatchObject({ dir: "/Users/me", prefix: "co" });
  });
  it("keeps a bare leading-slash token rooted at /", () => {
    const m = matchMention("@/co", 4);
    expect(m).toMatchObject({ dir: "/", prefix: "co" });
  });
});

describe("splitToken", () => {
  it("splits dir/prefix on the last slash", () => {
    expect(splitToken("a/b/c")).toEqual({ dir: "a/b", prefix: "c" });
  });
  it("returns cwd dir for a slashless token", () => {
    expect(splitToken("comp")).toEqual({ dir: "", prefix: "comp" });
  });
});

describe("resolveMentionDir (anchoring at the session cwd)", () => {
  it("joins a relative dir onto the cwd", () => {
    expect(resolveMentionDir("/home/proj", "src")).toBe("/home/proj/src");
  });
  it("lists the cwd itself for an empty dir", () => {
    expect(resolveMentionDir("/home/proj", "")).toBe("/home/proj");
  });
  it("uses an absolute dir as-is", () => {
    expect(resolveMentionDir("/home/proj", "/etc")).toBe("/etc");
  });
  it("tolerates a trailing slash on the cwd", () => {
    expect(resolveMentionDir("/home/proj/", "src")).toBe("/home/proj/src");
  });
});

describe("filterMentionEntries (prefix filter, both files and dirs)", () => {
  it("filters by basename prefix (fuzzy)", () => {
    const out = filterMentionEntries(listing([dir("src"), file("Composer.tsx"), file("README.md")]), "co");
    expect(out.map((e) => e.name)).toEqual(["Composer.tsx"]);
  });
  it("returns all entries (files and dirs) for an empty prefix", () => {
    const out = filterMentionEntries(listing([dir("src"), file("a.ts")]), "");
    expect(out.map((e) => e.name)).toEqual(["src", "a.ts"]);
  });
});

describe("mentionInsertion (the text a chosen entry inserts)", () => {
  it("a directory inserts with a trailing slash (keep drilling)", () => {
    const ctx = matchMention("@s", 2)!;
    expect(mentionInsertion(ctx, dir("src"))).toBe("@src/");
  });
  it("a file inserts with a trailing space (reference complete)", () => {
    const ctx = matchMention("@src/Comp", 9)!;
    expect(mentionInsertion(ctx, file("Composer.tsx"))).toBe("@src/Composer.tsx ");
  });
  it("keeps an absolute path absolute", () => {
    const ctx = matchMention("@/etc/ho", 8)!;
    expect(mentionInsertion(ctx, file("hosts"))).toBe("@/etc/hosts ");
  });
});
