import { expect, test } from "vitest";
import { isIosLikePlatform } from "./platform";

test("detects iPhone and desktop-spoofing iPadOS without classifying a real Mac as iOS", () => {
  expect(isIosLikePlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(true);
  expect(isIosLikePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X)", 5)).toBe(true);
  expect(isIosLikePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X)", 0)).toBe(false);
});
