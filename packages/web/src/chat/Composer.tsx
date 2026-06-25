import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { validateImage, fileToBase64 } from "./image-util";
import { matchSlash } from "./slash";
import type { SlashCommand } from "./slash";
import type { OutboundFrame } from "../types/server";

export interface PendingImage {
  id: string;
  mediaType: string;
  dataBase64: string;
  name: string;
}

export interface ComposerProps {
  onSend: (frame: OutboundFrame) => void;
  onUploadFile: (file: File) => Promise<void>;
  /** A client-action slash command (e.g. `/resume`) was chosen. The composer clears itself; the host
   * runs the UI action (opening a popup) rather than sending the text to claude. */
  onSlashCommand?: (name: string) => void;
  /**
   * TRUE while a turn is actively running (thinking/streaming/running-tool) — NOT while awaiting a
   * permission/question. When true the primary control becomes a STOP button (in place of Send) that
   * calls {@link onStop}. Idle/awaiting keep the normal Send.
   */
  running?: boolean;
  /** STOP the running turn (interrupt). Called when the Stop button is tapped while `running`. */
  onStop?: () => void;
  disabled?: boolean;
  /**
   * Initial composer contents. Optional and defaulting to empty — production (`ChatView`) never
   * passes these. They exist so a non-interactive preview (the screenshot harness) can show the
   * REAL composer pre-filled with a draft + attached image thumbnail, instead of a hand-drawn mock.
   */
  initialText?: string;
  initialImages?: PendingImage[];
}

// Shared base for the two ghost icon controls (image / file). A real <button> with an aria-label so
// it stays reachable by name (a11y + the existing tests). Tap target ≥ var(--tap-min).
const iconBtn: React.CSSProperties = {
  width: "var(--tap-min)",
  height: "var(--tap-min)",
  flex: "none",
  display: "grid",
  placeItems: "center",
  borderRadius: "var(--radius)",
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  cursor: "pointer",
};

// Hidden file inputs are visually-hidden rather than `display:none`: on iOS Safari (esp. an installed
// PWA) a `display:none` file input can refuse to open its picker on a programmatic `.click()`. This
// keeps the input in the render tree (so the dialog opens) without affecting layout.
const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  border: 0,
};

