import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { FilerobotImageEditorConfig } from "react-filerobot-image-editor";
import isPropValid from "@emotion/is-prop-valid";
import { StyleSheetManager } from "styled-components";
import { Icon } from "../ui/Icon";

const FilerobotImageEditor = lazy(() => import("react-filerobot-image-editor"));

type SavedImageData = {
  name: string;
  extension: string;
  mimeType: string;
  fullName?: string;
  imageBase64?: string;
  imageCanvas?: HTMLCanvasElement;
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

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Image export failed"))), type, quality),
  );
}

async function savedImageToFile(data: SavedImageData, fallbackName: string): Promise<File> {
  const type = data.mimeType || (data.extension === "png" ? "image/png" : `image/${data.extension || "jpeg"}`);
  let blob: Blob;
  if (data.imageBase64) blob = await fetch(data.imageBase64).then((response) => response.blob());
  else if (data.imageCanvas) blob = await canvasBlob(data.imageCanvas, type, type === "image/png" ? 1 : 0.92);
  else throw new Error("Image editor returned no image data");
  return new File([blob], data.fullName || fallbackName, { type: blob.type || type, lastModified: Date.now() });
}

export function ImageEditorModal({
  file,
  index,
  total,
  maxBytes,
  onRemove,
  onUseOriginal,
  onSave,
}: {
  file: File;
  index: number;
  total: number;
  maxBytes: number;
  onRemove: () => void;
  onUseOriginal: () => void;
  onSave: (file: File) => void;
}) {
  const source = useMemo(() => URL.createObjectURL(file), [file]);
  const sourceExtension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase() : "";
  const savedType =
    file.type === "image/png" || sourceExtension === "png"
      ? "png"
      : file.type === "image/webp" || sourceExtension === "webp"
        ? "webp"
        : "jpeg";
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const onRemoveRef = useRef(onRemove);
  onRemoveRef.current = onRemove;
  useEffect(() => () => URL.revokeObjectURL(source), [source]);
  useEffect(() => {
    const close = () => onRemoveRef.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("popstate", close);
    window.history.pushState({ rcImageEditor: true }, "");
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("popstate", close);
      if ((window.history.state as { rcImageEditor?: boolean } | null)?.rcImageEditor) window.history.back();
    };
  }, []);

  const config: FilerobotImageEditorConfig = {
    source,
    tabsIds: ["Adjust", "Finetune", "Annotate"],
    defaultTabId: "Adjust",
    defaultToolId: "Crop",
    closeAfterSave: false,
    avoidChangesNotSavedAlertOnLeave: false,
    defaultSavedImageName: file.name.replace(/\.[^.]+$/, ""),
    defaultSavedImageType: savedType,
    defaultSavedImageQuality: savedType === "png" ? 1 : 0.92,
    savingPixelRatio: 1,
    previewPixelRatio: 1,
    Crop: { ratio: "custom" },
    Rotate: { componentType: "buttons" },
    annotationsCommon: { stroke: "#ff7547", strokeWidth: 4, fill: "transparent" },
    Pen: { stroke: "#ff7547", strokeWidth: 5, lineCap: "round", tension: 0.4 },
    Arrow: { stroke: "#ff7547", strokeWidth: 5, pointerLength: 18, pointerWidth: 14 },
    // A fully opaque rectangle is a real raster redaction after export; blur/pixelation can leak content.
    Rect: { stroke: "#000000", strokeWidth: 1, fill: "#000000", opacity: 1 },
    Ellipse: { stroke: "#ff7547", strokeWidth: 4, fill: "transparent" },
    Text: { fill: "#ff7547", fontFamily: "Inter", fontSize: 28 },
    translations: { rectangleTool: "Redact" },
    onClose: () => onRemove(),
    onSave: async (data) => {
      setSaving(true);
      setError(undefined);
      try {
        const edited = await savedImageToFile(data as SavedImageData, file.name);
        if (edited.size > maxBytes) {
          setError(
            `Edited image is ${Math.ceil(edited.size / 1_048_576)} MB; the limit is ${Math.floor(maxBytes / 1_048_576)} MB. Use the original or save at a lower quality.`,
          );
          return;
        }
        onSave(edited);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Image export failed");
      } finally {
        setSaving(false);
      }
    },
  };

  return (
    <div className="rc-ie" role="dialog" aria-modal="true" aria-label={`Edit ${file.name}`}>
      <div className="rc-ie__top">
        <div className="rc-ie__title">
          <strong>Edit image</strong>
          <span>
            {total > 1 ? `${index + 1} of ${total} · ` : ""}
            {file.name}
          </span>
        </div>
        <div className="rc-ie__quick">
          <button type="button" onClick={onRemove} disabled={saving}>
            Remove
          </button>
          <button type="button" onClick={onUseOriginal} disabled={saving}>
            Use original
          </button>
        </div>
      </div>
      {error && (
        <div className="rc-ie__error" role="alert">
          {error}
        </div>
      )}
      <div className="rc-ie__canvas">
        <Suspense
          fallback={
            <div className="rc-ie__loading">
              <Icon name="image" size={24} /> Loading editor…
            </div>
          }
        >
          <StyleSheetManager shouldForwardProp={(prop, target) => typeof target !== "string" || isPropValid(prop)}>
            <FilerobotImageEditor {...config} />
          </StyleSheetManager>
        </Suspense>
      </div>
      <style>{css}</style>
    </div>
  );
}

