import { describe, expect, it, vi } from "vitest";
import { drawBoxDrawingGlyph } from "../src/box-drawing";

function context() {
  return {
    beginPath: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe("canvas box drawing", () => {
  it("draws adjacent horizontal glyphs to the exact shared cell boundary", () => {
    const canvas = context();
    const width = 7.8125;

    expect(drawBoxDrawingGlyph(canvas, "─", 0, 0, width, 17, "#fff")).toBe(true);
    expect(drawBoxDrawingGlyph(canvas, "─", width, 0, width, 17, "#fff")).toBe(true);

    const rectangles = vi.mocked(canvas.fillRect).mock.calls;
    const firstRightHalf = rectangles[1];
    const secondLeftHalf = rectangles[2];
    expect(firstRightHalf[0] + firstRightHalf[2]).toBe(width);
    expect(secondLeftHalf[0]).toBe(width);
  });

  it("connects a light TUI corner to both cell edges without using a font glyph", () => {
    const canvas = context();

    expect(drawBoxDrawingGlyph(canvas, "┌", 10, 20, 8, 18, "#f80")).toBe(true);

    expect(vi.mocked(canvas.fillRect).mock.calls).toEqual([
      [14, 28.5, 4, 1],
      [13.5, 29, 1, 9],
    ]);
  });

  it("keeps ordinary terminal text on the font-rendering path", () => {
    const canvas = context();
    expect(drawBoxDrawingGlyph(canvas, "A", 0, 0, 8, 17, "#fff")).toBe(false);
    expect(canvas.fillRect).not.toHaveBeenCalled();
  });
});
