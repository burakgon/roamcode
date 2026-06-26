import { useState } from "react";
import type { CSSProperties } from "react";
import { Mono } from "../ui/Mono";
import { Icon, iconForFile } from "../ui/Icon";
import type { IconName } from "../ui/Icon";
import { Markdown } from "./Markdown";
import { CodeBlock } from "./CodeBlock";
import { imageBlockSrc, extractFilePaths, isImagePath } from "./content-images";
import { FileChip } from "./FileChip";
import { planRender, parseToolResult, summarizeToolInput, type ToolStep } from "./tool-cluster";
import { SubagentCard } from "./SubagentCard";
import type { SessionView, SubagentThread, TurnItem } from "../store/frame-reducer";
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
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: "var(--text-faint)",
      }}
    >
      <span>{children}</span>
      <span aria-hidden style={{ height: 1, flex: 1, background: "var(--hairline-grad)" }} />
    </div>
  );
}

/** The user's message: an accent-tinted, hairline-bordered bubble, right-aligned, labeled "You". */
function UserTurn({
  item,
  onRewind,
}: {
  item: Extract<TurnItem, { kind: "user" }>;
  /** When provided AND this turn carries a checkpointId, render the tappable rewind affordance. */
  onRewind?: (checkpointId: string) => void;
}) {
  // A turn is rewindable only once its live checkpointId (user-message uuid) has been reconciled.
  const checkpointId = item.checkpointId;
  const canRewind = onRewind !== undefined && checkpointId !== undefined;
  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      <TurnTag>You</TurnTag>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "flex-start", gap: "var(--sp-1)" }}>
        {canRewind && (
          <button
            type="button"
            onClick={() => onRewind!(checkpointId!)}
            aria-label="Rewind to here"
            title="Rewind to here"
            style={REWIND_AFFORDANCE}
          >
            <Icon name="history" size={15} />
          </button>
        )}
        <div
          style={{
            // Neutral elevated surface + hairline, compact, right-aligned (spec .you) — NOT coral.
            maxWidth: "86%",
            background: "var(--user-bubble-bg)",
            border: "1px solid var(--user-bubble-border)",
            color: "var(--user-bubble-text)",
            padding: "9px 13px",
            borderRadius: "13px 13px 4px 13px",
            fontSize: "var(--fs-base)",
            boxShadow: "var(--user-shadow)",
            display: "grid",
            gap: "var(--sp-2)",
            overflowWrap: "anywhere",
            lineHeight: 1.45,
          }}
        >
          {renderBlocks(item.blocks)}
        </div>
      </div>
    </div>
  );
}

// The small, tap-friendly rewind handle that sits beside a user bubble. Quiet by default (faint),
// it brightens on hover/focus. Tokens only; the glyph is the `history` (rewind) icon.
const REWIND_AFFORDANCE: CSSProperties = {
  flex: "none",
  marginTop: "calc(var(--fs-xs) + var(--sp-2))",
  width: "var(--tap-min)",
  minWidth: "var(--tap-min)",
  height: "var(--tap-min)",
  display: "grid",
  placeItems: "center",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-faint)",
  cursor: "pointer",
};

/**
 * The "↩ Rewound to here" marker appended after a rewind. A calm hairline-flanked line (like the
 * result marker) carrying the mode; a FAILED rewind (ok:false) shows the error in the destructive
 * tint so the user knows it didn't take. Color is never the only signal — the text says it too.
 */