export function Composer({
  onSend,
  onUploadFile,
  onSlashCommand,
  running,
  onStop,
  disabled,
  initialText,
  initialImages,
}: ComposerProps) {
  const [text, setText] = useState(initialText ?? "");
  const [images, setImages] = useState<PendingImage[]>(initialImages ?? []);
  const [error, setError] = useState<string | undefined>();
  // Local "stopping" latch: tapping Stop reflects immediately (the button disables + relabels) while
  // the interrupt round-trips and the aborted `result` settles the wire back to idle. Reset whenever the
  // session leaves the running state (the turn ended — by the interrupt or on its own).
  const [stopping, setStopping] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  if (!running && stopping) setStopping(false);

  const slashMatches = matchSlash(text);
  const canSend = (text.trim().length > 0 || images.length > 0) && !disabled;

  // Picking a slash command: a CLIENT-ACTION command (e.g. `/resume`) runs a UI action via
  // `onSlashCommand` and clears the input — nothing is sent to claude. A normal claude command just
  // fills the composer with `"<name> "` so the user can finish typing and send it themselves.
  function pickSlash(c: SlashCommand) {
    if (c.clientAction) {
      onSlashCommand?.(c.name);
      setText("");
    } else {
      setText(c.name + " ");
    }
  }

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

  function stop() {
    if (stopping) return; // already requested — don't double-send the interrupt
    setStopping(true);
    onStop?.();
  }

  // Multi-select: validate + read every chosen image, append the valid ones, surface the first error
  // (if any were rejected) without dropping the good ones.
  async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    const added: PendingImage[] = [];
    let firstErr: string | undefined;
    for (const file of files) {
      const err = validateImage(file);
      if (err) {
        if (firstErr === undefined) firstErr = err;
        continue;
      }
      try {
        const dataBase64 = await fileToBase64(file);
        const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        added.push({ id, mediaType: file.type, dataBase64, name: file.name });
      } catch (readErr) {
        if (firstErr === undefined) firstErr = readErr instanceof Error ? readErr.message : "failed to read image";
      }
    }
    if (added.length > 0) setImages((prev) => [...prev, ...added]);
    setError(firstErr);
  }

  // Multi-select: upload each chosen file in turn; stop + surface the error on the first failure.
  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    try {
      for (const file of files) await onUploadFile(file);
      setError(undefined);
    } catch (uploadErr) {
      setError(uploadErr instanceof Error ? uploadErr.message : "upload failed");
    }
  }

  return (
    <div
      className="rc-composer rc-glass"
      style={{
        // Floating liquid-glass composer (spec .composer.glass): the .rc-glass material (translucent
        // warm fill + heavy blur, the 4-layer thickness shadow, the refraction rim + specular sweep).
        // A larger radius reads as a floating bar; Send is the one coral primary affordance.
        margin: "var(--sp-2) var(--sp-3) 0",
        borderRadius: "var(--radius-lg)",
        padding: "var(--sp-3)",
        display: "grid",
        gap: "var(--sp-2)",
      }}
    >
      {/* On mobile the "Sessions" FAB floats over the bottom-right corner. Reserve clearance below
          the controls so the Image/File/Send row is never covered by it (and clears the safe-area
          inset). Removed on desktop, where the FAB is hidden. */}
      <style>{`
        .rc-composer { padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--tap-min) + var(--sp-4)); }
        @media (min-width: 768px) { .rc-composer { padding-bottom: var(--sp-3); } }
        /* Mockup .composer-btn hover — the quiet ghost icon tile warms to accent (color + hairline). */
        .rc-composer-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent-line); }
        /* Mockup .input-row .field:focus-within — the field's hairline lights to accent + a soft glow. */
        .rc-composer textarea:focus-visible, .rc-composer textarea:focus {
          outline: none; border-color: var(--accent-line); box-shadow: var(--focus-glow);
        }
      `}</style>
      {error && (
        <div role="alert" style={{ color: "var(--err)", fontSize: "var(--fs-sm)" }}>
          {error}
        </div>
      )}
      {slashMatches.length > 0 && (
        <div
          style={{
            display: "grid",
            gap: "2px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "var(--sp-1)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          {slashMatches.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => pickSlash(c)}
              style={{
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderRadius: "var(--radius-sm)",
                color: "var(--text)",
                cursor: "pointer",
                minHeight: 36,
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-2)",
                padding: "0 var(--sp-2)",
              }}
            >
              <Mono>{c.name}</Mono>
              <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>{c.hint}</span>
              {/* Client-action rows open a UI rather than insert text — a subtle trailing search glyph
                  hints at that ("this command opens a picker"). Tokens only, pushed to the row end. */}
              {c.clientAction && (
                <span aria-hidden="true" style={{ marginLeft: "auto", color: "var(--text-faint)", display: "grid" }}>
                  <Icon name="search" size={14} />
                </span>
              )}
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
                gap: "var(--sp-2)",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-1)",
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
                style={{
                  width: 24,
                  height: 24,
                  flex: "none",
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "50%",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text-faint)",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <Icon name="x" size={14} />
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
            // When the slash menu is open and the user is still typing the command (no trailing
            // space yet), Enter/Tab selects the highlighted match — the top of the list — instead of
            // sending. This is the keyboard path to a client action (e.g. `/resume`); for a normal
            // claude command it fills the composer, exactly like clicking the row.
            const topMatch = slashMatches[0];
            const pickingSlash = topMatch !== undefined && !text.includes(" ");
            if (pickingSlash && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
              e.preventDefault();
              pickSlash(topMatch);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="Message claude…"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: "var(--tap-min)",
            resize: "vertical",
            background: "var(--surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius)",
            color: "var(--text)",
            padding: "var(--sp-2) var(--sp-3)",
            font: "inherit",
          }}
        />
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          multiple
          onChange={onPickImage}
          style={visuallyHidden}
          tabIndex={-1}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          onChange={onPickFile}
          style={visuallyHidden}
          tabIndex={-1}
        />
        {/* Icon buttons (Variant A) — quiet ghost affordances. The aria-labels are kept verbatim
            ("Add image" / "Upload file" / "Send") so screen readers AND the existing tests still
            reach each control by name. */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => imageInput.current?.click()}
          aria-label="Add image"
          className="rc-composer-btn"
          style={{ ...iconBtn, opacity: disabled ? 0.5 : 1 }}
        >
          <Icon name="image" size={19} />
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => fileInput.current?.click()}
          aria-label="Upload file"
          className="rc-composer-btn"
          style={{ ...iconBtn, opacity: disabled ? 0.5 : 1 }}
        >
          <Icon name="paperclip" size={19} />
        </button>
        {/* Primary control. While a turn is RUNNING (thinking/streaming/running-tool) this is a STOP
            button — a neutral square in an error/neutral tint (NOT the violet Send) that interrupts
            the turn. Idle/awaiting it is the normal violet Send. */}
        {running ? (
          <button
            type="button"
            onClick={stop}
            disabled={stopping}
            aria-label={stopping ? "Stopping" : "Stop"}
            title={stopping ? "Stopping…" : "Stop"}
            style={{
              width: "var(--tap-min)",
              height: "var(--tap-min)",
              flex: "none",
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--radius)",
              // Neutral/err-tinted surface — deliberately NOT the violet Send gradient, so Stop reads as
              // a distinct, calm-but-clear "halt", not the primary positive action.
              background: "var(--surface-2)",
              border: "1px solid var(--err)",
              color: "var(--err)",
              cursor: stopping ? "default" : "pointer",
              opacity: stopping ? 0.6 : 1,
            }}
          >
            <Icon name="stop" size={16} />
          </button>
        ) : (
          /* Send — the ONE coral primary affordance in the composer: a clay-coral gradient with the
             liquid-glass glow halo + inset top highlight, dark ink glyph (spec .send). */
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            aria-label="Send"
            style={{
              width: "var(--tap-min)",
              height: "var(--tap-min)",
              flex: "none",
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--radius-sm)",
              border: 0,
              background: "var(--accent-grad)",
              color: "var(--on-accent)",
              boxShadow: canSend ? "var(--shadow-pop)" : "none",
              cursor: canSend ? "pointer" : "default",
              opacity: canSend ? 1 : 0.5,
            }}
          >
            <Icon name="arrow-up" size={19} />
          </button>
        )}
      </div>
    </div>
  );
}
