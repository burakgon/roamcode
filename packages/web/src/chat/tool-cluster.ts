import type { TurnItem } from "../store/frame-reducer";
import type { ContentBlock } from "../types/server";
import { stripAnsi } from "./ansi";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;

/**
 * Render-time grouping for the conversation. The reducer keeps turns flat and verbose; here we walk
 * that flat list and fold consecutive tool plumbing (`tool-use` + its matching `tool-result`) into
 * ONE quiet, collapsible "Worked" cluster of step rows. Nothing is dropped — every tool input AND
 * the raw tool_result is reachable by expanding a step. This is a pure RENDER concern; it never
 * mutates or reshapes reducer turns (other code + tests depend on those shapes).
 */

export interface ToolStep {
  /** The originating tool-use turn. */
  use: Extract<TurnItem, { kind: "tool-use" }>;
  /** Its paired tool-result (matched by tool_use_id), if one has arrived yet. */
  result?: Extract<TurnItem, { kind: "tool-result" }>;
  /** True for meta/search tools (ToolSearch, mcp__* loaders) — rendered as the faintest line. */
  isMeta: boolean;
}

export type RenderNode =
  | { kind: "turn"; item: TurnItem; index: number }
  | { kind: "cluster"; steps: ToolStep[]; key: string }
  // A subagent spawn anchor (the `Agent`/`Task` tool). Rendered as a dedicated SubagentCard — NEVER
  // folded into the generic "Worked" cluster (ordinary tools). `id` is the SubagentThread key.
  | { kind: "subagent"; id: string; index: number };

/** A meta/search tool: the deferred-tool loader and any MCP meta-search. The faintest cluster line. */
export function isMetaTool(name: string): boolean {
  return name === "ToolSearch" || /^mcp__/.test(name);
}

/**
 * Walk the flat turns and produce a render plan: assistant/user/result/attachment turns stay as
 * standalone nodes; runs of `tool-use`/`tool-result` collapse into a `cluster`. A `tool-result` is
 * attached to the `tool-use` it answers (by id). Orphan results (no preceding use in view) still
 * surface as their own one-step cluster so nothing is lost.
 */
export function planRender(turns: TurnItem[]): RenderNode[] {
  const nodes: RenderNode[] = [];
  // Index tool-results by the tool-use id they answer, so we can pair them when we hit the use.
  const resultByUseId = new Map<string, Extract<TurnItem, { kind: "tool-result" }>>();
  for (const t of turns) {
    if (t.kind === "tool-result") resultByUseId.set(t.toolUseId, t);
  }

  let i = 0;
  let clusterSeq = 0;
  while (i < turns.length) {
    const t = turns[i];
    if (!t) {
      i += 1;
      continue;
    }
    if (t.kind === "tool-use") {
      // Greedily absorb a contiguous run of tool plumbing into one cluster. `tool-result` turns are
      // consumed here (they belong to a use); a truly-orphan result surfaces as its own minimal step.
      const steps: ToolStep[] = [];
      let cur = turns[i];
      while (cur && (cur.kind === "tool-use" || cur.kind === "tool-result")) {
        if (cur.kind === "tool-use") {
          steps.push({ use: cur, result: resultByUseId.get(cur.id), isMeta: isMetaTool(cur.name) });
        }
        // tool-result turns are folded into their use above; consume and continue.
        i += 1;
        cur = turns[i];
      }
      nodes.push({ kind: "cluster", steps, key: `cluster-${clusterSeq++}` });
      continue;
    }
    if (t.kind === "tool-result") {
      // An orphan result with no preceding tool-use in this view — wrap it minimally so its raw
      // content stays reachable (verbose-accessible) rather than vanishing.
      const synthetic: ToolStep = {
        use: { kind: "tool-use", id: t.toolUseId, name: "tool", input: undefined },
        result: t,
        isMeta: false,
      };
      nodes.push({ kind: "cluster", steps: [synthetic], key: `cluster-${clusterSeq++}` });
      i += 1;
      continue;
    }
    if (t.kind === "subagent-ref") {
      // A subagent spawn — its own render node (a SubagentCard), kept OUT of the "Worked" cluster.
      nodes.push({ kind: "subagent", id: t.id, index: i });
      i += 1;
      continue;
    }
    nodes.push({ kind: "turn", item: t, index: i });
    i += 1;
  }
  return nodes;
}

/** Collapse a value to one readable line (no newlines, capped) for the collapsed step head. */
function clipArg(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 79) + "…" : oneLine;
}

/**
 * A short, human one-line argument summary for a tool-use. Probes the common descriptive fields first
 * (command/path/query/… plus subject/title/description/prompt so structured tools like TaskCreate aren't
 * left bare), then a LIST-shaped field (e.g. TodoWrite's `todos`) summarized as a count, then any first
 * non-empty string field. Always collapsed to one capped line so a multi-line command can't break layout.
 */
/** A "(lines 120–160)" / "(from line 40)" / "(first 50 lines)" suffix for a Read's offset/limit. */
function readRange(offset: unknown, limit: unknown): string {
  const o = typeof offset === "number" ? offset : undefined;
  const l = typeof limit === "number" ? limit : undefined;
  if (o !== undefined && l !== undefined) return ` (lines ${o}–${o + l - 1})`;
  if (o !== undefined) return ` (from line ${o})`;
  if (l !== undefined) return ` (first ${l} lines)`;
  return "";
}

