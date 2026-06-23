import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { validateImage, fileToBase64 } from "./image-util";
import { matchSlash } from "./slash";
import type { OutboundFrame } from "../types/server";

export interface ComposerProps {
  onSend: (frame: OutboundFrame) => void;
  onUploadFile: (file: File) => Promise<void>;
  disabled?: boolean;
}

interface PendingImage {
  id: string;
  mediaType: string;
  dataBase64: string;
  name: string;
}

export function Composer({ onSend, onUploadFile, disabled }: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | undefined>();
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const slashMatches = matchSlash(text);
  const canSend = (text.trim().length > 0 || images.length > 0) && !disabled;

  function send() {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    const frame: OutboundFrame =
      images.length > 0
        ? {
            type: "user",
            text: trimmed || undefined,
            images: images.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64 })),
          }
        : { type: "user", text: trimmed };
    onSend(frame);
    setText("");
    setImages([]);
    setError(undefined);
  }

  async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const err = validateImage(file);
    if (err) {
      setError(err);
      return;
    }
    try {
      const dataBase64 = await fileToBase64(file);
      const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setImages((prev) => [...prev, { id, mediaType: file.type, dataBase64, name: file.name }]);
      setError(undefined);
    } catch (readErr) {
      setError(readErr instanceof Error ? readErr.message : "failed to read image");
    }
  }

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await onUploadFile(file);
      setError(undefined);
    } catch (uploadErr) {
      setError(uploadErr instanceof Error ? uploadErr.message : "upload failed");
    }
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        padding: "var(--sp-3)",
        background: "var(--surface)",
        display: "grid",
        gap: "var(--sp-2)",
      }}
    >
      {error && (
        <div role="alert" style={{ color: "var(--err)", fontSize: "var(--fs-sm)" }}>
          {error}
        </div>
      )}
      {slashMatches.length > 0 && (
        <div
          style={{
            display: "grid",
            gap: "var(--sp-1)",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: "var(--sp-2)",
          }}
        >
          {slashMatches.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => setText(c.name + " ")}
              style={{
                textAlign: "left",
                background: "transparent",
                border: "none",
                color: "var(--text)",
                cursor: "pointer",
                minHeight: 32,
                display: "flex",
                gap: "var(--sp-2)",
              }}
            >
              <Mono>{c.name}</Mono>
              <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>{c.hint}</span>
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
          {images.map((img) => (
            <span
              key={img.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--sp-1)",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                padding: "2px var(--sp-2)",
              }}
            >
              <img
                src={`data:${img.mediaType};base64,${img.dataBase64}`}
                alt=""
                style={{
                  width: 40,
                  height: 40,
                  objectFit: "cover",
                  borderRadius: "var(--radius-sm)",
                  flexShrink: 0,
                }}
              />
              <Mono muted>{img.name}</Mono>
              <button
                type="button"
                aria-label={`Remove ${img.name}`}
                onClick={() => setImages((p) => p.filter((x) => x.id !== img.id))}
                style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer" }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-end" }}>
        <textarea
          aria-label="Message claude"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="Message claude…"
          style={{
            flex: 1,
            minHeight: "var(--tap-min)",
            resize: "vertical",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text)",
            padding: "var(--sp-2) var(--sp-3)",
            font: "inherit",
          }}
        />
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onPickImage}
          style={{ display: "none" }}
          aria-hidden
          tabIndex={-1}
        />
        <input
          ref={fileInput}
          type="file"
          onChange={onPickFile}
          style={{ display: "none" }}
          aria-hidden
          tabIndex={-1}
        />
        <Button variant="ghost" disabled={disabled} onClick={() => imageInput.current?.click()} aria-label="Add image">
          Image
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={() => fileInput.current?.click()} aria-label="Upload file">
          File
        </Button>
        <Button variant="primary" onClick={send} disabled={!canSend} aria-label="Send">
          Send
        </Button>
      </div>
    </div>
  );
}
