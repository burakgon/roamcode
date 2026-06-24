import { useState } from "react";
import type { CSSProperties } from "react";
import { Mono } from "../ui/Mono";
import { Icon, iconForFile } from "../ui/Icon";
import type { IconName } from "../ui/Icon";
import { Markdown } from "./Markdown";
import { imageBlockSrc, extractFilePaths, isImagePath } from "./content-images";
import { FileChip } from "./FileChip";
import { planRender, parseToolResult, summarizeToolInput, type ToolStep } from "./tool-cluster";
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

/** Tiny uppercase "who is speaking" breadcrumb in the display font, with a hairline trailing rule. */
function TurnTag({ children }: { children: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        fontFamily: "var(--font-display)",
        fontSize: "var(--fs-xs)",
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--text-faint)",
      }}
    >
      <span>{children}</span>
      <span
        aria-hidden
        style={{ height: 1, flex: 1, background: "linear-gradient(90deg, var(--border), transparent)" }}
      />
    </div>
  );
}

/** The user's message: an accent-tinted, hairline-bordered bubble, right-aligned, labeled "You". */
function UserTurn({ item }: { item: Extract<TurnItem, { kind: "user" }> }) {
  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      <TurnTag>You</TurnTag>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div
          style={{
            maxWidth: "84%",
            background: "var(--user-bubble-bg)",
            border: "1px solid var(--user-bubble-border)",
            color: "var(--text)",
            padding: "var(--sp-3) var(--sp-4)",
            borderRadius: "18px 18px 6px 18px",
            fontSize: "var(--fs-base)",
            display: "grid",
            gap: "var(--sp-2)",
            overflowWrap: "anywhere",
          }}
        >
          {renderBlocks(item.blocks)}
        </div>
      </div>
    </div>
  );
}

/** Assistant prose — the visual focus: clean, generous, real markdown, plus inline file attachments. */
function AssistantTurn({
  item,
  downloadUrl,
}: {
  item: Extract<TurnItem, { kind: "assistant-text" }>;
  downloadUrl?: (path: string) => string;
}) {
  return (
    <div style={{ color: "var(--text)" }}>
      <Markdown>{item.text}</Markdown>
      {downloadUrl && <FileAttachments text={item.text} downloadUrl={downloadUrl} />}
    </div>
  );
}

const detailLabelStyle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "10px",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-faint)",
  margin: "var(--sp-2) 0 var(--sp-1)",
};

const rawPanelStyle: CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  padding: "var(--sp-2) var(--sp-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-xs)",
  lineHeight: 1.55,
  color: "var(--text-muted)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflowX: "auto",
  margin: 0,
};

/**
 * One quiet hairline tool step. Collapsed it is a `terminal`/`search` icon + a compact mono label
 * (e.g. `Bash · ls -la`); a meta/search tool (ToolSearch) is rendered as the FAINTEST line. Tapping
 * EXPANDS it to reveal the full tool input AND a "Raw result" panel with the raw tool_result content
 * (the previously-leaking JSON) in muted monospace — verbose detail is de-emphasized, never hidden.
 */
function ToolStepRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);
  const { use, result, isMeta } = step;
  const arg = summarizeToolInput(use.input);
  const parsed = result ? parseToolResult(result.content) : undefined;
  const icon: IconName = isMeta ? "search" : "terminal";
  const headColor = isMeta ? "var(--text-faint)" : "var(--text-muted)";
  // Meta line shows a faint "loaded X"; normal step shows `Tool · arg`.
  const metaLabel = parsed?.summary || arg || use.name;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${use.name} step`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          width: "100%",
          minHeight: "var(--tap-min)",
          background: "transparent",
          border: 0,
          textAlign: "left",
          color: headColor,
          padding: "var(--sp-2) var(--sp-3)",
          fontSize: "var(--fs-sm)",
          cursor: "pointer",
        }}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={13} style={{ color: "var(--text-faint)" }} />
        <Icon name={icon} size={14} style={{ opacity: isMeta ? 0.7 : 1 }} />
        {isMeta ? (
          <Mono muted>{metaLabel}</Mono>
        ) : (
          <>
            <Mono>
              <span style={{ color: "var(--cyan)" }}>{use.name}</span>
            </Mono>
            {arg && (
              <Mono muted>
                <span
                  style={{
                    display: "inline-block",
                    maxWidth: "100%",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    verticalAlign: "bottom",
                  }}
                >
                  · {arg}
                </span>
              </Mono>
            )}
          </>
        )}
        {result && (
          <span style={{ marginLeft: "auto", flex: "none", color: parsed?.isError ? "var(--err)" : "var(--ok)" }}>
            <Icon name={parsed?.isError ? "x" : "check"} size={14} label={parsed?.isError ? "failed" : "succeeded"} />
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: `0 var(--sp-3) var(--sp-3) calc(var(--sp-3) + 22px)` }}>
          <div style={detailLabelStyle}>Input</div>
          <pre style={rawPanelStyle}>{stringifyInput(use.input)}</pre>
          {parsed ? (
            <>
              <div style={detailLabelStyle}>Raw result</div>
              <pre style={rawPanelStyle}>{parsed.raw}</pre>
            </>
          ) : (
            <div style={{ ...detailLabelStyle, color: "var(--text-faint)" }}>No result yet</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The "Worked" cluster: ONE collapsible group wrapping all the quiet tool-step rows for a contiguous
 * run of plumbing. Collapsed by default (de-emphasized); its header (e.g. "Worked · 3 steps") toggles
 * the whole group, and each row inside independently expands to its verbose input + raw result.
 */
function ToolCluster({ steps }: { steps: ToolStep[] }) {
  const [open, setOpen] = useState(false);
  const count = steps.length;
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--surface)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} worked steps`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          width: "100%",
          minHeight: "var(--tap-min)",
          background: "transparent",
          border: 0,
          textAlign: "left",
          color: "var(--text-muted)",
          padding: "var(--sp-2) var(--sp-3)",
          fontSize: "var(--fs-sm)",
          cursor: "pointer",
        }}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} style={{ color: "var(--text-faint)" }} />
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Worked</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-xs)",
            color: "var(--text-faint)",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            padding: "1px var(--sp-2)",
          }}
        >
          {count} {count === 1 ? "step" : "steps"}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          {steps.map((step, i) => (
            <ToolStepRow key={`${step.use.id}-${i}`} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A subtle, muted turn-end marker: a hairline rule + "done · $cost" (or an error state). */
function ResultMarker({ item }: { item: Extract<TurnItem, { kind: "result" }> }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        color: "var(--text-faint)",
        fontSize: "var(--fs-xs)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <span aria-hidden style={{ height: 1, flex: 1, background: "var(--border)", opacity: 0.6 }} />
      <span style={{ color: item.isError ? "var(--err)" : "var(--ok)", display: "inline-flex", alignItems: "center", gap: 4 }}>
        <Icon name={item.isError ? "alert" : "check"} size={13} />
        {item.isError ? "error" : "done"}
      </span>
      {item.result ? <span style={{ color: "var(--text-muted)" }}>· {item.result}</span> : null}
      {item.totalCostUsd !== undefined && (
        <span style={{ color: "var(--text-muted)" }}>· ${item.totalCostUsd.toFixed(4)}</span>
      )}
      <span aria-hidden style={{ height: 1, flex: 1, background: "var(--border)", opacity: 0.6 }} />
    </div>
  );
}

/**
 * Claude proactively SENT a file/image to the chat (the mcp-send tool → `attachment` frame). Render
 * it as ONE clean card: a file-type icon, the filename, an optional caption, and a download
 * affordance; images additionally preview inline (wrapped in the download link). No duplicate
 * tool-use/tool-result noise — that plumbing lives (collapsed) in the "Worked" cluster.
 */
function AttachmentCard({
  item,
  downloadUrl,
}: {
  item: Extract<TurnItem, { kind: "attachment" }>;
  downloadUrl?: (path: string) => string;
}) {
  const href = downloadUrl?.(item.path);

  if (href && item.isImage) {
    // Inline image preview card with a caption row that includes the download affordance.
    return (
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
          overflow: "hidden",
        }}
      >
        <a href={href} download title={item.path} style={{ display: "block" }}>
          <img
            src={href}
            alt={item.name}
            style={{ display: "block", width: "100%", maxHeight: 280, objectFit: "cover" }}
          />
        </a>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            padding: "var(--sp-2) var(--sp-3)",
            borderTop: "1px solid var(--border)",
          }}
        >
          <Icon name="image" size={15} style={{ color: "var(--cyan)" }} />
          <Mono muted>{item.name}</Mono>
          <a
            href={href}
            download
            aria-label={`Download ${item.name}`}
            style={{ marginLeft: "auto", display: "inline-flex", color: "var(--text-muted)" }}
          >
            <Icon name="download" size={16} />
          </a>
        </div>
        {item.caption && <CaptionRow text={item.caption} />}
      </div>
    );
  }

  const fileIcon: IconName = iconForFile(item.name);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-3)",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "var(--sp-3)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 44,
          height: 44,
          flex: "none",
          borderRadius: "var(--radius-sm)",
          display: "grid",
          placeItems: "center",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          color: "var(--cyan)",
        }}
      >
        <Icon name={fileIcon} size={20} />
      </span>
      <div style={{ minWidth: 0, flex: 1, display: "grid", gap: 2 }}>
        <Mono>{item.name}</Mono>
        {item.caption && <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>{item.caption}</span>}
      </div>
      {href ? (
        <a
          href={href}
          download
          title={item.path}
          aria-label={`Download ${item.name}`}
          style={{
            width: 40,
            height: 40,
            flex: "none",
            borderRadius: "var(--radius-sm)",
            display: "grid",
            placeItems: "center",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
          }}
        >
          <Icon name="download" size={16} />
        </a>
      ) : null}
    </div>
  );
}

