import { describe, expect, it } from "vitest";
import { isLikelyImage, supportsImageEditing } from "./ImageEditorModal";

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
