import { Mono } from "../ui/Mono";
import { Markdown } from "./Markdown";
import { imageBlockSrc, extractFilePaths, isImagePath } from "./content-images";
import { FileChip } from "./FileChip";
import type { SessionView, TurnItem } from "../store/frame-reducer";
import type { ContentBlock } from "../types/server";

function fileBasename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

/**
 * Turn file paths MENTIONED in a message (claude's own text, or a tool result) into downloadable
 * attachments: images preview inline, other files become download chips. This is how claude "sends"
 * a file or image to the user — when it names a path it produced/read, the user can see or download
 * it. The download goes through the fsRoot-confined `/fs/download` endpoint (the `downloadUrl`).
 */
function FileAttachments({ text, downloadUrl }: { text: string; downloadUrl: (p: string) => string }) {
  const paths = extractFilePaths(text);
  if (paths.length === 0) return null;
  const images = paths.filter(isImagePath);
  const files = paths.filter((p) => !isImagePath(p));
  return (
    <div style={{ display: "grid", gap: "var(--sp-2)", marginTop: "var(--sp-2)" }}>
      {images.map((p) => (
        <a
          key={p}
          href={downloadUrl(p)}
          download
          title={p}
          style={{ display: "block", width: "fit-content", maxWidth: "100%" }}
        >
          <img
            src={downloadUrl(p)}
            alt={fileBasename(p)}
            style={{
              maxWidth: "min(100%, 360px)",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              display: "block",
            }}
          />
        </a>
      ))}
      {files.length > 0 && (
        <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
          {files.map((p) => (
            <FileChip key={p} path={p} href={downloadUrl(p)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Turn({ item, downloadUrl }: { item: TurnItem; downloadUrl?: (path: string) => string }) {
  switch (item.kind) {
    case "assistant-text":
      return (
        <div style={{ color: "var(--text)" }}>
          <Markdown>{item.text}</Markdown>
          {downloadUrl && <FileAttachments text={item.text} downloadUrl={downloadUrl} />}
        </div>
      );
    case "tool-use":
      return (
        <div
          style={{
            display: "flex",
            gap: "var(--sp-2)",
            alignItems: "baseline",
            color: "var(--cyan)",
            fontSize: "var(--fs-sm)",
          }}
        >
          <span style={{ fontFamily: "var(--font-display)" }}>Tool</span>
          <Mono>{item.name}</Mono>
          <Mono muted>{summarizeInput(item.input)}</Mono>
        </div>
      );
    case "tool-result": {
      const text = stringify(item.content);
      return (
        <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)", display: "grid", gap: "var(--sp-2)" }}>
          <Mono muted>{text}</Mono>
          {downloadUrl && <FileAttachments text={text} downloadUrl={downloadUrl} />}
        </div>
      );
    }
    case "user":
      return (
        <div
          style={{
            color: "var(--text)",
            borderLeft: "2px solid var(--accent)",
            paddingLeft: "var(--sp-3)",
            display: "grid",
            gap: "var(--sp-1)",
          }}
        >
          <span style={{ color: "var(--accent)", fontSize: "var(--fs-sm)", fontFamily: "var(--font-display)" }}>You</span>
          {renderBlocks(item.blocks)}
        </div>
      );
    case "result":
      return (
        <div
          style={{
            color: item.isError ? "var(--err)" : "var(--ok)",
            fontSize: "var(--fs-sm)",
            borderTop: "1px solid var(--border)",
            paddingTop: "var(--sp-3)",
          }}
        >
          {item.isError ? "Error" : "Done"}
          {item.result ? ` — ${item.result}` : ""}
          {item.totalCostUsd !== undefined && (
            <>
              {" · "}
              <Mono muted>${item.totalCostUsd.toFixed(4)}</Mono>
            </>
          )}
        </div>
      );
  }
}

export interface MessageListProps {
  view: SessionView;
  downloadUrl?: (path: string) => string;
}

export function MessageList({ view, downloadUrl }: MessageListProps) {
  return (
    // `gridTemplateColumns: minmax(0, 1fr)` lets the single column shrink BELOW its content width.
    // Without it a grid item's default `min-width: auto` lets a wide child (a table, a long code
    // line) grow the track to its natural width, overflowing the whole view to the right forever.
    // With min-0, wide children stay clipped to the column and scroll inside their own overflow box.
    <div
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "var(--sp-4)", padding: "var(--sp-4)" }}
    >
      {view.turns.map((item, i) => (
        <Turn key={i} item={item} downloadUrl={downloadUrl} />
      ))}
      {view.thinkingText && <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>{view.thinkingText}</div>}
      {view.liveText && (
        <div style={{ color: "var(--text)", animation: "rc-fade-in 0.2s ease-out" }}>
          <Markdown>{view.liveText}</Markdown>
          <style>{`@keyframes rc-fade-in { from { opacity: 0.4; } to { opacity: 1; } }`}</style>
        </div>
      )}
    </div>
  );
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.file_path === "string") return obj.file_path;
    if (typeof obj.command === "string") return obj.command;
    if (typeof obj.path === "string") return obj.path;
  }
  return "";
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function renderBlocks(blocks: ContentBlock[]) {
  return blocks.map((b, i) =>
    b.type === "text" ? (
      <div key={i}>{b.text}</div>
    ) : (
      <img
        key={i}
        src={imageBlockSrc(b)}
        alt="attachment"
        style={{ maxWidth: "100%", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}
      />
    ),
  );
}
