import { describe, expect, it } from "vitest";
import { compositionDelta, isCompositionCommitEcho } from "./terminal-composition";

describe("compositionDelta", () => {
  it("streams only the changed candidate suffix", () => {
    expect(compositionDelta("", "kod")).toBe("kod");
    expect(compositionDelta("kod", "kodl")).toBe("l");
    expect(compositionDelta("kodl", "kodla")).toBe("a");
    expect(compositionDelta("terminal", "term")).toBe("\x7f\x7f\x7f\x7f");
  });

  it("erases complete graphemes instead of UTF-16 code units", () => {
    expect(compositionDelta("a👩‍💻", "a🚀")).toBe("\x7f🚀");
    expect(compositionDelta("e\u0301", "é")).toBe("\x7fé");
    expect(compositionDelta("same", "same")).toBe("");
  });
});

describe("isCompositionCommitEcho", () => {
  it("suppresses only a same-turn Chromium insert echo", () => {
    expect(isCompositionCommitEcho("İstanbul", "insertText", "İstanbul")).toBe(true);
    expect(isCompositionCommitEcho("İstanbul", "insertReplacementText", "İstanbul")).toBe(true);
    expect(isCompositionCommitEcho("İstanbul", "insertText", "I")).toBe(false);
    expect(isCompositionCommitEcho(undefined, "insertText", "İstanbul")).toBe(false);
    expect(isCompositionCommitEcho("İstanbul", "deleteContentBackward", null)).toBe(false);
  });
});
