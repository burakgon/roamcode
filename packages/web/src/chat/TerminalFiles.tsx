import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";

export interface TermFile {
  id: string;
  name: string;
  path: string;
  isImage: boolean;
  source: "received" | "sent";
  storage?: "managed" | "workspace";
  mimeType?: string;
  size?: number;
  kind?: "image" | "pdf" | "text" | "binary";
  caption?: string;
  createdAt?: number;
  updatedAt?: number;
  expiresAt?: number;
  derivedFromId?: string;
  available?: boolean;
  uploading?: boolean;
  progress?: number;
  error?: boolean;
  errorMessage?: string;
  /** Browser-only retry payload; never persisted or rendered. */
  localFile?: File;
}

function formatBytes(value?: number): string {
  if (!value || value < 1) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1_048_576).toFixed(value < 10_485_760 ? 1 : 0)} MB`;
}

function formatWhen(value?: number): string {
  if (!value) return "";
  const elapsed = Date.now() - value;
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TerminalFiles({
  files,
  open,
  unreadReceived = 0,
  onClose,
  onUpload,
  contentUrl,
  downloadUrl,
  onAddToPrompt,
  onEdit,
  onRetry,
  onCancel,
  onHide,
  onRestore,
  onDelete,
  onMarkReceivedSeen,
}: {
  files: TermFile[];
  open: boolean;
  unreadReceived?: number;
  onClose: () => void;
  onUpload: (files: FileList) => void;
  contentUrl?: (file: TermFile, disposition?: "inline" | "attachment") => string;
  /** Legacy screenshot/test adapter. */
  downloadUrl?: (path: string) => string;
  onAddToPrompt?: (file: TermFile) => void;
  onEdit?: (file: TermFile) => void;
  onRetry?: (file: TermFile) => void;
  onCancel?: (file: TermFile) => void;
  onHide?: (file: TermFile) => void;
  onRestore?: (file: TermFile) => void;
  onDelete?: (file: TermFile) => void;
  onMarkReceivedSeen?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"received" | "sent">("received");
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<TermFile>();
  const [previewText, setPreviewText] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [undo, setUndo] = useState<TermFile>();
  useFocusTrap(panelRef, open);

  const urlFor = useCallback(
    (file: TermFile, disposition: "inline" | "attachment" = "inline") =>
      contentUrl?.(file, disposition) ?? downloadUrl?.(file.path) ?? "#",
    [contentUrl, downloadUrl],
  );
  const received = useMemo(() => files.filter((file) => file.source === "received"), [files]);
  const sent = useMemo(() => files.filter((file) => file.source === "sent"), [files]);
  const visible = tab === "received" ? received : sent;

  useEffect(() => {
    if (open && sent.some((file) => file.uploading || file.error)) setTab("sent");
  }, [open, sent]);

  useEffect(() => {
    if (open && tab === "received") onMarkReceivedSeen?.();
  }, [open, tab, received.length, onMarkReceivedSeen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (preview) setPreview(undefined);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, preview, onClose]);

  useEffect(() => {
    if (!preview) return;
    const onPopState = () => setPreview(undefined);
    window.addEventListener("popstate", onPopState);
    window.history.pushState({ rcFilePreview: true }, "");
    return () => {
      window.removeEventListener("popstate", onPopState);
      if ((window.history.state as { rcFilePreview?: boolean } | null)?.rcFilePreview) window.history.back();
    };
  }, [preview]);

  useEffect(() => {
    setPreviewText(undefined);
    if (!preview || preview.kind !== "text") return;
    const controller = new AbortController();
    void fetch(urlFor(preview), { headers: { Range: "bytes=0-1048575" }, signal: controller.signal })
      .then((response) => {
        if (!response.ok && response.status !== 206) throw new Error("Preview failed");
        return response.text();
      })
      .then((text) => setPreviewText(text))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setPreviewText("This file could not be previewed.");
      });
    return () => controller.abort();
  }, [preview, urlFor]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(undefined), 5_000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  if (!open) return null;

  const share = async (file: TermFile) => {
    setStatus(`Preparing ${file.name}…`);
    try {
      const response = await fetch(urlFor(file));
      if (!response.ok) throw new Error("Download failed");
      const blob = await response.blob();
      const shareFile = new File([blob], file.name, { type: blob.type || file.mimeType || "application/octet-stream" });
      if (navigator.share && navigator.canShare?.({ files: [shareFile] })) {
        await navigator.share({ files: [shareFile], title: file.name });
        setStatus(undefined);
      } else {
        const anchor = document.createElement("a");
        anchor.href = URL.createObjectURL(blob);
        anchor.download = file.name;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(anchor.href), 1_000);
        setStatus(`Downloaded ${file.name}`);
      }
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") setStatus(undefined);
      else setStatus(`Couldn't share ${file.name}`);
    }
  };

  const hideFile = (file: TermFile) => {
    onHide?.(file);
    setUndo(file);
  };

  return (
    <div className="rc-tf" role="dialog" aria-modal="true" aria-label="Terminal files">
      <button type="button" className="rc-tf__scrim" aria-label="Close files" onClick={onClose} />
      <div className="rc-tf__panel" ref={panelRef}>
        <div className="rc-tf__head">
          <div>
            <strong>Files</strong>
            <span>Available for 7 days</span>
          </div>
          <button type="button" className="rc-tf__iconbtn" aria-label="Close files" onClick={onClose}>
            <Icon name="x" size={19} />
          </button>
        </div>
        <div className="rc-tf__tabs" role="tablist" aria-label="File direction">
          <button type="button" role="tab" aria-selected={tab === "received"} onClick={() => setTab("received")}>
            Received <span>{received.length}</span>
            {unreadReceived > 0 && <i>{unreadReceived}</i>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "sent"} onClick={() => setTab("sent")}>
            Sent <span>{sent.length}</span>
          </button>
        </div>
        <div
          className={`rc-tf__body${dragging ? " is-dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer.files.length) onUpload(event.dataTransfer.files);
          }}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              onUpload(event.clipboardData.files);
            }
          }}
        >
          {visible.length === 0 ? (
            <div className="rc-tf__empty">
              <Icon name={tab === "received" ? "download" : "paperclip"} size={24} />
              <strong>{tab === "received" ? "No received files yet" : "No sent files yet"}</strong>
              <span>
                {tab === "received"
                  ? "Files from the agent will appear here."
                  : "Add a file to place its path in the prompt."}
              </span>
            </div>
          ) : (
            <div className="rc-tf__list">
              {visible.map((file) => {
                const pct = Math.round((file.progress ?? 0) * 100);
                const previewable = file.isImage || file.kind === "pdf" || file.kind === "text";
                return (
                  <article
                    key={file.id}
                    className={`rc-tf__row${file.error ? " is-error" : ""}${file.available === false ? " is-missing" : ""}`}
                  >
                    <button
                      type="button"
                      className="rc-tf__thumb"
                      disabled={file.uploading || file.error || file.available === false || !previewable}
                      aria-label={file.name}
                      onClick={() => setPreview(file)}
                    >
                      {file.isImage && !file.uploading && !file.error ? (
                        <img src={urlFor(file)} alt="" loading="lazy" />
                      ) : (
                        <Icon name={file.isImage ? "image" : "file"} size={22} />
                      )}
                    </button>
                    <div className="rc-tf__info">
                      <div className="rc-tf__filename" title={file.name}>
                        {file.name}
                      </div>
                      <div className="rc-tf__meta">
                        <span>{file.source === "sent" ? "Sent" : "Received"}</span>
                        {file.size ? <span>{formatBytes(file.size)}</span> : null}
                        {file.createdAt ? <span>{formatWhen(file.createdAt)}</span> : null}
                      </div>
                      {file.caption && <div className="rc-tf__caption">{file.caption}</div>}
                      {file.uploading && (
                        <div
                          className="rc-tf__progress"
                          role="progressbar"
                          aria-label={`Uploading ${file.name}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={pct}
                        >
                          <span>
                            <i style={{ width: `${pct}%` }} />
                          </span>
                          <b>{pct}%</b>
                        </div>
                      )}
                      {file.error && (
                        <div className="rc-tf__rowerror" role="alert">
                          {file.errorMessage || "Upload failed"}
                        </div>
                      )}
                      {file.available === false && <div className="rc-tf__rowerror">File is no longer available</div>}
                    </div>
                    <div className="rc-tf__actions">
                      {file.uploading ? (
                        <button type="button" onClick={() => onCancel?.(file)}>
                          Cancel
                        </button>
                      ) : file.error ? (
                        <button type="button" onClick={() => onRetry?.(file)}>
                          <Icon name="history" size={14} /> Retry
                        </button>
                      ) : (
                        <>
                          {file.isImage && file.available !== false && (
                            <button type="button" onClick={() => onEdit?.(file)}>
                              <Icon name="sliders" size={14} /> Edit
                            </button>
                          )}
                          {file.available !== false && (
                            <button type="button" onClick={() => onAddToPrompt?.(file)}>
                              <Icon name="arrow-up" size={14} /> Prompt
                            </button>
                          )}
                          {file.available !== false && (
                            <button type="button" onClick={() => void share(file)}>
                              <Icon name="download" size={14} /> Share
                            </button>
                          )}
                          <button type="button" onClick={() => hideFile(file)}>
                            Remove
                          </button>
                          {file.source === "sent" && file.storage === "managed" && (
                            <button
                              type="button"
                              className="is-danger"
                              onClick={() => {
                                if (window.confirm(`Permanently delete ${file.name}?`)) onDelete?.(file);
                              }}
                            >
                              Delete
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <div className="rc-tf__foot">
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files?.length) onUpload(event.target.files);
              event.target.value = "";
            }}
          />
          <button type="button" className="rc-tf__upload" onClick={() => inputRef.current?.click()}>
            <Icon name="paperclip" size={17} /> Add files
          </button>
          <span>Drop or paste files anywhere</span>
        </div>
      </div>
      {preview && (
        <div className="rc-tf__preview" role="dialog" aria-modal="true" aria-label="Image preview">
          <div className="rc-tf__previewhead">
            <div>
              <strong>{preview.name}</strong>
              <span>{formatBytes(preview.size)}</span>
            </div>
            <button type="button" onClick={() => onEdit?.(preview)} disabled={!preview.isImage}>
              <Icon name="sliders" size={17} /> Edit
            </button>
            <a href={urlFor(preview, "attachment")} download={preview.name}>
              <Icon name="download" size={17} /> Download
            </a>
            <button type="button" aria-label="Close image" onClick={() => setPreview(undefined)}>
              <Icon name="x" size={19} />
            </button>
          </div>
          <div className="rc-tf__previewbody">
            {preview.isImage ? (
              <img src={urlFor(preview)} alt={preview.name} />
            ) : preview.kind === "pdf" ? (
              <iframe src={urlFor(preview)} title={preview.name} />
            ) : (
              <pre>{previewText ?? "Loading preview…"}</pre>
            )}
          </div>
        </div>
      )}
      {undo && (
        <div className="rc-tf__toast" role="status">
          Removed {undo.name}
          <button
            type="button"
            onClick={() => {
              onRestore?.(undo);
              setUndo(undefined);
            }}
          >
            Undo
          </button>
        </div>
      )}
      {status && (
        <button type="button" className="rc-tf__toast" role="status" onClick={() => setStatus(undefined)}>
          {status}
        </button>
      )}
      <style>{css}</style>
    </div>
  );
}