export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // File tools: enrich the path with the READ range (offset/limit) or the WRITE size, so the collapsed
  // step head says e.g. "config.ts (lines 120–160)" / "notes.md (47 lines)" like the terminal does —
  // instead of a bare path that hides which slice was read / how much was written.
  if (typeof obj.file_path === "string") {
    const range = readRange(obj.offset, obj.limit);
    if (range) return clipArg(obj.file_path + range);
    if (typeof obj.content === "string") {
      const lines = obj.content.length === 0 ? 0 : obj.content.split("\n").length;
      return clipArg(`${obj.file_path} (${lines} ${lines === 1 ? "line" : "lines"})`);
    }
  }
  for (const key of [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "name",
    "subject",
    "title",
    "description",
    "prompt",
  ]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return clipArg(v);
  }
  for (const key of ["todos", "edits", "tasks"]) {
    const v = obj[key];
    if (Array.isArray(v) && v.length > 0) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.trim().length > 0) return clipArg(v);
  }
  return "";
}

export interface ParsedResult {
  /** A compact one-line summary of the result (first text line / collapsed JSON), for the step head. */
  summary: string;
  /** The full human-readable text pulled out of the result (real newlines, no JSON scaffolding) — the
   *  preferred verbose-expand body. Empty for a purely-structured result (then fall back to `raw`). */
  text: string;
  /** The full raw result, pretty-printed when it's structured (base64 image data REDACTED) — the
   *  fallback verbose-expand payload. */
  raw: string;
  /** True if the tool reported an error (so the step can flag it). */
  isError: boolean;
  /** Image blocks carried in the result (e.g. Reading an image file) — rendered as <img>, never dumped
   *  as a base64 blob. Empty for an ordinary text/JSON result. */
  images: ImageBlock[];
}

/**
 * Parse a `tool-result` content blob into a one-line summary + the full raw string + any image blocks.
 * Tool results are commonly `[{ type: "text", text: "..." }]`, a bare string, `{ content: [...] }`, an
 * `[{ type: "image", source }]` (Reading an image), or `[{ type: "tool_reference", tool_name }]`
 * (ToolSearch). We extract human text for the summary, collect images to render inline, map other
 * structured blocks to a readable line, and preserve the ENTIRE structure (pretty JSON, base64 redacted)
 * as `raw` so detail is reachable on expand without dumping a megabyte of base64.
 */
export function parseToolResult(content: unknown): ParsedResult {
  const images = collectImages(content);
  const raw = stringifyRaw(content);
  // KEEP the ANSI escapes in `text` so the renderer can show a colorized Bash result IN COLOR (eslint/
  // jest/git/rg all colorize by default), like the terminal — instead of flattening it. The one-line
  // `summary` head is derived from the STRIPPED text (no color in a tiny head); `raw` keeps the bytes.
  const text = extractText(content);
  const isError = detectError(content);
  const firstLine =
    stripAnsi(text)
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  let summary = firstLine.length > 120 ? firstLine.slice(0, 117) + "…" : firstLine;
  // A purely-image result (no text) gets a clean "[image]" head instead of an empty/JSON one.
  if (!summary && images.length > 0) summary = images.length === 1 ? "[image]" : `[${images.length} images]`;
  return { summary, text, raw, isError, images };
}

/** A well-formed image content block (base64 or url source), or undefined. */
function toImageBlock(b: unknown): ImageBlock | undefined {
  if (!b || typeof b !== "object" || (b as { type?: unknown }).type !== "image") return undefined;
  const src = (b as { source?: unknown }).source;
  if (!src || typeof src !== "object") return undefined;
  const s = src as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
  if (s.type === "base64" && typeof s.media_type === "string" && typeof s.data === "string") {
    return { type: "image", source: { type: "base64", media_type: s.media_type, data: s.data } };
  }
  if (s.type === "url" && typeof s.url === "string") {
    return {
      type: "image",
      source: { type: "url", url: s.url, ...(typeof s.media_type === "string" ? { media_type: s.media_type } : {}) },
    };
  }
  return undefined;
}

/** Collect every image block in a tool-result (recursing arrays + a `{content}` wrapper). */
function collectImages(content: unknown): ImageBlock[] {
  const out: ImageBlock[] = [];
  const visit = (c: unknown): void => {
    if (Array.isArray(c)) {
      for (const b of c) visit(b);
      return;
    }
    const img = toImageBlock(c);
    if (img) {
      out.push(img);
      return;
    }
    if (c && typeof c === "object" && (c as { content?: unknown }).content !== undefined) {
      visit((c as { content?: unknown }).content);
    }
  };
  visit(content);
  return out;
}

/** JSON.stringify replacer that redacts a long base64 `data` string (image blob) so the raw panel stays
 *  readable instead of dumping the whole encoded image. */
function redactBase64(key: string, value: unknown): unknown {
  if (key === "data" && typeof value === "string" && value.length > 128) return `<base64 ${value.length} chars>`;
  return value;
}

function stringifyRaw(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, redactBase64, 2);
  } catch {
    return String(content);
  }
}

/** A readable one-line rendering of a non-text structured block (image / tool_reference / other). */
function blockToText(b: unknown): string {
  if (!b || typeof b !== "object") return "";
  const o = b as { type?: unknown; text?: unknown; tool_name?: unknown };
  if (o.type === "text" && typeof o.text === "string") return o.text;
  if (o.type === "tool_reference" && typeof o.tool_name === "string") return `→ ${o.tool_name}`;
  // image blocks render as <img>, not text — contribute nothing to the text body.
  return "";
}

/** Pull the concatenated human-readable text out of a tool-result, ignoring the JSON scaffolding. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => blockToText(b))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const obj = content as { text?: unknown; content?: unknown };
    if (typeof obj.text === "string") return obj.text;
    if (obj.content !== undefined) return extractText(obj.content);
  }
  return "";
}

function detectError(content: unknown): boolean {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const v =
      (content as { is_error?: unknown; isError?: unknown }).is_error ?? (content as { isError?: unknown }).isError;
    if (typeof v === "boolean") return v;
  }
  return false;
}
