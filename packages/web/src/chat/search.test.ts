import { describe, expect, it } from "vitest";
import { countMatches, turnMatches, turnSearchText } from "./search";
import type { TurnItem } from "../store/frame-reducer";

describe("turnSearchText (extracts searchable text, incl. normally-collapsed plumbing)", () => {
  it("extracts a user message's text", () => {
    const t: TurnItem = { kind: "user", blocks: [{ type: "text", text: "deploy the server" }] };
    expect(turnSearchText(t)).toContain("deploy the server");
  });
  it("extracts assistant prose", () => {
    expect(turnSearchText({ kind: "assistant-text", text: "I refactored the parser" })).toContain("refactored");
  });
  it("extracts thinking text (collapsed by default)", () => {
    expect(turnSearchText({ kind: "thinking", text: "the bug is in the reducer" })).toContain("reducer");
  });
  it("extracts a tool-use's name + input summary", () => {
    const t: TurnItem = { kind: "tool-use", id: "t1", name: "Bash", input: { command: "pnpm test" } };
    const text = turnSearchText(t);
    expect(text).toContain("Bash");
    expect(text).toContain("pnpm test");
  });
  it("extracts a tool-result's output text (ANSI stripped)", () => {
    const t: TurnItem = { kind: "tool-result", toolUseId: "t1", content: "[32mALL TESTS PASSED[0m" };
    expect(turnSearchText(t)).toBe("ALL TESTS PASSED");
  });
});

describe("turnMatches (case-insensitive)", () => {
  it("matches assistant text", () => {
    expect(turnMatches({ kind: "assistant-text", text: "Hello World" }, "world")).toBe(true);
  });
  it("matches user text", () => {
    const t: TurnItem = { kind: "user", blocks: [{ type: "text", text: "fix the LOGIN flow" }] };
    expect(turnMatches(t, "login")).toBe(true);
  });
  it("matches text buried in a collapsed tool result", () => {
    const t: TurnItem = { kind: "tool-result", toolUseId: "t1", content: "error: connection refused" };
    expect(turnMatches(t, "refused")).toBe(true);
  });
  it("does not match an unrelated query", () => {
    expect(turnMatches({ kind: "assistant-text", text: "hello" }, "goodbye")).toBe(false);
  });
  it("an empty query matches nothing (search inactive)", () => {
    expect(turnMatches({ kind: "assistant-text", text: "hello" }, "")).toBe(false);
    expect(turnMatches({ kind: "assistant-text", text: "hello" }, "   ")).toBe(false);
  });
});

describe("countMatches", () => {
  it("counts occurrences across all turns (incl. tool output)", () => {
    const turns: TurnItem[] = [
      { kind: "user", blocks: [{ type: "text", text: "test test" }] },
      { kind: "assistant-text", text: "running a test" },
      { kind: "tool-result", toolUseId: "t1", content: "1 test failed, 1 test passed" },
    ];
    // "test" appears: 2 (user) + 1 (assistant) + 2 (tool result) = 5
    expect(countMatches(turns, "test")).toBe(5);
  });
  it("is 0 for an empty query and for a no-match query", () => {
    const turns: TurnItem[] = [{ kind: "assistant-text", text: "hello" }];
    expect(countMatches(turns, "")).toBe(0);
    expect(countMatches(turns, "zzz")).toBe(0);
  });
});
