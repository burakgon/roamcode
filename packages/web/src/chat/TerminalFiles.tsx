import { useRef, useState } from "react";
import { Icon } from "../ui/Icon";

/** One exchanged file/image: received FROM claude (send_image/send_file) or uploaded BY the user. */
export interface TermFile {
  id: string;
  name: string;
  path: string;
  isImage: boolean;
  source: "received" | "sent";
  caption?: string;
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
          {files.length === 0 && <div className="rc-tf__empty">No files yet. Upload one, or ask claude to send you a file.</div>}
          <div className="rc-tf__grid">
            {files.map((f) => (
              <div key={f.id} className="rc-tf__item" title={f.name}>
                {f.isImage ? (
                  <button type="button" className="rc-tf__thumb" onClick={() => setLightbox(downloadUrl(f.path))}>
                    <img src={downloadUrl(f.path)} alt={f.name} loading="lazy" />
                  </button>
                ) : (
                  <a className="rc-tf__file" href={downloadUrl(f.path)} target="_blank" rel="noreferrer" download>
                    <Icon name="file" size={22} />
                  </a>
                )}
                <div className="rc-tf__name">
                  {f.source === "sent" ? "↑ " : "↓ "}
                  {f.name}
                </div>
              </div>
            ))}
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
        <button type="button" className="rc-tf__lightbox" aria-label="Close image" onClick={() => setLightbox(undefined)}>
          <img src={lightbox} alt="" />
        </button>
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
  background: #11151c; border-top: 1px solid #2a3340;
  border-top-left-radius: 14px; border-top-right-radius: 14px;
  box-shadow: 0 -12px 40px rgba(0,0,0,0.5);
  animation: rc-tf-in 200ms cubic-bezier(0.16,1,0.3,1);
}
@keyframes rc-tf-in { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.rc-tf__head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #1e2530; color: #cdd6e4; font: 600 14px/1 "JetBrains Mono", ui-monospace, monospace; }
.rc-tf__x { width: 34px; height: 34px; display: grid; place-items: center; background: transparent; border: none; color: #5c6370; cursor: pointer; border-radius: 8px; }
.rc-tf__x:hover { color: #cdd6e4; background: #1b2230; }
.rc-tf__body { flex: 1 1 auto; overflow-y: auto; padding: 12px 14px; min-height: 90px; }
.rc-tf__body.is-dragging { outline: 2px dashed #61afef; outline-offset: -6px; }
.rc-tf__empty { color: #5c6370; font-size: 13px; text-align: center; padding: 20px 8px; }
.rc-tf__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
.rc-tf__item { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rc-tf__thumb, .rc-tf__file {
  display: grid; place-items: center; height: 76px; padding: 0; overflow: hidden;
  background: #0b0e14; border: 1px solid #2a3340; border-radius: 8px; cursor: pointer; color: #61afef;
}
.rc-tf__thumb img { width: 100%; height: 100%; object-fit: cover; }
.rc-tf__name { font-size: 11px; color: #8b93a1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; }
.rc-tf__foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid #1e2530; }
.rc-tf__upload { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 14px; border-radius: 9px; background: #3b82f6; color: #fff; border: none; cursor: pointer; font: 600 13px/1 ui-monospace, monospace; }
.rc-tf__hint { font-size: 11px; color: #5c6370; }
.rc-tf__lightbox { position: absolute; inset: 0; z-index: 21; border: none; background: rgba(0,0,0,0.9); display: grid; place-items: center; cursor: zoom-out; padding: 16px; }
.rc-tf__lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; }
@media (min-width: 768px) {
  .rc-tf__panel { left: auto; top: 0; bottom: 0; width: 380px; max-height: none; border-radius: 0; border-top: none; border-left: 1px solid #2a3340; box-shadow: -12px 0 40px rgba(0,0,0,0.5); animation: none; }
}
`;
