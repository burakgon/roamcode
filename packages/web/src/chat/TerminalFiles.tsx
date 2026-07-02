import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";

/** One exchanged file/image: received FROM claude (send_image/send_file) or uploaded BY the user. */
export interface TermFile {
  id: string;
  name: string;
  path: string;
  isImage: boolean;
  source: "received" | "sent";
  caption?: string;
  /** True while a user upload is in flight (path is empty until it resolves). Drives the progress row. */
  uploading?: boolean;
  /** Upload progress 0..1 while `uploading`. */
  progress?: number;
  /** The upload failed (drives an error tint on the tile). */
  error?: boolean;
}

/** The terminal's Files panel: a bottom sheet (mobile) / right drawer (desktop) listing exchanged files —
 *  thumbnails for images, rows for files — with view-full-size + download, plus Upload (drag/drop too).
 *  Presentational: TerminalView owns the list + the upload/download wiring. */
export function TerminalFiles({
  files,
  open,
  onClose,
  onUpload,
  downloadUrl,
}: {
  files: TermFile[];
  open: boolean;
  onClose: () => void;
  onUpload: (files: FileList) => void;
  downloadUrl: (path: string) => string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [lightbox, setLightbox] = useState<string | undefined>();

  // "Unseen" badge for newly-received files: a file is NEW until the panel has been opened AND closed with it
  // present. `seenRef` accumulates ids marked seen on each close; badges are computed against it at render (so
  // they persist for the whole open session, then clear on the next open — no flash). Refs, not state, so a
  // background file arrival doesn't churn the closed panel.
  const seenRef = useRef<Set<string>>(new Set());
  const filesRef = useRef(files);
  filesRef.current = files;
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      for (const f of filesRef.current) seenRef.current.add(f.id);
    }
    prevOpenRef.current = open;
  }, [open]);

  // Per-file Share (feature-detected): the Web Share API with file support. Shares the file's BYTES (fetched
  // from the token-bearing download URL) — never the URL itself, so the access token never leaks into a share
  // sheet. Hidden entirely where the API is absent (e.g. desktop Chrome/Firefox).
  const canShare =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function";
  const shareFile = async (f: TermFile) => {
    try {
      const res = await fetch(downloadUrl(f.path));
      const blob = await res.blob();
      const file = new File([blob], f.name, { type: blob.type || "application/octet-stream" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: f.name });
      } else {
        await navigator.share({ title: f.name, text: f.name });
      }
    } catch {
      /* user cancelled, or this content can't be shared — nothing to do */
    }
  };

  // Make the fullscreen image preview dismissible the ways users actually reach for — the previous version
  // opened fullscreen with no obvious way out ("geri yok"). While it's open: Escape closes it, AND the
  // Android / browser BACK gesture closes it instead of leaving the app (we push a throwaway history entry
  // on open; a real back press fires popstate → close; closing any other way pops our entry back off).
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setLightbox(undefined);
      }
    };
    const onPop = () => setLightbox(undefined);
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    window.history.pushState({ rcLightbox: true }, "");
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      // Closed via the X / a tap / Escape (not a real back press): our pushed entry is still on top, so pop
      // it so the back button isn't left "swallowing" a press to close an already-closed viewer.
      if ((window.history.state as { rcLightbox?: boolean } | null)?.rcLightbox) window.history.back();
    };
  }, [lightbox]);

  if (!open) return null;
  return (
    <div className="rc-tf" role="dialog" aria-modal="true" aria-label="Terminal files">
      <button type="button" className="rc-tf__scrim" aria-label="Close files" onClick={onClose} />
      <div className="rc-tf__panel">
        <div className="rc-tf__head">
          <strong>Files</strong>
          <button type="button" className="rc-tf__x" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div
          className={dragging ? "rc-tf__body is-dragging" : "rc-tf__body"}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) onUpload(e.dataTransfer.files);
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length) onUpload(e.clipboardData.files);
          }}
        >
          {files.length === 0 && (
            <div className="rc-tf__empty">No files yet. Upload one, or ask claude to send you a file.</div>
          )}
          <div className="rc-tf__grid">
            {files.map((f) => {
              const isNew = f.source === "received" && !seenRef.current.has(f.id);
              return (
                <div key={f.id} className="rc-tf__item" title={f.name}>
                  {f.uploading ? (
                    // In-flight upload: a placeholder tile with a determinate progress bar (no path yet).
                    <div className="rc-tf__thumb rc-tf__uploading" aria-label={`Uploading ${f.name}`}>
                      <Icon name={f.isImage ? "image" : "file"} size={22} />
                      <div className="rc-tf__bar">
                        <span className="rc-tf__barfill" style={{ width: `${Math.round((f.progress ?? 0) * 100)}%` }} />
                      </div>
                    </div>
                  ) : f.isImage ? (
                    <button type="button" className="rc-tf__thumb" onClick={() => setLightbox(downloadUrl(f.path))}>
                      <img src={downloadUrl(f.path)} alt={f.name} loading="lazy" />
                      {isNew && <span className="rc-tf__new" aria-hidden />}
                    </button>
                  ) : (
                    <a
                      className={f.error ? "rc-tf__file rc-tf__file--err" : "rc-tf__file"}
                      href={downloadUrl(f.path)}
                      target="_blank"
                      rel="noreferrer"
                      download
                    >
                      <Icon name="file" size={22} />
                      {isNew && <span className="rc-tf__new" aria-hidden />}
                    </a>
                  )}
                  <div className="rc-tf__name">
                    {f.source === "sent" ? "↑ " : "↓ "}
                    {f.name}
                  </div>
                  {f.caption ? <div className="rc-tf__caption">{f.caption}</div> : null}
                  {f.source === "received" && !f.uploading && canShare && (
                    <button
                      type="button"
                      className="rc-tf__share"
                      aria-label={`Share ${f.name}`}
                      onClick={() => void shareFile(f)}
                    >
                      <Icon name="send" size={13} /> Share
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="rc-tf__foot">
          <input
            ref={inputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) onUpload(e.target.files);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
          <button type="button" className="rc-tf__upload" onClick={() => inputRef.current?.click()}>
            <Icon name="paperclip" size={16} /> Upload
          </button>
          <span className="rc-tf__hint">drag &amp; drop / paste too</span>
        </div>
      </div>
      {lightbox && (
        // Tap anywhere (backdrop or image) closes; the explicit X is the obvious, always-visible way out.
        <div
          className="rc-tf__lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => setLightbox(undefined)}
        >
          <button
            type="button"
            className="rc-tf__lightbox-close"
            aria-label="Close image"
            onClick={() => setLightbox(undefined)}
          >
            <Icon name="x" size={22} />
          </button>
          <img src={lightbox} alt="" />
        </div>
      )}
      <style>{css}</style>
    </div>
  );
}

const css = `
.rc-tf { position: absolute; inset: 0; z-index: 20; }
.rc-tf__scrim { position: absolute; inset: 0; border: none; background: rgba(0,0,0,0.45); cursor: pointer; }
.rc-tf__panel {
  position: absolute; left: 0; right: 0; bottom: 0; max-height: 82%;
  display: flex; flex-direction: column;
  background: var(--surface); border-top: 1px solid var(--border-strong);
  border-top-left-radius: 14px; border-top-right-radius: 14px;
  box-shadow: 0 -12px 40px rgba(0,0,0,0.5);
  animation: rc-tf-in 200ms cubic-bezier(0.16,1,0.3,1);
}
@keyframes rc-tf-in { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.rc-tf__head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border); color: var(--text); font: 600 14px/1 "JetBrains Mono", ui-monospace, monospace; }
.rc-tf__x { width: 34px; height: 34px; display: grid; place-items: center; background: transparent; border: none; color: var(--text-faint); cursor: pointer; border-radius: 8px; }
.rc-tf__x:hover { color: var(--text); background: var(--surface-2); }
.rc-tf__body { flex: 1 1 auto; overflow-y: auto; padding: 12px 14px; min-height: 90px; }
.rc-tf__body.is-dragging { outline: 2px dashed var(--coral); outline-offset: -6px; }
.rc-tf__empty { color: var(--text-faint); font-size: 13px; text-align: center; padding: 20px 8px; }
.rc-tf__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
.rc-tf__item { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rc-tf__thumb, .rc-tf__file {
  display: grid; place-items: center; height: 76px; padding: 0; overflow: hidden;
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: 8px; cursor: pointer; color: var(--coral);
}
.rc-tf__thumb img { width: 100%; height: 100%; object-fit: cover; }
.rc-tf__thumb, .rc-tf__file { position: relative; }
.rc-tf__file--err { border-color: var(--warn); color: var(--warn); }
/* "New / unseen" pip on a freshly-received file, until the panel is opened + closed with it present. */
.rc-tf__new {
  position: absolute; top: 5px; right: 5px; width: 9px; height: 9px; border-radius: 999px;
  background: var(--coral); border: 2px solid var(--surface); box-shadow: 0 0 0 1px rgba(0,0,0,0.35);
}
/* In-flight upload tile: a dimmed icon over a slim determinate progress bar pinned to the bottom edge. */
.rc-tf__uploading { flex-direction: column; gap: 8px; color: var(--text-faint); }
.rc-tf__bar { position: absolute; left: 8px; right: 8px; bottom: 8px; height: 4px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.rc-tf__barfill { display: block; height: 100%; background: var(--coral); border-radius: 999px; transition: width 120ms linear; }
/* Per-file Share (received files, where the Web Share API exists). */
.rc-tf__share {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  min-height: 26px; padding: 0 8px; border-radius: 7px; cursor: pointer;
  background: var(--surface-2); border: 1px solid var(--border-strong); color: var(--text-muted);
  font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  touch-action: manipulation;
}
.rc-tf__share:active { background: var(--surface-3); color: var(--text); }
.rc-tf__name { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; }
/* Caption claude attached when it sent the file (e.g. "here's the chart") — captured but never shown before. */
.rc-tf__caption { font-size: 11px; color: var(--text); margin-top: 2px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.rc-tf__foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--border); }
.rc-tf__upload { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 14px; border-radius: 9px; background: var(--coral); color: var(--on-accent); border: none; cursor: pointer; font: 600 13px/1 ui-monospace, monospace; }
.rc-tf__hint { font-size: 11px; color: var(--text-faint); }
.rc-tf__lightbox { position: absolute; inset: 0; z-index: 21; background: rgba(0,0,0,0.92); display: grid; place-items: center; cursor: zoom-out; padding: 16px; padding-top: calc(16px + env(safe-area-inset-top, 0px)); }
.rc-tf__lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; }
.rc-tf__lightbox-close {
  position: absolute; top: calc(10px + env(safe-area-inset-top, 0px)); right: 10px;
  width: 40px; height: 40px; display: grid; place-items: center;
  background: rgba(255,255,255,0.14); border: none; color: #fff; cursor: pointer;
  border-radius: 999px; z-index: 22; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.rc-tf__lightbox-close:hover { background: rgba(255,255,255,0.24); }
@media (min-width: 768px) {
  .rc-tf__panel { left: auto; top: 0; bottom: 0; width: 380px; max-height: none; border-radius: 0; border-top: none; border-left: 1px solid var(--border-strong); box-shadow: -12px 0 40px rgba(0,0,0,0.5); animation: none; }
}
`;
