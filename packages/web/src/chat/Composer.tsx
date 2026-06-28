import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { validateImage } from "./image-util";
import { matchSlash } from "./slash";
import type { SlashCommand } from "./slash";
import type { OutboundFrame } from "../types/server";

export interface PendingImage {
  id: string;
  name: string;
  /** Content-store ref returned by the upload (sent to the server, never base64). */
  ref: string;
  /** A local object URL (real) or data URI (harness) for the inline thumbnail, shown before send. */
  previewUrl: string;
}

export interface ComposerProps {
  onSend: (frame: OutboundFrame) => void;
  onUploadFile: (file: File) => Promise<void>;
  /** Upload an attached image (binary) to the content-addressed store, returning its ref. Required for
   *  image attachments; when absent the image buttons surface an "unavailable" error instead of base64. */
  onUploadImage?: (file: File) => Promise<{ ref: string }>;
  /** A client-action slash command (e.g. `/resume`) was chosen. The composer clears itself; the host
   * runs the UI action (opening a popup) rather than sending the text to claude. */
  onSlashCommand?: (name: string) => void;
  /** The session's REAL available slash commands (from `system/init`). Drives the slash menu so the phone
   *  can run the same commands as the terminal; falls back to a small static list before init arrives. */
  commands?: string[];
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

// The input is a contentEditable div, NOT a <textarea>: on iOS Safari a real form field shows the
// native ↑ ↓ ✓ "form assistant" accessory bar above the keyboard, which a contentEditable (not a form
// control) does not. `innerText` preserves the user's line breaks in real browsers; jsdom (tests)
// doesn't implement it, so fall back to textContent when it's empty/absent.
function readEditable(el: HTMLDivElement | null): string {
  if (!el) return "";
  // textContent === "" means visually empty even if a stray <br> lingers (so the placeholder shows).
  if ((el.textContent ?? "") === "") return "";
  const it = el.innerText;
  return typeof it === "string" && it.length > 0 ? it : (el.textContent ?? "");
}

/** Insert plain text at the caret (used for paste + Shift+Enter newline), replacing any selection.
 *  Range-based so it carries no rich markup; best-effort under partial Selection support. */
function insertPlainText(el: HTMLDivElement, text: string): void {
  try {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
      el.textContent = (el.textContent ?? "") + text;
      caretToEnd(el);
      return;
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    el.textContent = (el.textContent ?? "") + text;
  }
}

/** Move the caret to the end of an editable (so the user can keep typing after a programmatic fill).
 *  Best-effort — guarded for environments without full Selection/Range support. */
function caretToEnd(el: HTMLElement): void {
  try {
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* caret nicety only */
  }
}

// Shared base for the two ghost icon controls (image / file). A real <button> with an aria-label so
// it stays reachable by name (a11y + the existing tests). Tap target ≥ var(--tap-min).
const iconBtn: React.CSSProperties = {
  width: "var(--tap-min)",
  height: "var(--tap-min)",
  flex: "none",
  display: "grid",
  placeItems: "center",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  border: "1px solid transparent",
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
  onUploadImage,
  onSlashCommand,
  commands,
  running,
  onStop,
  disabled,
  initialText,
  initialImages,
}: ComposerProps) {
  const [text, setText] = useState(initialText ?? "");
  const [images, setImages] = useState<PendingImage[]>(initialImages ?? []);
  const [error, setError] = useState<string | undefined>();
  // Highlighted slash-menu row for keyboard nav (Arrow keys move it; Enter/Tab pick it).
  const [activeSlash, setActiveSlash] = useState(0);
  // Escape dismisses the slash menu WITHOUT clearing the text; any further typing re-opens it.
  const [slashDismissed, setSlashDismissed] = useState(false);
  // REPL-style ↑/↓ recall of previously-sent messages (terminal parity). `historyRef` holds the sent
  // texts (newest last); `histIndex===null` means "editing a fresh draft", a number means browsing; the
  // in-progress draft is stashed in `draftRef` while browsing so ↓ past the newest restores it.
  const historyRef = useRef<string[]>([]);
  const draftRef = useRef("");
  const [histIndex, setHistIndex] = useState<number | null>(null);
  // Local "stopping" latch: tapping Stop reflects immediately (the button disables + relabels) while
  // the interrupt round-trips and the aborted `result` settles the wire back to idle. Reset whenever the
  // session leaves the running state (the turn ended — by the interrupt or on its own).
  const [stopping, setStopping] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const edRef = useRef<HTMLDivElement>(null);

  // Reset the "stopping" latch once the turn ends (an effect, not a render-time setState).
  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);

  // Free any object URLs for previews STILL pending when the composer unmounts (a session switch
  // remounts it — ChatView is keyed by session id). They're otherwise revoked only on send/remove, so
  // unsent attachments would leak blob memory for the page's lifetime. (revokeObjectURL is a harmless
  // no-op for a non-blob preview URL, e.g. a reopened image served from /images/<ref>.)
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => imagesRef.current.forEach((i) => URL.revokeObjectURL(i.previewUrl)), []);

  // Seed the editable's content ONCE (initialText is harness-only). After that the DOM owns the text
  // (the element has no JSX children), so React never re-renders the content out from under the caret;
  // the contentEditable grows with its content on its own (min/max-height + overflow), no resize math.
  useLayoutEffect(() => {
    const el = edRef.current;
    if (el && initialText) el.textContent = initialText;
  }, [initialText]);

  const slashMatches = matchSlash(text, commands);
  // The menu shows only while it hasn't been Escape-dismissed (typing re-opens it via syncFromDom).
  const showSlash = slashMatches.length > 0 && !slashDismissed;
  const canSend = (text.trim().length > 0 || images.length > 0) && !disabled;
  const errorId = "rc-composer-error";

  // Mirror the editable's live DOM into state (the source of truth for slash matching + canSend). A
  // visually-empty field (only a stray <br>) is normalized to "" so the placeholder reappears.
  function syncFromDom() {
    const el = edRef.current;
    if (!el) return;
    // Typing re-opens a menu the user had Escape-dismissed, and means we're editing a fresh draft (not
    // browsing recall history) — so leave history-recall mode.
    setSlashDismissed(false);
    setHistIndex(null);
    if ((el.textContent ?? "") === "") {
      if (el.innerHTML !== "") el.innerHTML = "";
      setText("");
      setActiveSlash(0);
      return;
    }
    setText(readEditable(el));
    setActiveSlash(0);
  }

  // Set the editable's content imperatively + mirror it into state (the DOM owns the content, so a
  // state-only update wouldn't change what's shown). Used to clear after send + fill a slash command.
  function setContent(value: string) {
    setText(value);
    setActiveSlash(0);
    setSlashDismissed(false);
    const el = edRef.current;
    if (!el) return;
    el.textContent = value;
    if (value) caretToEnd(el);
  }

  // Picking a slash command: a CLIENT-ACTION command (e.g. `/resume`) runs a UI action via
  // `onSlashCommand` and clears the input — nothing is sent to claude. A normal claude command just
  // fills the composer with `"<name> "` so the user can finish typing and send it themselves.
  function pickSlash(c: SlashCommand) {
    if (c.clientAction) {
      onSlashCommand?.(c.name);
      setContent("");
    } else {
      setContent(c.name + " ");
    }
  }

  function send() {
    // Read the LIVE DOM (not just state) so a paste/IME edit that didn't emit `input` can't send stale text.
    const trimmed = readEditable(edRef.current).trim();
    // `stopping`: don't let Enter race an in-flight interrupt (the button is already disabled for this).
    if ((!trimmed && images.length === 0) || disabled || stopping) return;
    const frame: OutboundFrame =
      images.length > 0
        ? { type: "user", text: trimmed || undefined, imageRefs: images.map((i) => i.ref) }
        : { type: "user", text: trimmed };
    onSend(frame);
    // Record the sent text for ↑/↓ recall (skip a consecutive duplicate) and leave browsing mode.
    if (trimmed) {
      const h = historyRef.current;
      if (h[h.length - 1] !== trimmed) h.push(trimmed);
    }
    setHistIndex(null);
    draftRef.current = "";
    setContent("");
    // The sent bubble renders from the store ref, so the pre-send object-URL previews are done — revoke them.
    images.forEach((i) => URL.revokeObjectURL(i.previewUrl));
    setImages([]);
    setError(undefined);
    // Keep the keyboard up on mobile so the next message flows without re-tapping the field.
    if (edRef.current) edRef.current.focus();
  }

  function stop() {
    if (stopping) return; // already requested — don't double-send the interrupt
    setStopping(true);
    onStop?.();
  }

  // Validate + UPLOAD a set of image files (from the picker, paste, or drop) to the content-addressed
  // store, attaching the valid ones as refs (the bytes go up as binary, never base64). The object-URL
  // preview shows the thumbnail immediately; the first error is surfaced without dropping the good ones.
  async function addImageFiles(files: File[]) {
    if (files.length === 0) return;
    let firstErr: string | undefined;
    for (const file of files) {
      const err = validateImage(file);
      if (err) {
        if (firstErr === undefined) firstErr = err;
        continue;
      }
      if (!onUploadImage) {
        if (firstErr === undefined) firstErr = "image upload is unavailable";
        continue;
      }
      const previewUrl = URL.createObjectURL(file);
      try {
        const { ref } = await onUploadImage(file);
        const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setImages((prev) => [...prev, { id, name: file.name, ref, previewUrl }]);
      } catch (uploadErr) {
        URL.revokeObjectURL(previewUrl);
        if (firstErr === undefined)
          firstErr = uploadErr instanceof Error ? uploadErr.message : "failed to upload image";
      }
    }
    setError(firstErr);
  }

  async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await addImageFiles(files);
  }

  // Multi-select: upload every chosen file (don't abort on the first failure), then report any that failed.
  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    const results = await Promise.allSettled(files.map((file) => onUploadFile(file)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) {
      setError(undefined);
    } else {
      const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      const msg = first?.reason instanceof Error ? first.reason.message : "upload failed";
      setError(failed === files.length ? msg : `${failed} of ${files.length} uploads failed — ${msg}`);
    }
  }

  // Paste: keep the editable plain. Images from the clipboard go through validation (never inserted as
  // a live <img> that would be silently dropped from the frame); everything else inserts as plain text.
  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const cd = e.clipboardData;
    const imageFiles = Array.from(cd.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (imageFiles.length > 0) {
      e.preventDefault();
      void addImageFiles(imageFiles);
      return;
    }
    e.preventDefault();
    if (edRef.current) {
      insertPlainText(edRef.current, cd.getData("text/plain"));
      syncFromDom();
    }
  }

  // Drag-and-drop image files route through the same validation as the picker, not the browser default
  // (which would insert the image into the editable or navigate away).
  function onDrop(e: DragEvent<HTMLDivElement>) {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    void addImageFiles(files);
  }

  /** ↑/↓ recall: replace the field with an older/newer sent message. Engages only when the slash menu is
   *  closed AND we're either already browsing or the field is empty — otherwise ↑/↓ move the caret. */
  function recallHistory(dir: "up" | "down"): boolean {
    const hist = historyRef.current;
    const browsing = histIndex !== null;
    if (hist.length === 0 || !(browsing || text.trim().length === 0)) return false;
    if (dir === "up") {
      if (histIndex === null) draftRef.current = readEditable(edRef.current); // stash the live draft once
      const next = histIndex === null ? hist.length - 1 : Math.max(0, histIndex - 1);
      setHistIndex(next);
      setContent(hist[next]!);
    } else {
      if (histIndex === null) return false; // not browsing → nothing newer to go to
      if (histIndex >= hist.length - 1) {
        setHistIndex(null);
        setContent(draftRef.current); // past the newest → restore the in-progress draft
      } else {
        const next = histIndex + 1;
        setHistIndex(next);
        setContent(hist[next]!);
      }
    }
    return true;
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // Never intercept keys mid-IME-composition (confirming a CJK candidate with Enter must not send).
    if (e.nativeEvent.isComposing) return;

    const menuOpen = showSlash;
    // Escape closes an open slash menu (without clearing the text); typing re-opens it.
    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      setSlashDismissed(true);
      return;
    }
    // ↑/↓ recall sent messages when the menu is closed (REPL history, like the terminal).
    if (!menuOpen && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (recallHistory(e.key === "ArrowUp" ? "up" : "down")) {
        e.preventDefault();
        return;
      }
    }
    if (menuOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActiveSlash((i) => {
        const n = slashMatches.length;
        return e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    // Enter/Tab on an open menu picks the highlighted command (the keyboard path to /resume etc.).
    if (menuOpen && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      const pick = slashMatches[Math.min(activeSlash, slashMatches.length - 1)];
      if (pick) {
        e.preventDefault();
        pickSlash(pick);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Send even while a turn is RUNNING — the message is queued by the CLI and handled after the
      // current turn (you can line up the next instruction without waiting). send() self-guards on
      // canSend, so an empty field is a no-op.
      send();
      return;
    }
    // Shift+Enter inserts a deterministic single newline (don't rely on contentEditable's default).
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      if (edRef.current) {
        insertPlainText(edRef.current, "\n");
        syncFromDom();
      }
    }
  }

  return (
    <div
      className="rc-composer rc-glass--float"
      style={{
        // Clean floating composer (spec .composer): a subtle translucent fill + blur + a --line-2
        // border (the .rc-glass--float variant). Compact; Send is the one coral primary affordance.
        // The bottom margin clears the iOS home indicator + the screen's rounded corners (env() is 0 on
        // desktop). It MUST be inline: the inline `padding` shorthand below would otherwise override a
        // stylesheet `padding-bottom`, which is why the old safe-area rule never took effect.
        margin: "var(--sp-2) var(--sp-3) calc(env(safe-area-inset-bottom, 0px) + var(--sp-2))",
        borderRadius: "var(--radius-lg)",
        padding: "var(--sp-2)",
        display: "grid",
        gap: "var(--sp-2)",
      }}
    >
      <style>{`
        /* Neutral icon-button hover — brightens to text + a hairline, NO coral. */
        .rc-composer-btn:hover:not(:disabled) { color: var(--text); background: var(--surface-2); }
        /* The field's hairline lights to the coral focus edge + a soft glow on focus. */
        .rc-composer-input:focus-visible, .rc-composer-input:focus {
          outline: none; border-color: var(--accent-line); box-shadow: var(--focus-glow);
        }
        /* The placeholder — a non-editable sibling shown only when the field is empty (a contentEditable
           has no native placeholder). Matches the field's >=16px on touch so there's no size jump when
           typing begins. */
        .rc-composer-ph {
          position: absolute; left: var(--sp-3); top: var(--sp-2);
          line-height: 1.45; color: var(--text-faint); pointer-events: none; user-select: none;
        }
        @media (pointer: coarse) { .rc-composer-ph { font-size: 16px; } }
        /* The active (keyboard-highlighted) slash row. */
        .rc-slash-row[aria-selected="true"] { background: var(--surface-2); }
      `}</style>
      {error && (
        <div id={errorId} role="alert" style={{ color: "var(--err)", fontSize: "var(--fs-sm)" }}>
          {error}
        </div>
      )}
      {showSlash && (
        <div
          role="listbox"
          aria-label="Slash commands"
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
          {slashMatches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              id={`rc-slash-${i}`}
              role="option"
              aria-selected={i === activeSlash}
              className="rc-slash-row"
              onClick={() => pickSlash(c)}
              onMouseEnter={() => setActiveSlash(i)}
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
                src={img.previewUrl}
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
                onClick={() =>
                  setImages((p) => {
                    const target = p.find((x) => x.id === img.id);
                    if (target) URL.revokeObjectURL(target.previewUrl); // free the object URL we created
                    return p.filter((x) => x.id !== img.id);
                  })
                }
                style={{
                  // 44px tap target (transparent) wrapping a compact 24px visible circle, so the remove
                  // affordance is easy to hit on a phone without a chunky chip.
                  width: "var(--tap-min)",
                  height: "var(--tap-min)",
                  flex: "none",
                  display: "grid",
                  placeItems: "center",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <span
                  style={{
                    width: 24,
                    height: 24,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: "50%",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    color: "var(--text-faint)",
                  }}
                >
                  <Icon name="x" size={14} />
                </span>
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-end" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          {text === "" && (
            <span className="rc-composer-ph" aria-hidden="true">
              Message claude…
            </span>
          )}
          <div
            ref={edRef}
            className="rc-composer-input"
            role="textbox"
            aria-multiline="true"
            aria-label="Message claude"
            aria-describedby={error ? errorId : undefined}
            aria-disabled={disabled || undefined}
            contentEditable={!disabled}
            suppressContentEditableWarning
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onInput={syncFromDom}
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === "file")) e.preventDefault();
            }}
            onKeyDown={onKeyDown}
            style={{
              // The field sits directly on the floating glass bar (spec .composer .ph) — transparent,
              // borderless, the placeholder in --faint. The focus glow lands on the field's own border.
              width: "100%",
              minHeight: "var(--tap-min)",
              // Grow with the draft up to ~40% of the viewport before scrolling internally — a long
              // multi-paragraph message stays readable instead of being crammed into a ~3-line box.
              maxHeight: "40vh",
              overflowY: "auto",
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              background: "transparent",
              border: "1px solid transparent",
              borderRadius: "var(--radius-sm)",
              color: "var(--text)",
              padding: "var(--sp-2) var(--sp-3)",
              font: "inherit",
              boxSizing: "border-box",
            }}
          />
        </div>
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          multiple
          onChange={onPickImage}
          style={visuallyHidden}
          tabIndex={-1}
        />
        <input ref={fileInput} type="file" multiple onChange={onPickFile} style={visuallyHidden} tabIndex={-1} />
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
        {/* While a turn is RUNNING (thinking/streaming/running-tool) the STOP button appears — a neutral
            square with a restrained err outline (NOT coral) that interrupts the turn. Send stays
            available ALONGSIDE it (below) so you can queue the next message without waiting. */}
        {running && (
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
              borderRadius: "var(--radius-sm)",
              // Neutral surface + a restrained err outline — deliberately NOT the coral Send, so Stop
              // reads as a distinct, calm-but-clear "halt", not the primary positive action.
              background: "var(--surface-2)",
              border: "1px solid var(--err-line)",
              color: "var(--err)",
              cursor: stopping ? "default" : "pointer",
              opacity: stopping ? 0.6 : 1,
            }}
          >
            <Icon name="stop" size={16} />
          </button>
        )}
        {/* Send — the ONE coral primary affordance: a FLAT coral fill, dark ink glyph (spec .send).
            Shown when idle, OR while running once there's something to send (queues the next message).
            Hidden only while running with an empty field, so Stop stands alone there. */}
        {(canSend || !running) && (
          <button
            type="button"
            onClick={send}
            // Disabled while an interrupt is in flight (`stopping`): a send racing the abort has an
            // ambiguous outcome (it might land on the turn being torn down).
            disabled={!canSend || stopping}
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
              cursor: canSend && !stopping ? "pointer" : "default",
              opacity: canSend && !stopping ? 1 : 0.4,
            }}
          >
            <Icon name="arrow-up" size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