function RewoundMarker({ item }: { item: Extract<TurnItem, { kind: "rewound" }> }) {
  const color = item.ok ? "var(--text-muted)" : "var(--err)";
  const modeLabel =
    item.mode === "code" ? "code" : item.mode === "conversation" ? "conversation" : "code + conversation";
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        color: "var(--text-faint)",
        fontSize: "var(--fs-xs)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <span aria-hidden style={{ height: 1, flex: 1, background: "var(--border)" }} />
      <span style={{ color, display: "inline-flex", alignItems: "center", gap: 4 }}>
        <Icon name="history" size={13} />
        {item.ok ? `Rewound to here · ${modeLabel}` : `Rewind failed · ${item.error ?? "unknown error"}`}
      </span>
      <span aria-hidden style={{ height: 1, flex: 1, background: "var(--border)" }} />
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
  background: "var(--code-bg)",
  border: "1px solid var(--code-border)",
  borderRadius: "var(--radius-sm)",
  padding: "var(--sp-2) var(--sp-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-xs)",
  lineHeight: 1.55,
  color: "var(--code-text)",
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
  const resultLang = resultCodeLang(use.name, use.input);
  const icon: IconName = isMeta ? "search" : "terminal";
  const headColor = isMeta ? "var(--text-faint)" : "var(--text-muted)";
  // Meta line shows a faint "loaded X"; normal step shows `Tool · arg`.
  const metaLabel = parsed?.summary || arg || use.name;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        type="button"
        className="rc-tool-step"
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
        <div
          style={{
            padding: `0 var(--sp-3) var(--sp-3) calc(var(--sp-3) + 22px)`,
            animation: "rc-reveal 0.18s ease-out",
          }}
        >
          <div style={detailLabelStyle}>Input</div>
          <ToolInput name={use.name} input={use.input} />
          {parsed ? (
            <>
              <div style={detailLabelStyle}>Result</div>
              {/* A file-READ result is source code → syntax-highlight it in the file's language. Other
                  results (bash output, search hits, status messages) stay plain; a purely-structured
                  result with no human text falls back to the pretty raw JSON. */}
              {resultLang && parsed.text && !parsed.isError ? (
                <CodeBlock code={parsed.text} language={resultLang} />
              ) : parsed.text ? (
                <pre style={rawPanelStyle}>{parsed.text}</pre>
              ) : (
                <pre style={rawPanelStyle}>{parsed.raw}</pre>
              )}
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
        // The "Worked" cluster is a FLAT surface card with a hairline + the light flat-card shadow —
        // quiet, collapsible plumbing (mockup .cluster). No glass/blur: it is not floating chrome.
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--surface)",
        boxShadow: "var(--shadow-1)",
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
        <div style={{ borderTop: "1px solid var(--border)", animation: "rc-reveal 0.18s ease-out" }}>
          {steps.map((step, i) => (
            <ToolStepRow key={`${step.use.id}-${i}`} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A subtle, muted turn-end marker: a hairline rule + "done · $cost" (or an error state). A
 * user-initiated STOP (`item.stopped`) renders as a CALM neutral "stopped" — a stop glyph in muted
 * text, never the red error tint — because aborting a turn is intentional, not a failure.
 */
function ResultMarker({ item }: { item: Extract<TurnItem, { kind: "result" }> }) {
  // "stopped" wins over isError: an aborted turn carries the protocol error flags but is calm, not red.
  const tone = item.stopped ? "stopped" : item.isError ? "error" : "done";
  const color = tone === "stopped" ? "var(--text-muted)" : tone === "error" ? "var(--err)" : "var(--ok)";
  const icon: IconName = tone === "stopped" ? "stop" : tone === "error" ? "alert" : "check";
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
      <span aria-hidden style={{ height: 1, flex: 1, background: "var(--border)" }} />
      <span style={{ color, display: "inline-flex", alignItems: "center", gap: 4 }}>
        <Icon name={icon} size={13} />
        {tone}
      </span>
      {/* We deliberately DON'T echo `item.result` — the CLI's result text is a copy of the assistant
          message already shown above, so printing it here duplicated every turn. The marker stays a
          quiet "done · $cost" (a stopped turn's result is just the internal "aborted" string anyway). */}
      {item.totalCostUsd !== undefined && item.totalCostUsd > 0 && (
        <span style={{ color: "var(--text-muted)" }}>· ${item.totalCostUsd.toFixed(4)}</span>
      )}
      <span aria-hidden style={{ height: 1, flex: 1, background: "var(--border)" }} />
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
          // Inline image attachment — a FLAT surface card with a hairline + light shadow (mockup
          // .img-attach). No glass: it is content, not floating chrome.
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
          boxShadow: "var(--shadow-1)",
          overflow: "hidden",
        }}
      >
        <a href={href} download title={item.path} style={{ display: "block" }}>
          <img
            src={href}
            alt={item.name}
            style={{ display: "block", width: "100%", maxHeight: 280, objectFit: "contain" }}
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
          <Icon name="image" size={15} style={{ color: "var(--text-muted)" }} />
          <Mono muted>{item.name}</Mono>
          <a
            href={href}
            download
            aria-label={`Download ${item.name}`}
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "var(--tap-min)",
              minHeight: "var(--tap-min)",
              color: "var(--text-muted)",
            }}
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
        // File attachment — a FLAT surface card with a hairline + light shadow (mockup .attach).
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-3)",
        background: "var(--surface)",
        boxShadow: "var(--shadow-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "var(--sp-3)",
      }}
    >
      <span
        aria-hidden
        style={{
          // Neutral file-type tile (spec: attachment cards are neutral) — an elevated surface +
          // hairline, the glyph in muted text. No coral.
          width: 46,
          height: 46,
          flex: "none",
          borderRadius: "var(--radius-sm)",
          display: "grid",
          placeItems: "center",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          color: "var(--text-muted)",
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
            width: "var(--tap-min)",
            height: "var(--tap-min)",
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

/**
 * A calm, read-only record of an AskUserQuestion the model asked + the answer chosen — what a reopened
 * chat shows in place of the transient live iris card (and what live shows once you've answered). Renders
 * nothing until it has an answer (while pending, the interactive QuestionPrompt is the live representation).
 */
function AskedQuestionCard({ item }: { item: Extract<TurnItem, { kind: "asked-question" }> }) {
  if (item.answer === undefined || item.answer === "") return null;
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--sp-2)",
        padding: "var(--sp-3)",
        margin: "2px 0",
        borderRadius: "var(--radius-sm)",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
      }}
    >
      <div style={detailLabelStyle}>Asked you</div>
      {item.questions.map((q, i) => (
        <div key={i} style={{ display: "grid", gap: 1 }}>
          {q.header && <div style={{ color: "var(--text-faint)", fontSize: "var(--fs-xs)" }}>{q.header}</div>}
          <div style={{ color: "var(--text)", fontSize: "var(--fs-sm)", lineHeight: 1.45 }}>{q.question}</div>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-2)" }}>
        <span aria-hidden style={{ flex: "none", marginTop: 2, color: "var(--ok)" }}>
          <Icon name="check" size={13} />
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)", lineHeight: 1.45 }}>{item.answer}</span>
      </div>
    </div>
  );
}

