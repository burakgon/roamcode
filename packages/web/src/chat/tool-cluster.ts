import type { TurnItem } from "../store/frame-reducer";

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
  | { kind: "cluster"; steps: ToolStep[]; key: string };

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
    nodes.push({ kind: "turn", item: t, index: i });
    i += 1;
  }
  return nodes;
}

/** A short, human one-line argument summary for a tool-use (path / command / first string field). */
export function summarizeToolInput(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "query", "url", "name"]) {
      const v = obj[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return "";
}

export interface ParsedResult {
  /** A compact one-line summary of the result (first text line / collapsed JSON), for the step head. */
  summary: string;
  /** The full raw result, pretty-printed when it's structured — this is the verbose-expand payload. */
  raw: string;
  /** True if the tool reported an error (so the step can flag it). */
  isError: boolean;
}

/**
 * Parse a `tool-result` content blob into a one-line summary + the full raw string. Tool results are
 * commonly `[{ type: "text", text: "..." }]`, a bare string, or `{ content: [...] }`; we extract the
 * human text for the summary while preserving the ENTIRE structure (pretty JSON) as `raw` so the
 * previously-leaking raw payload is still fully reachable on expand.
 */
export function parseToolResult(content: unknown): ParsedResult {
  const raw = stringifyRaw(content);
  const text = extractText(content);
  const isError = detectError(content);
  const firstLine = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const summary = firstLine.length > 120 ? firstLine.slice(0, 117) + "…" : firstLine;
  return { summary, raw, isError };
}

function stringifyRaw(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/** Pull the concatenated human-readable text out of a tool-result, ignoring the JSON scaffolding. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
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
    const v = (content as { is_error?: unknown; isError?: unknown }).is_error ?? (content as { isError?: unknown }).isError;
    if (typeof v === "boolean") return v;
  }
  return false;
}
