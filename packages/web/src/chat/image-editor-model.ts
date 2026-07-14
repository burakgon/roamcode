export type CropRect = { x: number; y: number; width: number; height: number };
export type CropAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

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

export function cropAnchorPoint(crop: CropRect, anchor: CropAnchor): { x: number; y: number } {
  const centerX = crop.x + crop.width / 2;
  const centerY = crop.y + crop.height / 2;
  return {
    x: anchor.endsWith("left") ? crop.x : anchor.endsWith("right") ? crop.x + crop.width : centerX,
    y: anchor.startsWith("top") ? crop.y : anchor.startsWith("bottom") ? crop.y + crop.height : centerY,
  };
}

/** Document-space metrics that render as fixed CSS-pixel crop affordances at any zoom. */
export function cropHandleMetrics(
  anchor: CropAnchor,
  viewScale: number,
): { hitSize: number; visualWidth: number; visualHeight: number } {
  const scale = Math.max(0.0001, viewScale);
  const corner =
    (anchor.startsWith("top") || anchor.startsWith("bottom")) && (anchor.endsWith("left") || anchor.endsWith("right"));
  const horizontal = anchor === "top-center" || anchor === "bottom-center";
  return {
    hitSize: 44 / scale,
    visualWidth: (corner ? 12 : horizontal ? 18 : 4) / scale,
    visualHeight: (corner ? 12 : horizontal ? 4 : 18) / scale,
  };
}

/** Resize one crop edge/corner from its document-space pointer position. */
export function resizeCropFromAnchor(
  crop: CropRect,
  anchor: CropAnchor,
  point: { x: number; y: number },
  documentWidth: number,
  documentHeight: number,
  minSize = 24,
): CropRect {
  const left = crop.x;
  const top = crop.y;
  const right = crop.x + crop.width;
  const bottom = crop.y + crop.height;
  const movesLeft = anchor.endsWith("left");
  const movesRight = anchor.endsWith("right");
  const movesTop = anchor.startsWith("top");
  const movesBottom = anchor.startsWith("bottom");

  const nextLeft = movesLeft ? Math.min(right - minSize, Math.max(0, point.x)) : left;
  const nextRight = movesRight ? Math.max(left + minSize, Math.min(documentWidth, point.x)) : right;
  const nextTop = movesTop ? Math.min(bottom - minSize, Math.max(0, point.y)) : top;
  const nextBottom = movesBottom ? Math.max(top + minSize, Math.min(documentHeight, point.y)) : bottom;
  return {
    x: nextLeft,
    y: nextTop,
    width: nextRight - nextLeft,
    height: nextBottom - nextTop,
  };
}

/** Move an annotation while keeping its complete geometry inside the logical image. */
export function translateAnnotation(
  annotation: ImageAnnotation,
  dx: number,
  dy: number,
  documentWidth: number,
  documentHeight: number,
): ImageAnnotation {
  if ("points" in annotation) {
    const xs = annotation.points.filter((_, index) => index % 2 === 0);
    const ys = annotation.points.filter((_, index) => index % 2 === 1);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const nextDx = Math.min(documentWidth - maxX, Math.max(-minX, dx));
    const nextDy = Math.min(documentHeight - maxY, Math.max(-minY, dy));
    return {
      ...annotation,
      points: annotation.points.map((value, index) => value + (index % 2 === 0 ? nextDx : nextDy)),
    };
  }
  if (annotation.type === "text") {
    return {
      ...annotation,
      x: Math.min(documentWidth, Math.max(0, annotation.x + dx)),
      y: Math.min(documentHeight, Math.max(0, annotation.y + dy)),
    };
  }
  return {
    ...annotation,
    x: Math.min(documentWidth - annotation.width, Math.max(0, annotation.x + dx)),
    y: Math.min(documentHeight - annotation.height, Math.max(0, annotation.y + dy)),
  };
}
