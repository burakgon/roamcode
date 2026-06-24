import { Mono } from "../ui/Mono";
import { Markdown } from "./Markdown";
import { imageBlockSrc, extractFilePaths } from "./content-images";
import { FileChip } from "./FileChip";
import type { SessionView, TurnItem } from "../store/frame-reducer";
import type { ContentBlock } from "../types/server";

function Turn({ item, downloadUrl }: { item: TurnItem; downloadUrl?: (path: string) => string }) {
  switch (item.kind) {
    case "assistant-text":
      return (
        <div style={{ color: "var(--text)" }}>
          <Markdown>{item.text}</Markdown>
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
      const paths = downloadUrl ? extractFilePaths(text) : [];
      return (
        <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)", display: "grid", gap: "var(--sp-2)" }}>
          <Mono muted>{text}</Mono>
          {paths.length > 0 && (
            <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
              {paths.map((p) => (
                <FileChip key={p} path={p} href={downloadUrl!(p)} />
              ))}
            </div>
          )}
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
    <div style={{ display: "grid", gap: "var(--sp-4)", padding: "var(--sp-4)" }}>
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
