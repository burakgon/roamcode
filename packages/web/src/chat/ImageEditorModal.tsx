import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import {
  Arrow,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
  Transformer,
} from "react-konva/lib/ReactKonvaCore.js";
import "konva/lib/shapes/Arrow.js";
import "konva/lib/shapes/Image.js";
import "konva/lib/shapes/Line.js";
import "konva/lib/shapes/Rect.js";
import "konva/lib/shapes/Text.js";
import "konva/lib/shapes/Transformer.js";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import {
  clampCrop,
  cropAnchorPoint,
  cropForAspect,
  cropHandleMetrics,
  createInitialEditorState,
  editorStateIsDirty,
  resizeCropFromAnchor,
  rotateEditorState90,
  supportsImageEditing,
  translateAnnotation,
  type CropAnchor,
  type ImageAnnotation,
  type ImageEditorState,
} from "./image-editor-model";

export { isLikelyImage, supportsImageEditing } from "./image-editor-model";

type Tool = "crop" | "draw" | "arrow" | "text" | "redact";
type Size = { width: number; height: number };
type Point = { x: number; y: number };
type TextEntry = Point & { value: string; annotationId?: string };
type CropAspect = "free" | "original" | "1:1" | "4:3" | "16:9";

const COLORS = ["#f77a44", "#ffffff", "#ffd166", "#58d68d", "#5dade2", "#111111"];
const COLOR_NAMES: Record<string, string> = {
  "#f77a44": "Coral",
  "#ffffff": "White",
  "#ffd166": "Yellow",
  "#58d68d": "Green",
  "#5dade2": "Blue",
  "#111111": "Black",
};
const MAX_HISTORY = 50;
const MAX_EXPORT_PIXELS = 16_000_000;
const CROP_ANCHORS: CropAnchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Image export failed"))), type, quality),
  );
}

function outputType(file: File): "image/png" | "image/jpeg" | "image/webp" {
  const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (file.type === "image/png" || extension === "png") return "image/png";
  if (file.type === "image/webp" || extension === "webp") return "image/webp";
  return "image/jpeg";
}

function placement(rotation: ImageEditorState["rotation"], width: number, height: number) {
  if (rotation === 90) return { x: height, y: 0, rotation };
  if (rotation === 180) return { x: width, y: height, rotation };
  if (rotation === 270) return { x: 0, y: width, rotation };
  return { x: 0, y: 0, rotation };
}

function pointsBounds(points: number[]): { x: number; y: number; width: number; height: number } {
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) };
}

