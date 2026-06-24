import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe("relativeTime", () => {
  it("formats fresh and sub-minute deltas as 'now'", () => {
    expect(relativeTime(0, 0)).toBe("now");
    expect(relativeTime(0, 10 * S)).toBe("now");
    expect(relativeTime(0, 44 * S)).toBe("now");
  });

  it("formats minutes, hours, and days compactly", () => {
    expect(relativeTime(0, 2 * M)).toBe("2m");
    expect(relativeTime(0, 59 * M)).toBe("59m");
    expect(relativeTime(0, H)).toBe("1h");
    expect(relativeTime(0, 23 * H)).toBe("23h");
    expect(relativeTime(0, 3 * D)).toBe("3d");
  });

  it("rolls up to weeks, months, and years", () => {
    expect(relativeTime(0, 8 * D)).toBe("1w");
    expect(relativeTime(0, 40 * D)).toBe("1mo");
    expect(relativeTime(0, 400 * D)).toBe("1y");
  });

  it("clamps a future/skewed timestamp to 'now' rather than a negative label", () => {
    expect(relativeTime(5 * S, 0)).toBe("now");
  });
});