function CaptionRow({ text }: { text: string }) {
  return (
    <div
      style={{
        color: "var(--text)",
        fontSize: "var(--fs-sm)",
        padding: "var(--sp-2) var(--sp-3)",
        borderTop: "1px solid var(--border)",
      }}
    >
      {text}
    </div>
  );
}

function Turn({ item, downloadUrl }: { item: TurnItem; downloadUrl?: (path: string) => string }) {
  switch (item.kind) {
    case "assistant-text":
      return <AssistantTurn item={item} downloadUrl={downloadUrl} />;
    case "user":
      return <UserTurn item={item} />;
    case "result":
      return <ResultMarker item={item} />;
    case "attachment":
      return <AttachmentCard item={item} downloadUrl={downloadUrl} />;
    // tool-use / tool-result never reach here — planRender folds them into clusters.
    case "tool-use":
    case "tool-result":
      return null;
  }
}

export interface MessageListProps {
  view: SessionView;
  downloadUrl?: (path: string) => string;
}

export function MessageList({ view, downloadUrl }: MessageListProps) {
  const plan = planRender(view.turns);
  return (
    // `gridTemplateColumns: minmax(0, 1fr)` lets the single column shrink BELOW its content width.
    // Without it a grid item's default `min-width: auto` lets a wide child (a table, a long code
    // line) grow the track to its natural width, overflowing the whole view to the right forever.
    // With min-0, wide children stay clipped to the column and scroll inside their own overflow box.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "var(--sp-5)", padding: "var(--sp-4)" }}>
      {plan.map((node) =>
        node.kind === "cluster" ? (
          <ToolCluster key={node.key} steps={node.steps} />
        ) : (
          <Turn key={node.index} item={node.item} downloadUrl={downloadUrl} />
        ),
      )}
      {view.thinkingText && (
        <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>{view.thinkingText}</div>
      )}
      {view.liveText && (
        <div style={{ color: "var(--text)", animation: "rc-fade-in 0.2s ease-out" }}>
          <Markdown>{view.liveText}</Markdown>
          <style>{`@keyframes rc-fade-in { from { opacity: 0.4; } to { opacity: 1; } }`}</style>
        </div>
      )}
    </div>
  );
}

function stringifyInput(input: unknown): string {
  if (input === undefined) return "—";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
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