function sameState(left: ImageEditorState, right: ImageEditorState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function annotationId(): string {
  return `annotation:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function ImageEditorModal({
  file,
  index,
  total,
  maxBytes,
  onCancel,
  onSend,
}: {
  file: File;
  index: number;
  total: number;
  maxBytes: number;
  onCancel: () => void;
  onSend: (file: File) => void;
}) {
  const editable = supportsImageEditing(file);
  const source = useMemo(() => URL.createObjectURL(file), [file]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const contentLayerRef = useRef<Konva.Layer>(null);
  const annotationTransformerRef = useRef<Konva.Transformer>(null);
  const annotationRefs = useRef(new Map<string, Konva.Node>());
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useFocusTrap(dialogRef, true);

  const [image, setImage] = useState<HTMLImageElement>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [stageSize, setStageSize] = useState<Size>({ width: 1, height: 1 });
  const [editorState, setEditorState] = useState<ImageEditorState>(() => createInitialEditorState(1, 1));
  const editorStateRef = useRef(editorState);
  const [undoStack, setUndoStack] = useState<ImageEditorState[]>([]);
  const [redoStack, setRedoStack] = useState<ImageEditorState[]>([]);
  const gestureBeforeRef = useRef<ImageEditorState | undefined>(undefined);
  const [tool, setTool] = useState<Tool>("crop");
  const [color, setColor] = useState(COLORS[0]!);
  const [strokeWidth, setStrokeWidth] = useState(5);
  const [textSize, setTextSize] = useState(28);
  const [cropAspect, setCropAspect] = useState<CropAspect>("free");
  const [cropDragging, setCropDragging] = useState(false);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string>();
  const selectedAnnotationIdRef = useRef<string | undefined>(undefined);
  selectedAnnotationIdRef.current = selectedAnnotationId;
  const nudgeSelectedRef = useRef<(screenDx: number, screenDy: number) => void>(() => {});
  const [draft, setDraft] = useState<ImageAnnotation>();
  const [textEntry, setTextEntry] = useState<TextEntry>();
  const textEntryRef = useRef<TextEntry | undefined>(undefined);
  const cancelTextEntryRef = useRef(false);
  const lastTextTapRef = useRef<{ id: string; at: number } | undefined>(undefined);
  textEntryRef.current = textEntry;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const pinchRef = useRef<{ distance: number; point: Point; zoom: number } | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const applyState = useCallback((next: ImageEditorState) => {
    editorStateRef.current = next;
    setEditorState(next);
  }, []);

  const commitState = useCallback(
    (next: ImageEditorState) => {
      const current = editorStateRef.current;
      if (sameState(current, next)) return;
      setUndoStack((items) => [...items, current].slice(-MAX_HISTORY));
      setRedoStack([]);
      applyState(next);
    },
    [applyState],
  );

  const beginGesture = () => {
    gestureBeforeRef.current = editorStateRef.current;
  };

  const finishGesture = () => {
    const before = gestureBeforeRef.current;
    gestureBeforeRef.current = undefined;
    if (!before || sameState(before, editorStateRef.current)) return;
    setUndoStack((items) => [...items, before].slice(-MAX_HISTORY));
    setRedoStack([]);
  };

  const undo = useCallback(() => {
    setUndoStack((items) => {
      const previous = items.at(-1);
      if (!previous) return items;
      setRedoStack((redo) => [...redo, editorStateRef.current].slice(-MAX_HISTORY));
      applyState(previous);
      return items.slice(0, -1);
    });
  }, [applyState]);

  const redo = useCallback(() => {
    setRedoStack((items) => {
      const next = items.at(-1);
      if (!next) return items;
      setUndoStack((undoItems) => [...undoItems, editorStateRef.current].slice(-MAX_HISTORY));
      applyState(next);
      return items.slice(0, -1);
    });
  }, [applyState]);

  const updateAnnotation = useCallback(
    (id: string, update: (annotation: ImageAnnotation) => ImageAnnotation, record = true) => {
      const current = editorStateRef.current;
      const annotations = current.annotations.map((annotation) =>
        annotation.id === id ? update(annotation) : annotation,
      );
      const next = { ...current, annotations };
      if (record) commitState(next);
      else applyState(next);
    },
    [applyState, commitState],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedAnnotationId) return;
    const current = editorStateRef.current;
    commitState({
      ...current,
      annotations: current.annotations.filter((annotation) => annotation.id !== selectedAnnotationId),
    });
    setSelectedAnnotationId(undefined);
  }, [commitState, selectedAnnotationId]);
  const deleteSelectedRef = useRef(deleteSelected);
  deleteSelectedRef.current = deleteSelected;

  useEffect(() => () => URL.revokeObjectURL(source), [source]);

  useEffect(() => {
    if (!editable) return;
    let active = true;
    setLoadFailed(false);
    const next = new window.Image();
    next.decoding = "async";
    next.onload = () => {
      if (!active) return;
      setImage(next);
      const initial = createInitialEditorState(next.naturalWidth, next.naturalHeight);
      applyState(initial);
      setUndoStack([]);
      setRedoStack([]);
      setSelectedAnnotationId(undefined);
      setDraft(undefined);
      cancelTextEntryRef.current = true;
      setTextEntry(undefined);
      setTool("crop");
      setCropAspect("free");
      setZoom(1);
      setPan({ x: 0, y: 0 });
    };
    next.onerror = () => active && setLoadFailed(true);
    next.src = source;
    return () => {
      active = false;
    };
  }, [applyState, editable, source]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const measure = () =>
      setStageSize({ width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight) });
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [editable, image, loadFailed]);

  useEffect(() => {
    const close = () => cancelRef.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (textEntryRef.current) {
          cancelTextEntryRef.current = true;
          setTextEntry(undefined);
        } else if (selectedAnnotationIdRef.current) setSelectedAnnotationId(undefined);
        else close();
        return;
      }
      const target = event.target;
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedAnnotationIdRef.current &&
        !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        deleteSelectedRef.current();
        return;
      }
      if (selectedAnnotationIdRef.current && event.key.startsWith("Arrow")) {
        const amount = event.shiftKey ? 10 : 1;
        const direction = {
          ArrowLeft: [-amount, 0],
          ArrowRight: [amount, 0],
          ArrowUp: [0, -amount],
          ArrowDown: [0, amount],
        }[event.key];
        if (direction) {
          event.preventDefault();
          nudgeSelectedRef.current(direction[0]!, direction[1]!);
          return;
        }
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("popstate", close);
    window.history.pushState({ rcImageEditor: true }, "");
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("popstate", close);
      if ((window.history.state as { rcImageEditor?: boolean } | null)?.rcImageEditor) window.history.back();
    };
  }, [redo, undo]);

  useEffect(() => {
    if (selectedAnnotationId && !editorState.annotations.some((annotation) => annotation.id === selectedAnnotationId)) {
      setSelectedAnnotationId(undefined);
    }
  }, [editorState.annotations, selectedAnnotationId]);

  const naturalWidth = image?.naturalWidth ?? 1;
  const naturalHeight = image?.naturalHeight ?? 1;
  const rotated = editorState.rotation === 90 || editorState.rotation === 270;
  const documentWidth = rotated ? naturalHeight : naturalWidth;
  const documentHeight = rotated ? naturalWidth : naturalHeight;
  const fitScale = Math.max(
    0.0001,
    Math.min(Math.max(1, stageSize.width - 28) / documentWidth, Math.max(1, stageSize.height - 28) / documentHeight),
  );
  const viewScale = fitScale * zoom;
  const viewX = (stageSize.width - documentWidth * viewScale) / 2 + pan.x;
  const viewY = (stageSize.height - documentHeight * viewScale) / 2 + pan.y;
  nudgeSelectedRef.current = (screenDx, screenDy) => {
    const id = selectedAnnotationIdRef.current;
    if (!id) return;
    const current = editorStateRef.current;
    const annotation = current.annotations.find((item) => item.id === id);
    if (!annotation) return;
    commitState({
      ...current,
      annotations: current.annotations.map((item) =>
        item.id === id
          ? translateAnnotation(item, screenDx / viewScale, screenDy / viewScale, documentWidth, documentHeight)
          : item,
      ),
    });
  };

  useEffect(() => {
    const transformer = annotationTransformerRef.current;
    if (!transformer) return;
    const selected = selectedAnnotationId
      ? editorState.annotations.find((annotation) => annotation.id === selectedAnnotationId)
      : undefined;
    const node =
      selected && (selected.type === "text" || selected.type === "redact")
        ? annotationRefs.current.get(selected.id)
        : undefined;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [editorState.annotations, selectedAnnotationId, viewScale]);

  const documentPoint = (): Point | undefined => {
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return undefined;
    const point = { x: (pointer.x - viewX) / viewScale, y: (pointer.y - viewY) / viewScale };
    if (point.x < 0 || point.y < 0 || point.x > documentWidth || point.y > documentHeight) return undefined;
    return point;
  };

  const startAnnotation = (event?: Konva.KonvaEventObject<Event>) => {
    if (!image || pinchRef.current || tool === "crop") return;
    if (event && event.target !== event.target.getStage()) return;
    setSelectedAnnotationId(undefined);
    const point = documentPoint();
    if (!point) return;
    if (tool === "text") {
      cancelTextEntryRef.current = false;
      setTextEntry({ ...point, value: "" });
      return;
    }
    const logicalStroke = Math.max(1, strokeWidth / fitScale);
    if (tool === "draw" || tool === "arrow") {
      setDraft({
        id: annotationId(),
        type: tool,
        points: [point.x, point.y, point.x, point.y],
        color,
        strokeWidth: logicalStroke,
      });
    } else {
      setDraft({ id: annotationId(), type: "redact", x: point.x, y: point.y, width: 0, height: 0 });
    }
  };

  const moveAnnotation = () => {
    const point = documentPoint();
    if (!point || !draft) return;
    if (draft.type === "draw") {
      setDraft({ ...draft, points: [...draft.points, point.x, point.y] });
    } else if (draft.type === "arrow") {
      setDraft({ ...draft, points: [draft.points[0]!, draft.points[1]!, point.x, point.y] });
    } else if (draft.type === "redact") {
      setDraft({ ...draft, width: point.x - draft.x, height: point.y - draft.y });
    }
  };

  const finishAnnotation = () => {
    if (!draft) return;
    let completed = draft;
    if ("width" in draft) {
      const x = draft.width < 0 ? draft.x + draft.width : draft.x;
      const y = draft.height < 0 ? draft.y + draft.height : draft.y;
      completed = { ...draft, x, y, width: Math.abs(draft.width), height: Math.abs(draft.height) };
      if (completed.width < 3 / fitScale || completed.height < 3 / fitScale) {
        setDraft(undefined);
        return;
      }
    }
    if ("points" in completed && completed.points.length < 4) {
      setDraft(undefined);
      return;
    }
    commitState({ ...editorStateRef.current, annotations: [...editorStateRef.current.annotations, completed] });
    setSelectedAnnotationId(completed.id);
    setDraft(undefined);
  };

  const commitText = (entry: TextEntry) => {
    cancelTextEntryRef.current = false;
    const text = entry.value.trim();
    setTextEntry(undefined);
    if (!text) return;
    if (entry.annotationId) {
      updateAnnotation(entry.annotationId, (annotation) =>
        annotation.type === "text" ? { ...annotation, text } : annotation,
      );
      setSelectedAnnotationId(entry.annotationId);
      return;
    }
    const annotation: ImageAnnotation = {
      id: annotationId(),
      type: "text",
      x: entry.x,
      y: entry.y,
      text,
      color,
      fontSize: Math.max(1, textSize / fitScale),
      rotation: 0,
    };
    commitState({ ...editorStateRef.current, annotations: [...editorStateRef.current.annotations, annotation] });
    setSelectedAnnotationId(annotation.id);
  };

  const editTextAnnotation = (annotation: Extract<ImageAnnotation, { type: "text" }>) => {
    cancelTextEntryRef.current = false;
    setSelectedAnnotationId(annotation.id);
    setTextEntry({
      annotationId: annotation.id,
      x: annotation.x,
      y: annotation.y,
      value: annotation.text,
    });
  };

  const handleTextTap = (annotation: Extract<ImageAnnotation, { type: "text" }>) => {
    const now = Date.now();
    const previous = lastTextTapRef.current;
    if (previous?.id === annotation.id && now - previous.at <= 450) {
      lastTextTapRef.current = undefined;
      editTextAnnotation(annotation);
      return;
    }
    lastTextTapRef.current = { id: annotation.id, at: now };
  };

  const rotate = () => {
    commitState(rotateEditorState90(editorStateRef.current, documentHeight));
    setCropAspect("free");
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleUndo = () => {
    cancelTextEntryRef.current = true;
    setTextEntry(undefined);
    setDraft(undefined);
    undo();
  };

  const exportAndSend = async () => {
    if (!editable || loadFailed || !image) {
      onSend(file);
      return;
    }
    if (!editorStateIsDirty(editorStateRef.current, naturalWidth, naturalHeight)) {
      onSend(file);
      return;
    }
    const layer = contentLayerRef.current;
    if (!layer) return;
    const selection = annotationTransformerRef.current;
    setSaving(true);
    setError(undefined);
    try {
      selection?.visible(false);
      layer.batchDraw();
      const crop = editorStateRef.current.crop;
      const pixelLimitScale = Math.min(1, Math.sqrt(MAX_EXPORT_PIXELS / Math.max(1, crop.width * crop.height)));
      let canvas = layer.toCanvas({
        x: viewX + crop.x * viewScale,
        y: viewY + crop.y * viewScale,
        width: crop.width * viewScale,
        height: crop.height * viewScale,
        pixelRatio: pixelLimitScale / viewScale,
      });
      const outputWidth = Math.max(1, Math.round(crop.width * pixelLimitScale));
      const outputHeight = Math.max(1, Math.round(crop.height * pixelLimitScale));
      if (canvas.width !== outputWidth || canvas.height !== outputHeight) {
        const normalized = document.createElement("canvas");
        normalized.width = outputWidth;
        normalized.height = outputHeight;
        const context = normalized.getContext("2d");
        if (!context) throw new Error("Image export failed");
        context.drawImage(canvas, 0, 0, outputWidth, outputHeight);
        canvas = normalized;
      }
      const type = outputType(file);
      const blob = await canvasBlob(canvas, type, type === "image/png" ? 1 : 0.92);
      if (blob.size > maxBytes) {
        setError(
          `Edited image is ${Math.ceil(blob.size / 1_048_576)} MB; the limit is ${Math.floor(maxBytes / 1_048_576)} MB. Crop it further or cancel and send a smaller image.`,
        );
        return;
      }
      onSend(new File([blob], file.name, { type, lastModified: Date.now() }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Image export failed");
    } finally {
      selection?.visible(true);
      layer.batchDraw();
      setSaving(false);
    }
  };

  const registerAnnotationRef = (id: string, node: Konva.Node | null) => {
    if (node) annotationRefs.current.set(id, node);
    else annotationRefs.current.delete(id);
  };

  const selectAnnotation = (event: Konva.KonvaEventObject<Event>, id: string) => {
    event.cancelBubble = true;
    setDraft(undefined);
    setSelectedAnnotationId(id);
  };

  const startAnnotationDrag = (event: Konva.KonvaEventObject<DragEvent>, id: string) => {
    selectAnnotation(event, id);
    beginGesture();
  };

  const finishAnnotationDrag = (event: Konva.KonvaEventObject<DragEvent>, annotation: ImageAnnotation) => {
    event.cancelBubble = true;
    const node = event.target;
    const baseX = "points" in annotation ? 0 : annotation.x;
    const baseY = "points" in annotation ? 0 : annotation.y;
    const translated = translateAnnotation(
      annotation,
      node.x() - baseX,
      node.y() - baseY,
      documentWidth,
      documentHeight,
    );
    if ("points" in annotation) node.position({ x: 0, y: 0 });
    updateAnnotation(annotation.id, () => translated, false);
    finishGesture();
  };

  const finishAnnotationTransform = (
    event: Konva.KonvaEventObject<Event>,
    annotation: Extract<ImageAnnotation, { type: "text" | "redact" }>,
  ) => {
    event.cancelBubble = true;
    const node = event.target;
    if (annotation.type === "text") {
      const nextFontSize = Math.max(8 / fitScale, annotation.fontSize * Math.max(node.scaleX(), node.scaleY()));
      const next: ImageAnnotation = {
        ...annotation,
        x: Math.min(documentWidth, Math.max(0, node.x())),
        y: Math.min(documentHeight, Math.max(0, node.y())),
        fontSize: nextFontSize,
        rotation: node.rotation(),
      };
      node.scale({ x: 1, y: 1 });
      updateAnnotation(annotation.id, () => next, false);
    } else {
      const next = clampCrop(
        {
          x: node.x(),
          y: node.y(),
          width: node.width() * node.scaleX(),
          height: node.height() * node.scaleY(),
        },
        documentWidth,
        documentHeight,
        18 / viewScale,
      );
      node.scale({ x: 1, y: 1 });
      updateAnnotation(annotation.id, () => ({ ...annotation, ...next }), false);
    }
    finishGesture();
  };

  const renderAnnotation = (annotation: ImageAnnotation) => {
    if ("points" in annotation) {
      if (annotation.type === "draw") {
        return (
          <Line
            key={annotation.id}
            ref={(node) => registerAnnotationRef(annotation.id, node)}
            points={annotation.points}
            stroke={annotation.color}
            strokeWidth={annotation.strokeWidth}
            lineCap="round"
            lineJoin="round"
            tension={0.35}
            hitStrokeWidth={Math.max(annotation.strokeWidth, 24 / viewScale)}
            draggable={tool !== "crop"}
            onMouseDown={(event) => selectAnnotation(event, annotation.id)}
            onTouchStart={(event) => selectAnnotation(event, annotation.id)}
            onDragStart={(event) => startAnnotationDrag(event, annotation.id)}
            onDragEnd={(event) => finishAnnotationDrag(event, annotation)}
          />
        );
      }
      return (
        <Arrow
          key={annotation.id}
          ref={(node) => registerAnnotationRef(annotation.id, node)}
          points={annotation.points}
          stroke={annotation.color}
          fill={annotation.color}
          strokeWidth={annotation.strokeWidth}
          pointerLength={annotation.strokeWidth * 3.6}
          pointerWidth={annotation.strokeWidth * 2.8}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(annotation.strokeWidth, 24 / viewScale)}
          draggable={tool !== "crop"}
          onMouseDown={(event) => selectAnnotation(event, annotation.id)}
          onTouchStart={(event) => selectAnnotation(event, annotation.id)}
          onDragStart={(event) => startAnnotationDrag(event, annotation.id)}
          onDragEnd={(event) => finishAnnotationDrag(event, annotation)}
        />
      );
    }
    if (annotation.type === "text") {
      return (
        <Text
          key={annotation.id}
          ref={(node) => registerAnnotationRef(annotation.id, node)}
          x={annotation.x}
          y={annotation.y}
          text={annotation.text}
          fill={annotation.color}
          fontFamily="Inter, system-ui, sans-serif"
          fontSize={annotation.fontSize}
          fontStyle="bold"
          rotation={annotation.rotation}
          padding={4 / viewScale}
          hitFunc={(context, shape) => {
            const hitPadding = 12 / viewScale;
            context.beginPath();
            context.rect(-hitPadding, -hitPadding, shape.width() + hitPadding * 2, shape.height() + hitPadding * 2);
            context.closePath();
            context.fillStrokeShape(shape);
          }}
          draggable={tool !== "crop"}
          onMouseDown={(event) => selectAnnotation(event, annotation.id)}
          onTouchStart={(event) => selectAnnotation(event, annotation.id)}
          onTap={() => handleTextTap(annotation)}
          onDblClick={() => editTextAnnotation(annotation)}
          onDblTap={() => editTextAnnotation(annotation)}
          onDragStart={(event) => startAnnotationDrag(event, annotation.id)}
          onDragEnd={(event) => finishAnnotationDrag(event, annotation)}
          onTransformStart={beginGesture}
          onTransformEnd={(event) => finishAnnotationTransform(event, annotation)}
        />
      );
    }
    return (
      <Rect
        key={annotation.id}
        ref={(node) => registerAnnotationRef(annotation.id, node)}
        x={annotation.x}
        y={annotation.y}
        width={annotation.width}
        height={annotation.height}
        fill="#000"
        draggable={tool !== "crop"}
        onMouseDown={(event) => selectAnnotation(event, annotation.id)}
        onTouchStart={(event) => selectAnnotation(event, annotation.id)}
        onDragStart={(event) => startAnnotationDrag(event, annotation.id)}
        onDragEnd={(event) => finishAnnotationDrag(event, annotation)}
        onTransformStart={beginGesture}
        onTransformEnd={(event) => finishAnnotationTransform(event, annotation)}
      />
    );
  };

  const beginCropGesture = () => {
    setCropDragging(true);
    beginGesture();
  };

  const finishCropGesture = () => {
    setCropDragging(false);
    finishGesture();
  };

  const applyCropAspect = (aspect: CropAspect) => {
    setCropAspect(aspect);
    if (aspect === "free") return;
    const ratio =
      aspect === "original" ? documentWidth / documentHeight : aspect === "1:1" ? 1 : aspect === "4:3" ? 4 / 3 : 16 / 9;
    commitState({
      ...editorStateRef.current,
      crop: cropForAspect(editorStateRef.current.crop, ratio, documentWidth, documentHeight, 44 / viewScale),
    });
  };

  const resetCrop = () => {
    setCropAspect("free");
    commitState({
      ...editorStateRef.current,
      crop: { x: 0, y: 0, width: documentWidth, height: documentHeight },
    });
  };

  const crop = editorState.crop;
  const selectedAnnotation = selectedAnnotationId
    ? editorState.annotations.find((annotation) => annotation.id === selectedAnnotationId)
    : undefined;
  const selectedDrawBounds = selectedAnnotation?.type === "draw" ? pointsBounds(selectedAnnotation.points) : undefined;
  const cropMode = tool === "crop" && !selectedAnnotation;
  const unsupported = !editable || loadFailed;
  const placementProps = placement(editorState.rotation, naturalWidth, naturalHeight);
  const textStagePosition = textEntry
    ? { left: viewX + textEntry.x * viewScale, top: viewY + textEntry.y * viewScale }
    : undefined;
  const selectedColor = selectedAnnotation && "color" in selectedAnnotation ? selectedAnnotation.color : undefined;
  const paletteColor = selectedColor ?? color;
  const showPalette =
    (selectedAnnotation !== undefined && selectedAnnotation.type !== "redact") ||
    (!selectedAnnotation && (tool === "draw" || tool === "arrow" || tool === "text"));
  const sizeMode =
    selectedAnnotation?.type === "text" || (!selectedAnnotation && tool === "text") ? "Text size" : "Width";
  const activeSize =
    selectedAnnotation?.type === "text"
      ? Math.round(selectedAnnotation.fontSize * fitScale)
      : selectedAnnotation && "strokeWidth" in selectedAnnotation
        ? Math.round(selectedAnnotation.strokeWidth * fitScale)
        : tool === "text"
          ? textSize
          : strokeWidth;

  const chooseColor = (nextColor: string) => {
    if (selectedAnnotation && "color" in selectedAnnotation) {
      updateAnnotation(selectedAnnotation.id, (annotation) =>
        "color" in annotation ? { ...annotation, color: nextColor } : annotation,
      );
    } else {
      setColor(nextColor);
    }
  };

  const chooseSize = (nextSize: number) => {
    if (selectedAnnotation?.type === "text") {
      updateAnnotation(selectedAnnotation.id, (annotation) =>
        annotation.type === "text" ? { ...annotation, fontSize: nextSize / fitScale } : annotation,
      );
    } else if (selectedAnnotation && "strokeWidth" in selectedAnnotation) {
      updateAnnotation(selectedAnnotation.id, (annotation) =>
        "strokeWidth" in annotation ? { ...annotation, strokeWidth: nextSize / fitScale } : annotation,
      );
    } else if (tool === "text") {
      setTextSize(nextSize);
    } else {
      setStrokeWidth(nextSize);
    }
  };

  return (
    <div ref={dialogRef} className="rc-ie" role="dialog" aria-modal="true" aria-label={`Edit ${file.name}`}>
      <header className="rc-ie__top">
        <button type="button" className="rc-ie__cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <div className="rc-ie__title">
          <strong>{unsupported ? "Share image" : "Edit image"}</strong>
          <span>
            {total > 1 ? `${index + 1} / ${total} · ` : ""}
            {file.name}
          </span>
        </div>
        <button
          type="button"
          className="rc-ie__send"
          onClick={() => void exportAndSend()}
          disabled={saving || (editable && !image && !loadFailed)}
        >
          {saving ? "Saving…" : unsupported ? "Send original" : "Send"}
        </button>
      </header>

      {error && (
        <div className="rc-ie__error" role="alert">
          {error}
        </div>
      )}
      <div className="rc-ie__sr" aria-live="polite">
        {selectedAnnotation
          ? `${selectedAnnotation.type} selected. Drag to move, use arrow keys to nudge, or Delete to remove.`
          : ""}
      </div>

      {unsupported ? (
        <div className="rc-ie__unsupported">
          <Icon name="image" size={30} />
          <strong>This format can't be edited safely</strong>
          <span>Send the original without converting it, or cancel this batch.</span>
        </div>
      ) : !image ? (
        <div className="rc-ie__loading" role="status">
          <Icon name="image" size={26} /> Loading image…
        </div>
      ) : (
        <>
          <div ref={canvasHostRef} className="rc-ie__canvas">
            <Stage
              ref={stageRef}
              width={stageSize.width}
              height={stageSize.height}
              onMouseDown={startAnnotation}
              onMouseMove={moveAnnotation}
              onMouseUp={finishAnnotation}
              onWheel={(event) => {
                event.evt.preventDefault();
                const pointer = stageRef.current?.getPointerPosition();
                if (!pointer) return;
                const oldScale = viewScale;
                const point = { x: (pointer.x - viewX) / oldScale, y: (pointer.y - viewY) / oldScale };
                const nextZoom = Math.min(4, Math.max(1, zoom * (event.evt.deltaY > 0 ? 0.9 : 1.1)));
                const nextScale = fitScale * nextZoom;
                const nextBaseX = (stageSize.width - documentWidth * nextScale) / 2;
                const nextBaseY = (stageSize.height - documentHeight * nextScale) / 2;
                setZoom(nextZoom);
                setPan({
                  x: pointer.x - point.x * nextScale - nextBaseX,
                  y: pointer.y - point.y * nextScale - nextBaseY,
                });
              }}
              onTouchStart={(event) => {
                const touches = event.evt.touches;
                if (touches.length === 1) {
                  startAnnotation(event);
                  return;
                }
                if (touches.length !== 2) return;
                setDraft(undefined);
                cancelTextEntryRef.current = true;
                setTextEntry(undefined);
                const distance = Math.hypot(
                  touches[0]!.clientX - touches[1]!.clientX,
                  touches[0]!.clientY - touches[1]!.clientY,
                );
                const bounds = stageRef.current?.container().getBoundingClientRect();
                if (!bounds) return;
                const center = {
                  x: (touches[0]!.clientX + touches[1]!.clientX) / 2 - bounds.left,
                  y: (touches[0]!.clientY + touches[1]!.clientY) / 2 - bounds.top,
                };
                pinchRef.current = {
                  distance,
                  point: { x: (center.x - viewX) / viewScale, y: (center.y - viewY) / viewScale },
                  zoom,
                };
              }}
              onTouchMove={(event) => {
                const touches = event.evt.touches;
                if (touches.length === 1 && !pinchRef.current) {
                  moveAnnotation();
                  return;
                }
                const pinch = pinchRef.current;
                if (!pinch || touches.length !== 2) return;
                event.evt.preventDefault();
                const distance = Math.hypot(
                  touches[0]!.clientX - touches[1]!.clientX,
                  touches[0]!.clientY - touches[1]!.clientY,
                );
                const bounds = stageRef.current?.container().getBoundingClientRect();
                if (!bounds) return;
                const center = {
                  x: (touches[0]!.clientX + touches[1]!.clientX) / 2 - bounds.left,
                  y: (touches[0]!.clientY + touches[1]!.clientY) / 2 - bounds.top,
                };
                const nextZoom = Math.min(4, Math.max(1, pinch.zoom * (distance / Math.max(1, pinch.distance))));
                const nextScale = fitScale * nextZoom;
                const nextBaseX = (stageSize.width - documentWidth * nextScale) / 2;
                const nextBaseY = (stageSize.height - documentHeight * nextScale) / 2;
                setZoom(nextZoom);
                setPan({
                  x: center.x - pinch.point.x * nextScale - nextBaseX,
                  y: center.y - pinch.point.y * nextScale - nextBaseY,
                });
              }}
              onTouchEnd={(event) => {
                if (pinchRef.current) {
                  if (event.evt.touches.length < 2) pinchRef.current = undefined;
                  return;
                }
                if (event.evt.touches.length === 0) finishAnnotation();
              }}
              onTouchCancel={() => {
                pinchRef.current = undefined;
                setDraft(undefined);
              }}
            >
              <Layer ref={contentLayerRef}>
                <Group x={viewX} y={viewY} scaleX={viewScale} scaleY={viewScale}>
                  <KonvaImage
                    image={image}
                    width={naturalWidth}
                    height={naturalHeight}
                    listening={false}
                    {...placementProps}
                  />
                  {editorState.annotations.map(renderAnnotation)}
                  {draft && <Group listening={false}>{renderAnnotation(draft)}</Group>}
                  <Transformer
                    ref={annotationTransformerRef}
                    rotateEnabled={selectedAnnotation?.type === "text"}
                    flipEnabled={false}
                    keepRatio={selectedAnnotation?.type === "text"}
                    resizeEnabled={selectedAnnotation?.type === "text" || selectedAnnotation?.type === "redact"}
                    enabledAnchors={
                      selectedAnnotation?.type === "text"
                        ? ["bottom-right"]
                        : [
                            "top-left",
                            "top-center",
                            "top-right",
                            "middle-left",
                            "middle-right",
                            "bottom-left",
                            "bottom-center",
                            "bottom-right",
                          ]
                    }
                    anchorSize={12}
                    anchorCornerRadius={3}
                    anchorFill="#ffffff"
                    anchorStroke="#f77a44"
                    anchorStrokeWidth={1.5}
                    borderStroke="#f77a44"
                    borderStrokeWidth={1.5}
                    rotateAnchorOffset={28}
                    padding={4}
                    anchorStyleFunc={(anchor) => anchor.hitStrokeWidth(44)}
                  />
                </Group>
              </Layer>
              <Layer>
                <Group x={viewX} y={viewY} scaleX={viewScale} scaleY={viewScale}>
                  <Rect x={0} y={0} width={documentWidth} height={crop.y} fill="rgba(0,0,0,.5)" listening={false} />
                  <Rect x={0} y={crop.y} width={crop.x} height={crop.height} fill="rgba(0,0,0,.5)" listening={false} />
                  <Rect
                    x={crop.x + crop.width}
                    y={crop.y}
                    width={Math.max(0, documentWidth - crop.x - crop.width)}
                    height={crop.height}
                    fill="rgba(0,0,0,.5)"
                    listening={false}
                  />
                  <Rect
                    x={0}
                    y={crop.y + crop.height}
                    width={documentWidth}
                    height={Math.max(0, documentHeight - crop.y - crop.height)}
                    fill="rgba(0,0,0,.5)"
                    listening={false}
                  />
                  <Rect
                    x={crop.x}
                    y={crop.y}
                    width={crop.width}
                    height={crop.height}
                    fill={cropMode ? "rgba(255,255,255,.001)" : undefined}
                    stroke={cropMode ? "#f77a44" : "rgba(255,255,255,.58)"}
                    strokeWidth={(cropMode ? 2 : 1) / viewScale}
                    dash={cropMode ? undefined : [7 / viewScale, 5 / viewScale]}
                    draggable={cropMode}
                    listening={cropMode}
                    onMouseDown={(event) => {
                      event.cancelBubble = true;
                    }}
                    onTouchStart={(event) => {
                      event.cancelBubble = true;
                    }}
                    onDragStart={() => {
                      setCropAspect("free");
                      beginCropGesture();
                    }}
                    onDragMove={(event) => {
                      const node = event.target;
                      const next = clampCrop(
                        { ...editorStateRef.current.crop, x: node.x(), y: node.y() },
                        documentWidth,
                        documentHeight,
                        44 / viewScale,
                      );
                      node.position({ x: next.x, y: next.y });
                      applyState({ ...editorStateRef.current, crop: next });
                    }}
                    onDragEnd={finishCropGesture}
                  />
                  {cropDragging &&
                    [1, 2].flatMap((part) => [
                      <Line
                        key={`crop-v-${part}`}
                        points={[
                          crop.x + (crop.width * part) / 3,
                          crop.y,
                          crop.x + (crop.width * part) / 3,
                          crop.y + crop.height,
                        ]}
                        stroke="rgba(255,255,255,.72)"
                        strokeWidth={1 / viewScale}
                        listening={false}
                      />,
                      <Line
                        key={`crop-h-${part}`}
                        points={[
                          crop.x,
                          crop.y + (crop.height * part) / 3,
                          crop.x + crop.width,
                          crop.y + (crop.height * part) / 3,
                        ]}
                        stroke="rgba(255,255,255,.72)"
                        strokeWidth={1 / viewScale}
                        listening={false}
                      />,
                    ])}
                  {cropMode &&
                    CROP_ANCHORS.map((anchor) => {
                      const point = cropAnchorPoint(crop, anchor);
                      const { hitSize: hit, visualWidth, visualHeight } = cropHandleMetrics(anchor, viewScale);
                      return (
                        <Group
                          key={anchor}
                          x={point.x}
                          y={point.y}
                          draggable
                          onMouseDown={(event) => {
                            event.cancelBubble = true;
                          }}
                          onTouchStart={(event) => {
                            event.cancelBubble = true;
                          }}
                          onDragStart={() => {
                            setCropAspect("free");
                            beginCropGesture();
                          }}
                          onDragMove={(event) => {
                            const node = event.target;
                            const next = resizeCropFromAnchor(
                              editorStateRef.current.crop,
                              anchor,
                              { x: node.x(), y: node.y() },
                              documentWidth,
                              documentHeight,
                              44 / viewScale,
                            );
                            applyState({ ...editorStateRef.current, crop: next });
                            node.position(cropAnchorPoint(next, anchor));
                          }}
                          onDragEnd={finishCropGesture}
                        >
                          <Rect x={-hit / 2} y={-hit / 2} width={hit} height={hit} fill="rgba(255,255,255,.001)" />
                          <Rect
                            x={-visualWidth / 2}
                            y={-visualHeight / 2}
                            width={visualWidth}
                            height={visualHeight}
                            cornerRadius={Math.min(3 / viewScale, visualHeight / 2)}
                            fill="#fff"
                            stroke="#f77a44"
                            strokeWidth={1.5 / viewScale}
                            listening={false}
                          />
                        </Group>
                      );
                    })}
                  {selectedDrawBounds && (
                    <Rect
                      x={selectedDrawBounds.x - 4 / viewScale}
                      y={selectedDrawBounds.y - 4 / viewScale}
                      width={selectedDrawBounds.width + 8 / viewScale}
                      height={selectedDrawBounds.height + 8 / viewScale}
                      stroke="#f77a44"
                      strokeWidth={1.5 / viewScale}
                      dash={[6 / viewScale, 4 / viewScale]}
                      listening={false}
                    />
                  )}
                  {selectedAnnotation?.type === "arrow" &&
                    [0, selectedAnnotation.points.length - 2].map((pointIndex) => {
                      const size = 11 / viewScale;
                      const hit = 44 / viewScale;
                      return (
                        <Group
                          key={pointIndex}
                          x={selectedAnnotation.points[pointIndex]}
                          y={selectedAnnotation.points[pointIndex + 1]}
                          draggable
                          onMouseDown={(event) => {
                            event.cancelBubble = true;
                          }}
                          onTouchStart={(event) => {
                            event.cancelBubble = true;
                          }}
                          onDragStart={beginGesture}
                          onDragMove={(event) => {
                            const node = event.target;
                            updateAnnotation(
                              selectedAnnotation.id,
                              (annotation) => {
                                if (annotation.type !== "arrow") return annotation;
                                const points = [...annotation.points];
                                points[pointIndex] = Math.min(documentWidth, Math.max(0, node.x()));
                                points[pointIndex + 1] = Math.min(documentHeight, Math.max(0, node.y()));
                                return { ...annotation, points };
                              },
                              false,
                            );
                          }}
                          onDragEnd={finishGesture}
                        >
                          <Rect x={-hit / 2} y={-hit / 2} width={hit} height={hit} fill="rgba(255,255,255,.001)" />
                          <Rect
                            x={-size / 2}
                            y={-size / 2}
                            width={size}
                            height={size}
                            cornerRadius={size / 2}
                            fill="#fff"
                            stroke="#f77a44"
                            strokeWidth={1.5 / viewScale}
                            listening={false}
                          />
                        </Group>
                      );
                    })}
                </Group>
              </Layer>
            </Stage>
            {textEntry && textStagePosition && (
              <input
                className="rc-ie__textentry"
                style={textStagePosition}
                value={textEntry.value}
                placeholder="Type text"
                autoFocus
                onChange={(event) => setTextEntry({ ...textEntry, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelTextEntryRef.current = true;
                    setTextEntry(undefined);
                  }
                }}
                onBlur={() => {
                  if (cancelTextEntryRef.current) {
                    cancelTextEntryRef.current = false;
                    return;
                  }
                  commitText(textEntry);
                }}
              />
            )}
          </div>

          <div className="rc-ie__controls">
            <div className="rc-ie__history" aria-label="Edit history">
              <button type="button" onClick={handleUndo} disabled={undoStack.length === 0} aria-label="Undo">
                Undo
              </button>
              <button type="button" onClick={redo} disabled={redoStack.length === 0} aria-label="Redo">
                Redo
              </button>
              <button type="button" onClick={rotate} aria-label="Rotate clockwise">
                Rotate
              </button>
            </div>
            {cropMode && (
              <div className="rc-ie__crop-options" aria-label="Crop options">
                {(["free", "original", "1:1", "4:3", "16:9"] as CropAspect[]).map((aspect) => (
                  <button
                    key={aspect}
                    type="button"
                    className={cropAspect === aspect ? "is-on" : ""}
                    aria-pressed={cropAspect === aspect}
                    onClick={() => applyCropAspect(aspect)}
                  >
                    {aspect === "free" ? "Free" : aspect === "original" ? "Original" : aspect}
                  </button>
                ))}
                <button type="button" onClick={resetCrop}>
                  Reset
                </button>
              </div>
            )}
            {selectedAnnotation && (
              <div className="rc-ie__selection-actions" aria-label="Selected annotation actions">
                <span>
                  {selectedAnnotation.type === "text" ? "Text selected" : `${selectedAnnotation.type} selected`}
                </span>
                {selectedAnnotation.type === "text" && (
                  <button type="button" onClick={() => editTextAnnotation(selectedAnnotation)}>
                    Edit text
                  </button>
                )}
                <button type="button" className="is-danger" onClick={deleteSelected}>
                  Delete
                </button>
              </div>
            )}
            {showPalette && (
              <div className="rc-ie__palette" aria-label="Annotation style">
                {COLORS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-label={COLOR_NAMES[item] ?? item}
                    aria-pressed={paletteColor === item}
                    className={paletteColor === item ? "is-on" : ""}
                    style={{ backgroundColor: item }}
                    onClick={() => chooseColor(item)}
                  />
                ))}
                <label>
                  <span>{sizeMode}</span>
                  <input
                    type="range"
                    min={sizeMode === "Text size" ? 14 : 2}
                    max={sizeMode === "Text size" ? 64 : 12}
                    step="1"
                    value={activeSize}
                    aria-label={sizeMode}
                    onChange={(event) => chooseSize(Number(event.target.value))}
                  />
                </label>
              </div>
            )}
            <div className="rc-ie__tools" role="toolbar" aria-label="Image tools">
              {(["crop", "draw", "arrow", "text", "redact"] as Tool[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={tool === item}
                  className={tool === item ? "is-on" : ""}
                  onClick={() => {
                    setDraft(undefined);
                    cancelTextEntryRef.current = true;
                    setTextEntry(undefined);
                    setSelectedAnnotationId(undefined);
                    setTool(item);
                  }}
                >
                  {item[0]!.toUpperCase() + item.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <style>{css}</style>
    </div>
  );
}

export default ImageEditorModal;

const css = `
.rc-ie { position: fixed; inset: 0; z-index: 90; display: flex; flex-direction: column; overflow: hidden; padding-top: env(safe-area-inset-top,0px); background: #09090b; color: var(--text); }
.rc-ie__sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.rc-ie__top { min-height: 60px; display: grid; grid-template-columns: minmax(76px,auto) minmax(0,1fr) minmax(76px,auto); align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
.rc-ie__top button { min-height: 44px; padding: 0 12px; border: 0; border-radius: 9px; background: transparent; color: var(--text-muted); font: 650 12px/1 var(--font-mono); white-space: nowrap; }
.rc-ie__top .rc-ie__send { background: var(--coral); color: var(--on-accent); }
.rc-ie__top button:disabled { opacity: .48; }
.rc-ie__title { min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; }
.rc-ie__title strong { font: 650 14px/1.2 var(--font-body); }.rc-ie__title span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font: 10px/1.2 var(--font-mono); }
.rc-ie__error { padding: 9px 12px; background: color-mix(in srgb,var(--warn) 14%,var(--surface)); color: var(--warn); font-size: 12px; text-align: center; }
.rc-ie__loading,.rc-ie__unsupported { flex: 1; min-height: 240px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; color: var(--text-faint); }
.rc-ie__loading { flex-direction: row; }.rc-ie__unsupported strong { color: var(--text); font-size: 14px; }.rc-ie__unsupported span { max-width: 330px; font-size: 12px; line-height: 1.5; }
.rc-ie__canvas { position: relative; flex: 1 1 auto; min-height: 150px; overflow: hidden; touch-action: none; background: #050506; }
.rc-ie__canvas canvas { display: block; }
.rc-ie__textentry { position: absolute; z-index: 3; width: min(260px,calc(100% - 24px)); min-height: 44px; transform: translate(-4px,-4px); padding: 8px 10px; border: 2px solid var(--coral); border-radius: 8px; outline: none; background: rgba(10,10,12,.94); color: #fff; font: 600 16px/1.2 var(--font-body); box-shadow: var(--shadow-1); }
.rc-ie__controls { flex: 0 0 auto; padding: 7px 8px calc(8px + env(safe-area-inset-bottom,0px)); display: flex; flex-direction: column; gap: 7px; border-top: 1px solid var(--border); background: var(--surface); }
.rc-ie__history,.rc-ie__tools { display: grid; gap: 5px; }.rc-ie__history { grid-template-columns: repeat(3,minmax(0,1fr)); }.rc-ie__tools { grid-template-columns: repeat(5,minmax(0,1fr)); }
.rc-ie__history button,.rc-ie__tools button { min-width: 0; min-height: 40px; padding: 0 7px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text-muted); font: 650 10px/1 var(--font-mono); }
.rc-ie__history button:disabled { opacity: .35; }.rc-ie__tools button.is-on { border-color: color-mix(in srgb,var(--coral) 58%,var(--border)); background: color-mix(in srgb,var(--coral) 12%,transparent); color: var(--coral); }
.rc-ie__crop-options { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap: 5px; }.rc-ie__crop-options button { min-width: 0; min-height: 34px; padding: 0 5px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text-muted); font: 600 9px/1 var(--font-mono); }.rc-ie__crop-options button.is-on { border-color: var(--accent-line); background: color-mix(in srgb,var(--coral) 10%,transparent); color: var(--coral); }
.rc-ie__selection-actions { min-height: 36px; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }.rc-ie__selection-actions > span { min-width: 0; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font: 600 10px/1 var(--font-mono); text-transform: capitalize; }.rc-ie__selection-actions button { min-height: 34px; padding: 0 11px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text-muted); font: 650 10px/1 var(--font-mono); }.rc-ie__selection-actions button.is-danger { color: var(--warn); }
.rc-ie__palette { min-height: 34px; display: flex; align-items: center; justify-content: center; gap: 9px; }.rc-ie__palette > button { width: 27px; height: 27px; padding: 0; border: 2px solid rgba(255,255,255,.22); border-radius: 999px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.34); }.rc-ie__palette > button.is-on { outline: 2px solid var(--coral); outline-offset: 2px; }
.rc-ie__palette label { margin-left: 5px; display: flex; align-items: center; gap: 6px; color: var(--text-faint); font: 9px/1 var(--font-mono); }.rc-ie__palette input { width: 74px; accent-color: var(--coral); }
@media (min-width:768px) { .rc-ie { inset: 5vh max(24px,calc((100vw - 1120px)/2)); padding-top: 0; border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: 0 30px 90px rgba(0,0,0,.68); }.rc-ie__controls { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding-bottom: 8px; }.rc-ie__history { grid-template-columns: repeat(3,72px); }.rc-ie__tools { flex: 1 1 380px; }.rc-ie__palette,.rc-ie__crop-options { flex: 1 1 360px; }.rc-ie__selection-actions { flex: 0 1 250px; }.rc-ie__tools button,.rc-ie__history button { min-height: 44px; }.rc-ie__palette { justify-content: center; } }
@media (max-width:420px) { .rc-ie__top { grid-template-columns: minmax(68px,auto) minmax(0,1fr) minmax(76px,auto); gap: 4px; padding-inline: 7px; }.rc-ie__top button { padding: 0 7px; font-size: 11px; }.rc-ie__palette { gap: 7px; }.rc-ie__palette > button { width: 24px; height: 24px; }.rc-ie__palette label span { display:none; }.rc-ie__palette input { width: 56px; }.rc-ie__tools button { font-size: 9px; } }
@media (prefers-reduced-motion:no-preference) { .rc-ie button { transition: background-color .14s ease,border-color .14s ease,color .14s ease,filter .14s ease; } }
@media (forced-colors:active) { .rc-ie__palette > button.is-on { outline: 3px solid Highlight; }.rc-ie__tools button.is-on,.rc-ie__crop-options button.is-on { border-color: Highlight; color: Highlight; } }
@media (hover:hover) { .rc-ie button:hover { filter: brightness(1.14); } }
`;
