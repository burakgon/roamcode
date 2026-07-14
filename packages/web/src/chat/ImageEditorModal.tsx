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
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import {
  clampCrop,
  createInitialEditorState,
  editorStateIsDirty,
  rotateEditorState90,
  supportsImageEditing,
  type ImageAnnotation,
  type ImageEditorState,
} from "./image-editor-model";

export { isLikelyImage, supportsImageEditing } from "./image-editor-model";

type Tool = "crop" | "draw" | "arrow" | "text" | "redact";
type Size = { width: number; height: number };
type Point = { x: number; y: number };
type TextEntry = Point & { value: string };

const COLORS = ["#f77a44", "#ffffff", "#ffd166", "#58d68d", "#5dade2", "#111111"];
const MAX_HISTORY = 50;
const MAX_EXPORT_PIXELS = 16_000_000;

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
  const cropRef = useRef<Konva.Rect>(null);
  const cropTransformerRef = useRef<Konva.Transformer>(null);
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
  const [draft, setDraft] = useState<ImageAnnotation>();
  const [textEntry, setTextEntry] = useState<TextEntry>();
  const textEntryRef = useRef<TextEntry | undefined>(undefined);
  textEntryRef.current = textEntry;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const pinchRef = useRef<{ distance: number; center: Point; zoom: number; pan: Point } | undefined>(undefined);
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

  useEffect(() => () => URL.revokeObjectURL(source), [source]);

  useEffect(() => {
    if (!editable) return;
    let active = true;
    const next = new window.Image();
    next.decoding = "async";
    next.onload = () => {
      if (!active) return;
      setImage(next);
      const initial = createInitialEditorState(next.naturalWidth, next.naturalHeight);
      applyState(initial);
      setUndoStack([]);
      setRedoStack([]);
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
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [editable, loadFailed]);

  useEffect(() => {
    const close = () => cancelRef.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (textEntryRef.current) setTextEntry(undefined);
        else close();
        return;
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
    const transformer = cropTransformerRef.current;
    const crop = cropRef.current;
    if (!transformer) return;
    transformer.nodes(tool === "crop" && crop ? [crop] : []);
    transformer.getLayer()?.batchDraw();
  }, [editorState.crop, tool]);

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

  const documentPoint = (): Point | undefined => {
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return undefined;
    const point = { x: (pointer.x - viewX) / viewScale, y: (pointer.y - viewY) / viewScale };
    if (point.x < 0 || point.y < 0 || point.x > documentWidth || point.y > documentHeight) return undefined;
    return point;
  };

  const startAnnotation = () => {
    if (!image || pinchRef.current || tool === "crop") return;
    const point = documentPoint();
    if (!point) return;
    if (tool === "text") {
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
    setDraft(undefined);
  };

  const commitText = (entry: TextEntry) => {
    const text = entry.value.trim();
    setTextEntry(undefined);
    if (!text) return;
    const annotation: ImageAnnotation = {
      id: annotationId(),
      type: "text",
      x: entry.x,
      y: entry.y,
      text,
      color,
      fontSize: Math.max(1, 28 / fitScale),
      rotation: 0,
    };
    commitState({ ...editorStateRef.current, annotations: [...editorStateRef.current.annotations, annotation] });
  };

  const rotate = () => {
    commitState(rotateEditorState90(editorStateRef.current, documentHeight));
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleUndo = () => {
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
    setSaving(true);
    setError(undefined);
    try {
      const crop = editorStateRef.current.crop;
      const pixelLimitScale = Math.min(1, Math.sqrt(MAX_EXPORT_PIXELS / Math.max(1, crop.width * crop.height)));
      const canvas = layer.toCanvas({
        x: viewX + crop.x * viewScale,
        y: viewY + crop.y * viewScale,
        width: crop.width * viewScale,
        height: crop.height * viewScale,
        pixelRatio: pixelLimitScale / viewScale,
      });
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
      setSaving(false);
    }
  };

  const renderAnnotation = (annotation: ImageAnnotation) => {
    if ("points" in annotation) {
      if (annotation.type === "draw") {
        return (
          <Line
            key={annotation.id}
            points={annotation.points}
            stroke={annotation.color}
            strokeWidth={annotation.strokeWidth}
            lineCap="round"
            lineJoin="round"
            tension={0.35}
            listening={false}
          />
        );
      }
      return (
        <Arrow
          key={annotation.id}
          points={annotation.points}
          stroke={annotation.color}
          fill={annotation.color}
          strokeWidth={annotation.strokeWidth}
          pointerLength={annotation.strokeWidth * 3.6}
          pointerWidth={annotation.strokeWidth * 2.8}
          lineCap="round"
          lineJoin="round"
          listening={false}
        />
      );
    }
    if (annotation.type === "text") {
      return (
        <Text
          key={annotation.id}
          x={annotation.x}
          y={annotation.y}
          text={annotation.text}
          fill={annotation.color}
          fontFamily="Inter, system-ui, sans-serif"
          fontSize={annotation.fontSize}
          fontStyle="bold"
          rotation={annotation.rotation}
          listening={false}
        />
      );
    }
    return (
      <Rect
        key={annotation.id}
        x={annotation.x}
        y={annotation.y}
        width={annotation.width}
        height={annotation.height}
        fill="#000"
        listening={false}
      />
    );
  };

  const crop = editorState.crop;
  const unsupported = !editable || loadFailed;
  const placementProps = placement(editorState.rotation, naturalWidth, naturalHeight);
  const textStagePosition = textEntry
    ? { left: viewX + textEntry.x * viewScale, top: viewY + textEntry.y * viewScale }
    : undefined;

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
              onPointerDown={startAnnotation}
              onPointerMove={moveAnnotation}
              onPointerUp={finishAnnotation}
              onPointerCancel={() => setDraft(undefined)}
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
                if (touches.length !== 2) return;
                setDraft(undefined);
                const distance = Math.hypot(
                  touches[0]!.clientX - touches[1]!.clientX,
                  touches[0]!.clientY - touches[1]!.clientY,
                );
                const center = {
                  x: (touches[0]!.clientX + touches[1]!.clientX) / 2,
                  y: (touches[0]!.clientY + touches[1]!.clientY) / 2,
                };
                pinchRef.current = { distance, center, zoom, pan };
              }}
              onTouchMove={(event) => {
                const touches = event.evt.touches;
                const pinch = pinchRef.current;
                if (!pinch || touches.length !== 2) return;
                event.evt.preventDefault();
                const distance = Math.hypot(
                  touches[0]!.clientX - touches[1]!.clientX,
                  touches[0]!.clientY - touches[1]!.clientY,
                );
                const center = {
                  x: (touches[0]!.clientX + touches[1]!.clientX) / 2,
                  y: (touches[0]!.clientY + touches[1]!.clientY) / 2,
                };
                setZoom(Math.min(4, Math.max(1, pinch.zoom * (distance / Math.max(1, pinch.distance)))));
                setPan({ x: pinch.pan.x + center.x - pinch.center.x, y: pinch.pan.y + center.y - pinch.center.y });
              }}
              onTouchEnd={(event) => {
                if (event.evt.touches.length < 2) pinchRef.current = undefined;
              }}
            >
              <Layer ref={contentLayerRef} listening={false}>
                <Group x={viewX} y={viewY} scaleX={viewScale} scaleY={viewScale}>
                  <KonvaImage image={image} width={naturalWidth} height={naturalHeight} {...placementProps} />
                  {editorState.annotations.map(renderAnnotation)}
                  {draft && renderAnnotation(draft)}
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
                    ref={cropRef}
                    x={crop.x}
                    y={crop.y}
                    width={crop.width}
                    height={crop.height}
                    stroke={tool === "crop" ? "#f77a44" : "rgba(255,255,255,.58)"}
                    strokeWidth={1.5 / viewScale}
                    dash={tool === "crop" ? undefined : [7 / viewScale, 5 / viewScale]}
                    draggable={tool === "crop"}
                    onDragStart={beginGesture}
                    onDragMove={(event) => {
                      const node = event.target;
                      const next = clampCrop(
                        { ...crop, x: node.x(), y: node.y() },
                        documentWidth,
                        documentHeight,
                        28 / viewScale,
                      );
                      node.position({ x: next.x, y: next.y });
                      applyState({ ...editorStateRef.current, crop: next });
                    }}
                    onDragEnd={finishGesture}
                    onTransformStart={beginGesture}
                    onTransformEnd={() => {
                      const node = cropRef.current;
                      if (!node) return;
                      const next = clampCrop(
                        {
                          x: node.x(),
                          y: node.y(),
                          width: node.width() * node.scaleX(),
                          height: node.height() * node.scaleY(),
                        },
                        documentWidth,
                        documentHeight,
                        28 / viewScale,
                      );
                      node.scale({ x: 1, y: 1 });
                      applyState({ ...editorStateRef.current, crop: next });
                      finishGesture();
                    }}
                  />
                  <Transformer
                    ref={cropTransformerRef}
                    rotateEnabled={false}
                    flipEnabled={false}
                    keepRatio={false}
                    anchorSize={13 / viewScale}
                    anchorCornerRadius={3 / viewScale}
                    anchorFill="#ffffff"
                    anchorStroke="#f77a44"
                    anchorStrokeWidth={1.5 / viewScale}
                    borderStroke="#f77a44"
                    borderStrokeWidth={1.5 / viewScale}
                    enabledAnchors={[
                      "top-left",
                      "top-center",
                      "top-right",
                      "middle-left",
                      "middle-right",
                      "bottom-left",
                      "bottom-center",
                      "bottom-right",
                    ]}
                  />
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
                    setTextEntry(undefined);
                  }
                }}
                onBlur={() => commitText(textEntry)}
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
            <div className="rc-ie__palette" aria-label="Annotation color">
              {COLORS.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-label={`Color ${item}`}
                  aria-pressed={color === item}
                  className={color === item ? "is-on" : ""}
                  style={{ backgroundColor: item }}
                  onClick={() => setColor(item)}
                />
              ))}
              <label>
                <span>Width</span>
                <input
                  type="range"
                  min="2"
                  max="12"
                  step="1"
                  value={strokeWidth}
                  onChange={(event) => setStrokeWidth(Number(event.target.value))}
                />
              </label>
            </div>
            <div className="rc-ie__tools" role="toolbar" aria-label="Image tools">
              {(["crop", "draw", "arrow", "text", "redact"] as Tool[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={tool === item}
                  className={tool === item ? "is-on" : ""}
                  onClick={() => {
                    setDraft(undefined);
                    setTextEntry(undefined);
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
.rc-ie__palette { min-height: 34px; display: flex; align-items: center; justify-content: center; gap: 9px; }.rc-ie__palette > button { width: 27px; height: 27px; padding: 0; border: 2px solid rgba(255,255,255,.22); border-radius: 999px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.34); }.rc-ie__palette > button.is-on { outline: 2px solid var(--coral); outline-offset: 2px; }
.rc-ie__palette label { margin-left: 5px; display: flex; align-items: center; gap: 6px; color: var(--text-faint); font: 9px/1 var(--font-mono); }.rc-ie__palette input { width: 74px; accent-color: var(--coral); }
@media (min-width:768px) { .rc-ie { inset: 5vh max(24px,calc((100vw - 1120px)/2)); padding-top: 0; border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: 0 30px 90px rgba(0,0,0,.68); }.rc-ie__controls { display: grid; grid-template-columns: auto minmax(0,1fr) minmax(360px,1.5fr); align-items: center; gap: 12px; padding-bottom: 8px; }.rc-ie__history { grid-template-columns: repeat(3,72px); }.rc-ie__tools button,.rc-ie__history button { min-height: 44px; }.rc-ie__palette { justify-content: center; } }
@media (max-width:420px) { .rc-ie__top { grid-template-columns: minmax(68px,auto) minmax(0,1fr) minmax(76px,auto); gap: 4px; padding-inline: 7px; }.rc-ie__top button { padding: 0 7px; font-size: 11px; }.rc-ie__palette { gap: 7px; }.rc-ie__palette > button { width: 24px; height: 24px; }.rc-ie__palette label span { display:none; }.rc-ie__palette input { width: 56px; }.rc-ie__tools button { font-size: 9px; } }
@media (hover:hover) { .rc-ie button:hover { filter: brightness(1.14); } }
`;
