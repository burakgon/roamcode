import { describe, expect, test } from "vitest";
import { isWorkspaceDrag, zoneForPoint, PANE_MIME, SESSION_MIME } from "./dnd";

const rect = { left: 0, top: 0, width: 100, height: 100 };

describe("zoneForPoint", () => {
  test("the middle 40% box is center", () => {
    expect(zoneForPoint(rect, 50, 50)).toBe("center");
    expect(zoneForPoint(rect, 31, 69)).toBe("center");
  });

  test("outside the box resolves to the NEAREST edge", () => {
    expect(zoneForPoint(rect, 5, 50)).toBe("left");
    expect(zoneForPoint(rect, 95, 50)).toBe("right");
    expect(zoneForPoint(rect, 50, 5)).toBe("top");
    expect(zoneForPoint(rect, 50, 95)).toBe("bottom");
    // A corner picks whichever edge is closer: (10, 25) → left (0.10 < 0.25).
    expect(zoneForPoint(rect, 10, 25)).toBe("left");
    expect(zoneForPoint(rect, 25, 10)).toBe("top");
  });

  test("an offset rect is handled in the rect's own space", () => {
    expect(zoneForPoint({ left: 200, top: 100, width: 100, height: 100 }, 250, 150)).toBe("center");
    expect(zoneForPoint({ left: 200, top: 100, width: 100, height: 100 }, 205, 150)).toBe("left");
  });

  test("a zero-size rect degrades to center (never NaN/throw)", () => {
    expect(zoneForPoint({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toBe("center");
  });
});

describe("isWorkspaceDrag", () => {
  test("recognises only OUR payloads (stray text/file drags are ignored)", () => {
    expect(isWorkspaceDrag([SESSION_MIME])).toBe(true);
    expect(isWorkspaceDrag([PANE_MIME])).toBe(true);
    expect(isWorkspaceDrag(["text/plain"])).toBe(false);
    expect(isWorkspaceDrag(["Files"])).toBe(false);
    expect(isWorkspaceDrag([])).toBe(false);
  });
});
