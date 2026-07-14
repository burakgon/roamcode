import { describe, expect, it } from "vitest";
import { isLikelyImage, supportsImageEditing } from "./ImageEditorModal";
import { clampCrop, createInitialEditorState, editorStateIsDirty, rotateEditorState90 } from "./image-editor-model";

describe("browser image editing support", () => {
  it("supports the lossless browser-safe PNG, JPEG, and WebP formats by MIME or extension", () => {
    expect(supportsImageEditing({ name: "shot.png", type: "" })).toBe(true);
    expect(supportsImageEditing({ name: "camera", type: "image/jpeg" })).toBe(true);
    expect(supportsImageEditing({ name: "capture.webp", type: "image/webp" })).toBe(true);
  });

  it("recognizes other images but does not silently convert unsupported animated or modern formats", () => {
    expect(isLikelyImage({ name: "animation.gif", type: "" })).toBe(true);
    expect(isLikelyImage({ name: "photo.heic", type: "application/octet-stream" })).toBe(true);
    expect(supportsImageEditing({ name: "animation.gif", type: "image/gif" })).toBe(false);
    expect(supportsImageEditing({ name: "photo.heic", type: "image/heic" })).toBe(false);
  });
});

describe("RoamCode image editor geometry", () => {
  it("keeps crops and annotations attached to the same pixels after clockwise rotation", () => {
    const state = createInitialEditorState(400, 300);
    state.crop = { x: 40, y: 30, width: 200, height: 120 };
    state.annotations = [
      { id: "line", type: "arrow", points: [10, 20, 110, 120], color: "#fff", strokeWidth: 4 },
      { id: "redact", type: "redact", x: 50, y: 70, width: 80, height: 30 },
    ];

    const rotated = rotateEditorState90(state, 300);
    expect(rotated.rotation).toBe(90);
    expect(rotated.crop).toEqual({ x: 150, y: 40, width: 120, height: 200 });
    expect(rotated.annotations[0]).toMatchObject({ points: [280, 10, 180, 110] });
    expect(rotated.annotations[1]).toMatchObject({ x: 200, y: 50, width: 30, height: 80 });
  });

  it("detects untouched originals and clamps crop handles within the image", () => {
    const initial = createInitialEditorState(400, 300);
    expect(editorStateIsDirty(initial, 400, 300)).toBe(false);
    expect(clampCrop({ x: -20, y: 290, width: 500, height: 2 }, 400, 300, 24)).toEqual({
      x: 0,
      y: 276,
      width: 400,
      height: 24,
    });
  });
});