const css = `
.rc-tf { position: absolute; inset: 0; z-index: 20; }
.rc-tf__scrim { position: absolute; inset: 0; border: 0; background: rgba(0,0,0,.52); }
.rc-tf__panel { position: absolute; inset: auto 0 0; max-height: min(92dvh, 820px); display: flex; flex-direction: column; overflow: hidden; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 16px 16px 0 0; box-shadow: 0 -18px 54px rgba(0,0,0,.58); }
.rc-tf__head { min-height: 62px; display: flex; align-items: center; justify-content: space-between; padding: 8px 12px 8px 16px; border-bottom: 1px solid var(--border); }
.rc-tf__head > div { display: flex; flex-direction: column; gap: 4px; }
.rc-tf__head strong { color: var(--text); font: 650 16px/1 "Space Grotesk", sans-serif; }
.rc-tf__head span { color: var(--text-faint); font: 10px/1 "JetBrains Mono", monospace; }
.rc-tf__iconbtn { width: 44px; height: 44px; display: grid; place-items: center; border: 0; border-radius: 10px; background: transparent; color: var(--text-muted); }
.rc-tf__tabs { display: grid; grid-template-columns: 1fr 1fr; padding: 8px 12px 0; gap: 6px; border-bottom: 1px solid var(--border); }
.rc-tf__tabs button { position: relative; min-height: 44px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-faint); font: 650 12px/1 "JetBrains Mono", monospace; }
.rc-tf__tabs button[aria-selected=true] { color: var(--text); border-bottom-color: var(--coral); }
.rc-tf__tabs span { margin-left: 5px; opacity: .72; }
.rc-tf__tabs i { display: inline-grid; place-items: center; min-width: 18px; height: 18px; margin-left: 6px; border-radius: 9px; background: var(--coral); color: var(--on-accent); font-style: normal; font-size: 10px; }
.rc-tf__body { min-height: 180px; flex: 1 1 auto; overflow: auto; padding: 10px 12px; }
.rc-tf__body.is-dragging { outline: 2px dashed var(--coral); outline-offset: -7px; background: color-mix(in srgb, var(--coral) 5%, transparent); }
.rc-tf__empty { min-height: 210px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; text-align: center; color: var(--text-faint); }
.rc-tf__empty strong { color: var(--text-muted); font-size: 13px; }.rc-tf__empty span { max-width: 280px; font-size: 12px; }
.rc-tf__list { display: flex; flex-direction: column; gap: 8px; }
.rc-tf__row { display: grid; grid-template-columns: 56px minmax(0,1fr); gap: 10px; padding: 9px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); }
.rc-tf__row.is-error { border-color: color-mix(in srgb, var(--warn) 55%, var(--border)); }.rc-tf__row.is-missing { opacity: .62; }
.rc-tf__thumb { width: 56px; height: 56px; display: grid; place-items: center; overflow: hidden; padding: 0; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface); color: var(--coral); }
.rc-tf__thumb img { width: 100%; height: 100%; object-fit: cover; }.rc-tf__thumb:disabled { cursor: default; }
.rc-tf__info { min-width: 0; align-self: center; }.rc-tf__filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font: 600 12px/1.35 "JetBrains Mono", monospace; }
.rc-tf__meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 5px; color: var(--text-faint); font: 10px/1.2 "JetBrains Mono", monospace; }.rc-tf__meta span + span:before { content: '·'; margin-right: 8px; }
.rc-tf__caption { margin-top: 6px; color: var(--text-muted); font-size: 11px; line-height: 1.35; }.rc-tf__rowerror { margin-top: 6px; color: var(--warn); font-size: 11px; }
.rc-tf__progress { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; margin-top: 8px; }.rc-tf__progress > span { height: 5px; overflow: hidden; border-radius: 3px; background: var(--surface-3); }.rc-tf__progress i { display: block; height: 100%; background: var(--coral); }.rc-tf__progress b { color: var(--text-muted); font: 10px/1 "JetBrains Mono", monospace; }
.rc-tf__actions { grid-column: 1/-1; display: flex; gap: 6px; overflow-x: auto; padding-top: 2px; }.rc-tf__actions button { flex: 0 0 auto; min-height: 44px; display: inline-flex; align-items: center; gap: 5px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text-muted); font: 600 10px/1 "JetBrains Mono", monospace; }.rc-tf__actions .is-danger { color: var(--warn); }
.rc-tf__foot { display: flex; align-items: center; gap: 12px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom,0px)); border-top: 1px solid var(--border); }.rc-tf__upload { min-height: 46px; display: inline-flex; align-items: center; gap: 7px; padding: 0 16px; border: 0; border-radius: 10px; background: var(--coral); color: var(--on-accent); font: 700 12px/1 "JetBrains Mono", monospace; }.rc-tf__foot > span { color: var(--text-faint); font-size: 11px; }
.rc-tf__preview { position: absolute; inset: 0; z-index: 23; display: flex; flex-direction: column; background: rgba(4,4,5,.98); }.rc-tf__previewhead { min-height: 62px; display: flex; align-items: center; gap: 7px; padding: calc(8px + env(safe-area-inset-top,0px)) 10px 8px; border-bottom: 1px solid rgba(255,255,255,.12); }.rc-tf__previewhead > div { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }.rc-tf__previewhead strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fff; font: 600 12px/1.2 "JetBrains Mono", monospace; }.rc-tf__previewhead span { color: #999; font-size: 10px; }.rc-tf__previewhead button,.rc-tf__previewhead a { min-height: 44px; display: inline-flex; align-items: center; gap: 5px; padding: 0 10px; border: 0; border-radius: 9px; background: rgba(255,255,255,.12); color: #fff; text-decoration: none; font-size: 11px; }.rc-tf__previewhead button:last-child { width: 44px; padding: 0; justify-content: center; }
.rc-tf__previewbody { flex: 1; min-height: 0; display: grid; place-items: center; overflow: auto; padding: 12px; }.rc-tf__previewbody img { max-width: 100%; max-height: 100%; object-fit: contain; }.rc-tf__previewbody iframe { width: 100%; height: 100%; border: 0; background: white; }.rc-tf__previewbody pre { width: min(920px,100%); min-height: 100%; margin: 0; color: #d8d8de; font: 12px/1.55 "JetBrains Mono", monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.rc-tf__toast { position: absolute; left: 50%; bottom: calc(76px + env(safe-area-inset-bottom,0px)); z-index: 25; transform: translateX(-50%); max-width: calc(100% - 24px); display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface-3); color: var(--text); box-shadow: 0 10px 30px rgba(0,0,0,.45); font-size: 11px; white-space: nowrap; }.rc-tf__toast button { border: 0; background: transparent; color: var(--coral); font-weight: 700; }
@media (min-width: 768px) { .rc-tf__panel { inset: 0 0 0 auto; width: clamp(440px,34vw,520px); max-height: none; border-radius: 0; }.rc-tf__row { grid-template-columns: 64px minmax(0,1fr); }.rc-tf__thumb { width: 64px; height: 64px; }.rc-tf__actions { grid-column: 2; }.rc-tf__preview { left: auto; width: min(100%,900px); box-shadow: -20px 0 60px rgba(0,0,0,.55); } }
@media (hover:hover) { .rc-tf button:hover,.rc-tf a:hover { filter: brightness(1.14); } }
@media (prefers-reduced-motion:no-preference) and (max-width:767px) { .rc-tf__panel { animation: rc-tf-in .18s ease-out; } @keyframes rc-tf-in { from { transform:translateY(18px); opacity:.7; } } }
`;
