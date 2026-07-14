export type CropRect = { x: number; y: number; width: number; height: number };

export type ImageAnnotation =
  | { id: string; type: "draw" | "arrow"; points: number[]; color: string; strokeWidth: number }
  | { id: string; type: "text"; x: number; y: number; text: string; color: string; fontSize: number; rotation: number }
  | { id: string; type: "redact"; x: number; y: number; width: number; height: number };

export type EditorRotation = 0 | 90 | 180 | 270;

export type ImageEditorState = {
  rotation: EditorRotation;
  crop: CropRect;
  annotations: ImageAnnotation[];
};

export function supportsImageEditing(file: Pick<File, "name" | "type">): boolean {
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase() : "";
  return ["png", "jpg", "jpeg", "webp"].includes(ext) || ["image/png", "image/jpeg", "image/webp"].includes(file.type);
}

export function isLikelyImage(file: Pick<File, "name" | "type">): boolean {
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase() : "";
  return (
    file.type.startsWith("image/") ||
    ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "avif", "heic", "heif"].includes(ext)
  );
}

export function createInitialEditorState(width: number, height: number): ImageEditorState {
  return {
    rotation: 0,
    crop: { x: 0, y: 0, width, height },
    annotations: [],
  };
}

function rotatePoint90(x: number, y: number, oldHeight: number): [number, number] {
  return [oldHeight - y, x];
}

function rotateRect90(rect: CropRect, oldHeight: number): CropRect {
  return {
    x: oldHeight - rect.y - rect.height,
    y: rect.x,
    width: rect.height,
    height: rect.width,
  };
}

/** Rotate the complete logical document clockwise. Annotations stay attached to the same image pixels. */
export function rotateEditorState90(state: ImageEditorState, oldHeight: number): ImageEditorState {
  return {
    rotation: ((state.rotation + 90) % 360) as EditorRotation,
    crop: rotateRect90(state.crop, oldHeight),
    annotations: state.annotations.map((annotation) => {
      if ("points" in annotation) {
        const points: number[] = [];
        for (let index = 0; index < annotation.points.length; index += 2) {
          points.push(...rotatePoint90(annotation.points[index]!, annotation.points[index + 1]!, oldHeight));
        }
        return { ...annotation, points };
      }
      if (annotation.type === "text") {
        const [x, y] = rotatePoint90(annotation.x, annotation.y, oldHeight);
        return { ...annotation, x, y, rotation: (annotation.rotation + 90) % 360 };
      }
      const rotated = rotateRect90(annotation, oldHeight);
      return { ...annotation, ...rotated };
    }),
  };
}

export function editorStateIsDirty(state: ImageEditorState, naturalWidth: number, naturalHeight: number): boolean {
  return (
    state.rotation !== 0 ||
    state.annotations.length > 0 ||
    Math.abs(state.crop.x) > 0.5 ||
    Math.abs(state.crop.y) > 0.5 ||
    Math.abs(state.crop.width - naturalWidth) > 0.5 ||
    Math.abs(state.crop.height - naturalHeight) > 0.5
  );
}

export function clampCrop(rect: CropRect, width: number, height: number, minSize = 24): CropRect {
  const nextWidth = Math.min(width, Math.max(minSize, rect.width));
  const nextHeight = Math.min(height, Math.max(minSize, rect.height));
  return {
    x: Math.min(width - nextWidth, Math.max(0, rect.x)),
    y: Math.min(height - nextHeight, Math.max(0, rect.y)),
    width: nextWidth,
    height: nextHeight,
  };
}