function Turn({
  item,
  downloadUrl,
  onRewind,
}: {
  item: TurnItem;
  downloadUrl?: (path: string) => string;
  onRewind?: (checkpointId: string) => void;
}) {
  switch (item.kind) {
    case "assistant-text":
      return <AssistantTurn item={item} downloadUrl={downloadUrl} />;
    case "user":
      return <UserTurn item={item} onRewind={onRewind} />;
    case "result":
      return <ResultMarker item={item} />;
    case "rewound":
      return <RewoundMarker item={item} />;
    case "attachment":
      return <AttachmentCard item={item} downloadUrl={downloadUrl} />;
    case "asked-question":
      return <AskedQuestionCard item={item} />;
    // tool-use / tool-result / subagent-ref never reach here — planRender folds tool plumbing into
    // clusters and turns a subagent-ref into a dedicated `subagent` render node (a SubagentCard).
    case "tool-use":
    case "tool-result":
    case "subagent-ref":
      return null;
  }
}

export interface MessageListProps {
  view: SessionView;
  downloadUrl?: (path: string) => string;
  /** REWIND / CHECKPOINT: invoked with a user turn's checkpointId when its rewind affordance is tapped.
   *  Absent → no affordance is rendered (read-only history view). */
  onRewind?: (checkpointId: string) => void;
  /** The subagent registry — used to render a `subagent` node's SubagentCard. Defaults to the view's
   *  own `subagents` (the main chat); passed explicitly when rendering a subagent's nested transcript. */
  subagents?: Record<string, SubagentThread>;
  /** Open a subagent's drill-in view. Absent → the card renders inert (e.g. read-only contexts). */
  onOpenSubagent?: (id: string) => void;
}

export function MessageList({ view, downloadUrl, onRewind, subagents, onOpenSubagent }: MessageListProps) {
  // Split off any TRAILING queued user bubbles (sent while a turn was still running — the CLI handles
  // them after the current turn). They render BELOW the live stream so the transcript stays in order;
  // once the CLI starts processing one its echo reconciles + clears `queued`, dropping it back inline.
  let splitIdx = view.turns.length;
  while (splitIdx > 0) {
    const t = view.turns[splitIdx - 1];
    if (t?.kind === "user" && t.queued) splitIdx--;
    else break;
  }
  const committedTurns = splitIdx === view.turns.length ? view.turns : view.turns.slice(0, splitIdx);
  const queuedTurns = splitIdx === view.turns.length ? [] : view.turns.slice(splitIdx);
  const plan = planRender(committedTurns);
  const agents = subagents ?? view.subagents;
  return (
    // `gridTemplateColumns: minmax(0, 1fr)` lets the single column shrink BELOW its content width.
    // Without it a grid item's default `min-width: auto` lets a wide child (a table, a long code
    // line) grow the track to its natural width, overflowing the whole view to the right forever.
    // With min-0, wide children stay clipped to the column and scroll inside their own overflow box.
    <div
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "var(--sp-5)", padding: "18px 14px 26px" }}
    >
      {plan.map((node) =>
        node.kind === "cluster" ? (
          <ToolCluster key={node.key} steps={node.steps} />
        ) : node.kind === "subagent" ? (
          (() => {
            const thread = agents[node.id];
            if (!thread) return null;
            return (
              <SubagentCard key={`subagent-${node.id}`} thread={thread} onOpen={() => onOpenSubagent?.(node.id)} />
            );
          })()
        ) : (
          <Turn key={node.index} item={node.item} downloadUrl={downloadUrl} onRewind={onRewind} />
        ),
      )}
      {view.thinkingText && <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>{view.thinkingText}</div>}
      {view.liveText && (
        <div style={{ color: "var(--text)", animation: "rc-fade-in 0.2s ease-out" }}>
          <Markdown>{view.liveText}</Markdown>
          <style>{`@keyframes rc-fade-in { from { opacity: 0.4; } to { opacity: 1; } }`}</style>
        </div>
      )}
      {/* Queued messages (sent mid-turn) render last + dimmed, so they read as "waiting" below the
          current reply rather than jumping above it. They reconcile inline once the CLI processes them. */}
      {queuedTurns.map((item, i) => (
        <div key={`queued-${i}`} style={{ opacity: 0.6 }}>
          <Turn item={item} downloadUrl={downloadUrl} onRewind={onRewind} />
        </div>
      ))}
    </div>
  );
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The code language to highlight a tool RESULT in, or undefined to leave it plain. Only file-READ tools
 *  return source code (cat -n format); bash output / search hits / status messages stay plain. */