const css = `
.rc-ie { position: fixed; inset: 0; z-index: 90; display: flex; flex-direction: column; background: var(--bg); color: var(--text); padding-top: env(safe-area-inset-top, 0px); }
.rc-ie__top { min-height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
.rc-ie__title { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.rc-ie__title strong { font: 650 14px/1.2 "Space Grotesk", sans-serif; }
.rc-ie__title span { max-width: 52vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font: 11px/1.2 "JetBrains Mono", monospace; }
.rc-ie__quick { display: flex; gap: 8px; }
.rc-ie__quick button { min-height: 44px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--surface-2); color: var(--text); font: 600 12px/1 "JetBrains Mono", monospace; cursor: pointer; }
.rc-ie__quick button:last-child { border-color: color-mix(in srgb, var(--coral) 55%, var(--border)); color: var(--coral); }
.rc-ie__error { padding: 9px 12px; background: color-mix(in srgb, var(--warn) 14%, var(--surface)); color: var(--warn); font-size: 12px; }
.rc-ie__canvas { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.rc-ie__canvas > div, .rc-ie__canvas .FIE_root { height: 100%; }
.rc-ie__loading { height: 100%; display: grid; place-items: center; gap: 10px; color: var(--text-faint); }
.rc-ie .FIE_root { --font-family: Inter, sans-serif; }
.rc-ie .FIE_flip-x-tool-button,
.rc-ie .FIE_flip-y-tool-button,
.rc-ie .FIE_hsv-tool-button,
.rc-ie .FIE_blur-tool-button,
.rc-ie .FIE_warmth-tool-button,
.rc-ie .FIE_image-tool-button,
.rc-ie .FIE_polygon-tool-button,
.rc-ie .FIE_line-tool-button { display: none !important; }
@media (min-width: 768px) {
  .rc-ie { inset: 6vh max(24px, calc((100vw - 1100px) / 2)); border: 1px solid var(--border-strong); border-radius: 14px; overflow: hidden; box-shadow: 0 30px 90px rgba(0,0,0,.65); padding-top: 0; }
}
@media (max-width: 560px) {
  .rc-ie__top { align-items: flex-start; }
  .rc-ie__quick button { padding: 0 9px; font-size: 11px; }
  .rc-ie__title span { max-width: 38vw; }
}
`;