function resultCodeLang(name: string, input: unknown): string | undefined {
  if (name !== "Read" && name !== "NotebookRead") return undefined;
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  return langFromPath(obj.file_path ?? obj.path);
}

/** Best-effort code language from a file path's extension (CodeBlock normalizes the rest). */
function langFromPath(p: unknown): string | undefined {
  if (typeof p !== "string") return undefined;
  const dot = p.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = p.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    cjs: "js",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cs: "csharp",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    html: "html",
    css: "css",
    scss: "scss",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    md: "markdown",
    php: "php",
    swift: "swift",
    kt: "kotlin",
  };
  return map[ext];
}

/** One generic input field: a label + a readable value. A multi-line / long string renders with REAL
 *  newlines (a plain panel, not escaped JSON); scalars render inline; objects/arrays as pretty JSON. */
function ToolInputField({ name, value }: { name: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  let body;
  if (typeof value === "string") {
    body = <pre style={rawPanelStyle}>{value}</pre>;
  } else if (typeof value === "number" || typeof value === "boolean") {
    body = <pre style={rawPanelStyle}>{String(value)}</pre>;
  } else {
    body = <pre style={rawPanelStyle}>{toJson(value)}</pre>;
  }
  return (
    <>
      <div style={detailLabelStyle}>{name}</div>
      {body}
    </>
  );
}

/**
 * Render a tool-use input READABLY instead of dumping the whole object as escaped single-line JSON (the
 * old behavior made a Bash command — newlines as literal `\n` — and a git message unreadable). The
 * "starred" string field of well-known tools becomes a real, syntax-highlighted code block; everything
 * else is shown field-by-field with real newlines.
 */
function ToolInput({ name, input }: { name: string; input: unknown }) {
  if (input === undefined) return <pre style={rawPanelStyle}>—</pre>;
  if (input === null || typeof input !== "object") return <pre style={rawPanelStyle}>{String(input)}</pre>;
  const obj = input as Record<string, unknown>;

  // Bash: the command is the star — a real, highlighted shell block (not escaped JSON).
  if (name === "Bash" && typeof obj.command === "string") {
    return (
      <>
        <CodeBlock code={obj.command} language="bash" />
        {typeof obj.description === "string" && obj.description.length > 0 && (
          <ToolInputField name="description" value={obj.description} />
        )}
      </>
    );
  }

  // Write / NotebookEdit and friends: path + content in the file's own language.
  if (typeof obj.content === "string" && (typeof obj.file_path === "string" || typeof obj.path === "string")) {
    const path = (typeof obj.file_path === "string" ? obj.file_path : obj.path) as string;
    return (
      <>
        <ToolInputField name="file_path" value={path} />
        <CodeBlock code={obj.content} language={langFromPath(path)} />
      </>
    );
  }

  // Edit: path + before/after, each in the file's language.
  if (typeof obj.old_string === "string" && typeof obj.new_string === "string") {
    const lang = langFromPath(obj.file_path);
    return (
      <>
        {typeof obj.file_path === "string" && <ToolInputField name="file_path" value={obj.file_path} />}
        <div style={detailLabelStyle}>old</div>
        <CodeBlock code={obj.old_string} language={lang} />
        <div style={detailLabelStyle}>new</div>
        <CodeBlock code={obj.new_string} language={lang} />
      </>
    );
  }

  // Generic: one readable field per key (real newlines for strings, pretty JSON for nested objects).
  const entries = Object.entries(obj);
  if (entries.length === 0) return <pre style={rawPanelStyle}>—</pre>;
  return (
    <>
      {entries.map(([k, v]) => (
        <ToolInputField key={k} name={k} value={v} />
      ))}
    </>
  );
}

function renderBlocks(blocks: ContentBlock[]) {
  return blocks.map((b, i) =>
    b.type === "text" ? (
      // pre-wrap preserves the user's own line breaks (a multi-line message kept its newlines); anywhere
      // breaks a long unbroken token instead of overflowing the bubble.
      <div key={i} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {b.text}
      </div>
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
