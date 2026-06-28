import type {
  AttachmentPayload,
  ContentBlock,
  DiagnosticPayload,
  PermissionPayload,
  QuestionPayload,
  ResultPayload,
  RewoundPayload,
  ServerFrame,
} from "../types/server";
import type { LiveWireState } from "../ui/LiveWire";

/** One question of an AskUserQuestion, reduced to what the history card shows (header + prompt text). */
export interface AskedQuestion {
  header?: string;
  question: string;
}

export type TurnItem =
  // A user message. `checkpointId` is its turn's user-message uuid (from --replay-user-messages) — the id
  // the UI offers REWIND on. It's absent on the optimistic bubble until the live `user` echo reconciles it.
  // `queued` marks an optimistic bubble sent WHILE a turn was still running (the CLI queues it for after
  // the current turn): such bubbles render BELOW the live stream so the transcript stays in order, and the
  // flag clears once the echo reconciles (the CLI has started processing it).
  // `pending` marks a bubble whose send was BUFFERED (socket not open) — NOT yet delivered to the server;
  // it drives the "Sending…" label and clears the instant the socket flushes it (or its echo reconciles).
  // Distinct from `queued` (delivered, but Claude is busy so the CLI will process it after the current turn).
  | { kind: "user"; blocks: ContentBlock[]; checkpointId?: string; queued?: boolean; pending?: boolean }
  // A slash command the human ran (e.g. `/compact`, `/model opus`) and, when present, its output. Claude
  // writes this to the transcript as a `<command-name>…` envelope + a `<local-command-stdout>` line —
  // NEITHER flagged isMeta — so without this it renders as a raw-XML "YOU" bubble. Surfaced as a clean,
  // centered command marker instead: the command stays visible (e.g. "the chat was compacted"), not hidden.
  | { kind: "command"; command?: string; output?: string }
  // A SYNTHETIC, system-injected user-role message — NOT something the human typed. The post-compaction
  // continuation seed ("This session is being continued…") is the dominant case: LIVE it's flagged
  // `isSynthetic`; on REOPEN the transcript flags it `isCompactSummary` instead (NEVER isMeta either way),
  // so without this it renders as a giant "YOU" bubble. Surfaced GENERICALLY as one quiet, collapsible
  // "system note" carrying its `text` — the content stays accessible (never hidden, never a human bubble),
  // and any other synthetic system message renders the same clean way. The paired `/compact` command
  // envelope + "Compacted" stdout (when present) render SEPARATELY as a generic `command` marker — not
  // special-cased away — so a manual /compact shows both this note and a clean "/compact · Compacted" row.
  | { kind: "system-note"; text: string }
  | { kind: "assistant-text"; text: string }
  // An assistant extended-thinking block (the model's reasoning). LIVE it also streams transiently as
  // `thinkingText` (cleared when the turn settles); this PERSISTENT turn is what a reopened chat shows —
  // without it, the transcript's thinking block was silently dropped. Only NON-EMPTY thinking becomes a
  // turn (this CLI redacts thinking to "" unless `thinking_display:"summarized"` is set), so a redacted
  // block never renders an empty card.
  | { kind: "thinking"; text: string }
  | { kind: "tool-use"; id: string; name: string; input: unknown }
  // `isError` mirrors the tool_result block's `is_error` flag (a SIBLING of `content` on the wire), so a
  // failed Bash / denied tool renders as an error even when `content` is a bare string (where inspecting
  // the content alone can't tell). Omitted (not false) on success.
  | { kind: "tool-result"; toolUseId: string; content: unknown; isError?: boolean }
  // A SUBAGENT anchor: where an `Agent`/`Task` tool_use spawned a subagent. Renders as a SubagentCard
  // (in the main chat, or inside a parent subagent's transcript for a nested spawn) — NOT a generic
  // tool-use cluster. `id` is the Agent tool_use id == the SubagentThread key.
  | { kind: "subagent-ref"; id: string }
  // An AskUserQuestion (the `mcp__remote-coder__ask_user` MCP tool) the model asked. LIVE it's driven by
  // a transient `question` frame → the interactive iris card; this turn is the PERSISTENT record (it's in
  // the transcript, the question frame isn't) so a reopened chat shows a clean Q&A instead of raw MCP tool
  // plumbing. `answer` is filled from the paired tool_result; the card renders only once it has one.
  | { kind: "asked-question"; id: string; questions: AskedQuestion[]; answer?: string }
  | {
      kind: "result";
      result?: string;
      isError?: boolean;
      totalCostUsd?: number;
      stopped?: boolean;
      durationMs?: number;
    }
  | { kind: "attachment"; id: string; path: string; name: string; caption?: string; isImage: boolean }
  // The "↩ Rewound to here" marker appended after a rewind. For conversation/both the thread above is
  // truncated to the checkpoint before this marker is added.
  | { kind: "rewound"; checkpointId: string; mode: "code" | "conversation" | "both"; ok: boolean; error?: string };

/** A subagent's usage rollup (parsed from the `<usage>` result trailer or task_* events). */
export interface SubagentUsage {
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/**
 * One subagent (the Agent/Task tool) and its live thread. Keyed by the Agent tool_use id (==
 * children's `parentToolUseId` == the task `tool_use_id`). `taskId` is the resume `agentId`.
 * `parentId` is set for a NESTED subagent (one spawned inside another subagent's turn). A depth-2
 * subagent has its lifecycle (status/usage) + final `result` but NO inline `turns` (its internal
 * steps run inside its parent and never inline).
 */
export interface SubagentThread {
  id: string;
  taskId?: string;
  /** subagent_type, e.g. "general-purpose" | "Explore" | "feature-dev:code-reviewer". */
  type?: string;
  description?: string;
  prompt?: string;
  status: "running" | "completed" | "failed";
  /** Live activity label from task_progress.description (e.g. "Running Echo a test string"). */
  activity?: string;
  summary?: string;
  usage?: SubagentUsage;
  turns: TurnItem[];
  liveText: string;
  thinkingText: string;
  wireState: LiveWireState;
  /** The final return value delivered to the parent (the tool_result whose tool_use_id == this id). */
  result?: { content: unknown; isError?: boolean };
  startedAt?: number;
  endedAt?: number;
  /** Set when this subagent was spawned INSIDE another subagent (nested / depth ≥2). */
  parentId?: string;
}

export interface SessionView {
  liveText: string;
  thinkingText: string;
  turns: TurnItem[];
  pendingPermission?: PermissionPayload;
  pendingQuestion?: QuestionPayload;
  lastResult?: ResultPayload;
  /**
   * The latest token usage for the context meter (from the last `result`, or SEEDED on (re)open/switch
   * from the server's live tail). Kept as its own field — separate from `lastResult` — so a switched-to
   * chat can show the meter immediately even though the transcript carries no result frame.
   */
  usage?: { contextTokens?: number; outputTokens?: number; contextWindow?: number };
  /** TRUE while a `/compact` (manual OR auto) is being processed — drives the telemetry "Compacting…" label.
   *  Set from the AUTHORITATIVE wire signal `system status:"compacting"` (which fires for ANY trigger origin —
   *  the web composer OR a /compact typed in the terminal) and cleared when the compaction ends (its
   *  `compact_result` status / `init` / the synthetic seed / the turn's `result`). The optimistic composer
   *  send-flag is a supplementary instant-feedback path; the wire signal is what makes it always show. */
  compacting?: boolean;
  /** TRUE while a just-submitted turn is IN FLIGHT (set optimistically on a delivered send), cleared only at
   *  a true turn boundary (result/exit/rewound). It makes the telemetry read "Thinking…" during ANY
   *  non-working gap of the turn — the send→first-frame spin-up AND mid-turn lulls (e.g. right after a
   *  thinking-only assistant frame, before the tool/text), which is where "Thinking… → Ready" used to flash.
   *  The telemetry only honors it when the wire is idle/success (a real working/awaiting/dormant wire wins),
   *  so it never overrides a genuine state. Transient — a reopen mid-turn relies on the server's `turnActive`. */
  awaitingReply?: boolean;
  /** The CURRENT turn's output tokens so far (what the terminal shows ticking up while Claude works) —
   *  turn-cumulative across the turn's messages, so it only grows. Sourced live from the stream's
   *  `message_delta.usage.output_tokens` (+ `turnTokenBase` for prior messages this turn); seeded on a
   *  reopen-mid-turn from the server's live tail. Undefined when no turn is in flight (cleared on result). */
  liveTokens?: number;
  /** Internal accumulator for {@link liveTokens}: the summed output of the turn's ALREADY-FINISHED messages,
   *  so a multi-message (tool-using) turn's counter stays monotonic instead of resetting each tool round. */
  turnTokenBase?: number;
  diagnostics: DiagnosticPayload[];
  wireState: LiveWireState;
  lastSeq: number;
  /**
   * Subagents spawned in this session, keyed by Agent tool_use id (== children's parentToolUseId ==
   * the task tool_use_id). The main chat shows a `subagent-ref` anchor per spawn; this registry holds
   * each subagent's live thread (its prompt, tool calls/prose, result, status, usage).
   */
  subagents: Record<string, SubagentThread>;
  /** Spawn order of subagents (for the tray). Includes nested children; the tray filters to top-level. */
  subagentOrder: string[];
  /**
   * `taskId → Agent tool_use id` map, seeded from `task_started` (the ONLY task event with both). A
   * `task_updated` carries ONLY `taskId`, so its status patch is applied via this lookup.
   */
  subagentTaskIndex: Record<string, string>;
  /**
   * UUIDs of `user` text turns we've already rendered from a `user` event. Resume replays the
   * transcript's user lines as `user` events carrying the typed text; this set lets a second
   * delivery of the SAME line (e.g. a transcript frame overlapping an optimistic send, or a
   * duplicate replay) be a no-op so a user bubble is never drawn twice.
   */
  seenUserUuids: Set<string>;
  /** The session's available slash commands (from the live `system/init` event) — custom skills, plugin +
   *  project commands, built-ins (names, no leading `/`). Drives the composer's REAL per-session slash menu
   *  instead of a hardcoded list; undefined until the first init arrives (then the composer falls back to a
   *  small static list). */
  commands?: string[];
  /** The session's available TOOL names (from `system/init`) — built-ins (Bash, Read, …) AND MCP tools
   *  (`mcp__<server>__<tool>`). Drives the MCP visibility panel (the `/mcp` equivalent), which groups the
   *  `mcp__*` tools by server. Undefined until the first init arrives. */
  tools?: string[];
}

export function emptyView(): SessionView {
  return {
    liveText: "",
    thinkingText: "",
    turns: [],
    diagnostics: [],
    wireState: "idle",
    lastSeq: 0,
    subagents: {},
    subagentOrder: [],
    subagentTaskIndex: {},
    seenUserUuids: new Set(),
  };
}

/** A fresh subagent thread (status running, neutral working wire). */
function emptyThread(id: string): SubagentThread {
  return { id, status: "running", turns: [], liveText: "", thinkingText: "", wireState: "running-tool" };
}

interface DeltaEvent {
  type?: string;
  index?: number;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  /** `content_block_start` announces the block's type ("thinking" | "text" | "tool_use") at the START of
   *  the block — the authoritative phase signal. Crucially it is reliable even when extended-thinking
   *  content is REDACTED (the stream then carries `thinking: ""`), where the deltas alone reveal nothing. */
  content_block?: { type?: string; name?: string };
  /** `message_delta` carries the running usage (output_tokens ticks up as the message generates). */
  usage?: { output_tokens?: number };
  /** `message_start` carries the message's initial usage (output_tokens ~ a few). */
  message?: { usage?: { output_tokens?: number } };
}
/** One assistant `message.content` block (text / thinking / tool_use). Named so the parse-boundary guard
 *  `blockListOf<AssistantBlock>` types the normalized list. */
interface AssistantBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
interface AssistantMsg {
  message?: {
    content?: Array<AssistantBlock>;
    /** Per-turn token usage. The SUM of its input/cache_read/cache_creation/output is the CURRENT context
     *  occupancy — the right context-meter numerator. (The `result` event's usage is CUMULATIVE across the
     *  whole session — cache reads add up every turn — so it over-reads to many× the window on a long chat.) */
    usage?: Record<string, number>;
  };
  /** Top-level sibling of `message`: the Agent tool_use id when this is a subagent's own message. */
  parentToolUseId?: string;
}
/** One user `message.content` block (text / image / tool_result). Named for the parse-boundary guard. */
interface UserBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
  is_error?: boolean;
  source?: unknown;
}
interface UserMsg {
  message?: {
    content?: string | Array<UserBlock>;
  };
  parentToolUseId?: string;
  /** Present on transcript-replayed lines (parseLine passes the raw line through); used to dedupe. */
  uuid?: string;
  /** The full raw claude line. `isMeta` flags an INJECTED user-role message (skill content loaded by the
   * Skill tool, a `<system-reminder>`, command output) rather than something the human typed — these
   * must NOT render as a "YOU" turn. `origin.kind` is set by the harness on messages IT injected (e.g. a
   * background `task-notification`); a human message has no `origin`. The LIVE wire ships the full raw
   * (so `origin` is present here); on reopen the server folds the same signal into `isMeta`. (This meta
   * signal is DELIBERATELY left as a dual read — no captured fixture exercises `origin`, so collapsing it
   * couldn't be parity-proven; see the dual-format note in the batch report.)
   * The post-compaction seed (the "This session is being continued…" summary) is a SYNTHETIC system-injected
   * message — NOT isMeta. `isSynthetic` is the CANONICAL flag: the LIVE stream sets it, and the server's
   * resume boundary (transcript.ts) now NORMALIZES the transcript's `isCompactSummary` into it. The lingering
   * `isCompactSummary` is the back-compat fallback for the OTHER reopen path (session-hub's slim raw). Either
   * surfaces a clean system note, not a giant "YOU" bubble. */
  raw?: {
    uuid?: string;
    isMeta?: boolean;
    isCompactSummary?: boolean;
    isSynthetic?: boolean;
    origin?: { kind?: string };
  };
}
/** The typed subagent lifecycle fields surfaced by parseLine on a `system` `task_*` event. */
interface TaskInfo {
  taskId?: string;
  toolUseId?: string;
  subagentType?: string;
  description?: string;
  prompt?: string;
  status?: string;
  summary?: string;
  patch?: { status?: string; endTime?: number };
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  lastToolName?: string;
}
interface SystemMsg {
  subtype?: string;
  task?: TaskInfo;
  /** subtype "init": the session's available slash commands (names, no leading `/`). */
  slashCommands?: string[];
  /** subtype "init": the session's available tool names (built-ins + `mcp__<server>__<tool>`). */
  tools?: string[];
  /** subtype "status": the process status — "compacting" marks a /compact in progress (raises Compacting…). */
  status?: string;
  /** subtype "status": present on the event that ENDS a compaction ("success"|"failed") — clears Compacting…. */
  compactResult?: string;
}

const AGENT_TOOLS = new Set(["Agent", "Task"]);
/** True for the subagent-spawn tool. The tool was renamed `Task` → `Agent` in claude 2.1.63; both count. */
function isAgentTool(name: unknown): boolean {
  return typeof name === "string" && AGENT_TOOLS.has(name);
}

/** The AskUserQuestion MCP tool — surfaced live as the iris card, recorded in the transcript as a tool call. */
const ASK_USER_TOOL = "mcp__remote-coder__ask_user";
function isAskUserTool(name: unknown): boolean {
  return name === ASK_USER_TOOL;
}

/** The MCP tools that send a file/image to the chat — surfaced live as the AttachmentCard via a transient
 *  `attachment` frame, recorded in the transcript as a plain tool call (so a reopen must reconstruct it). */
const SEND_IMAGE_TOOL = "mcp__remote-coder__send_image";
const SEND_FILE_TOOL = "mcp__remote-coder__send_file";
function isSendTool(name: unknown): boolean {
  return name === SEND_IMAGE_TOOL || name === SEND_FILE_TOOL;
}

/**
 * Extract a renderable image ContentBlock from a raw user content block, or undefined if it isn't a
 * well-formed image. Handles BOTH the lazy `url` ref a reopen ships (the slim history payload) AND an
 * inline `base64` source (a live-sent image, or a transcript image with no uuid to ref). Keeping these
 * is what lets a reopened chat show the user's uploaded images instead of silently dropping them.
 */
function toImageBlock(block: {
  type?: string;
  source?: unknown;
}): Extract<ContentBlock, { type: "image" }> | undefined {
  if (block.type !== "image" || !block.source || typeof block.source !== "object") return undefined;
  const s = block.source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
  if (s.type === "url" && typeof s.url === "string") {
    return {
      type: "image",
      source: { type: "url", url: s.url, ...(typeof s.media_type === "string" ? { media_type: s.media_type } : {}) },
    };
  }
  if (s.type === "base64" && typeof s.media_type === "string" && typeof s.data === "string") {
    return { type: "image", source: { type: "base64", media_type: s.media_type, data: s.data } };
  }
  return undefined;
}

/**
 * Sum a Claude per-turn `message.usage` into the CURRENT context occupancy (the meter numerator):
 * input + cache-read + cache-creation + output tokens — i.e. everything that occupied the model's window
 * for this turn. Returns undefined when no usage is present (so a turn without it doesn't reset the meter).
 */
function contextTokensFromUsage(usage: Record<string, number> | undefined): number | undefined {
  if (!usage) return undefined;
  const n = (k: string) => (typeof usage[k] === "number" ? usage[k] : 0);
  const total =
    n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
  return total > 0 ? total : undefined;
}

/** Basename of a path (for the attachment card's name), tolerant of trailing slashes. */
function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** A user line that carries an `origin.kind` was INJECTED by the harness (e.g. a background
 *  `task-notification`), not typed by the human — a human message has no `origin`. The live wire ships
 *  the full raw, so this catches injected lines structurally; on reopen the server already folds the
 *  same signal into `isMeta` (parseTranscript), so the slim payload is covered too. */
function isInjectedOrigin(origin: unknown): boolean {
  return typeof (origin as { kind?: unknown } | null)?.kind === "string";
}

/** The synthetic user-role notice the CLI injects on a STOP — "[Request interrupted by user...]" (and the
 *  "...for tool use" variant). It carries NO isMeta flag, so without this it renders as a bogus "YOU"
 *  bubble — yet the turn's `result` already shows a clean "Stopped" marker, making the bubble pure noise.
 *  Treated like isMeta (never rendered as a human turn). Matches a string OR a sole text block. */
function isInterruptNotice(content: unknown): boolean {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.length === 1 && (content[0] as { type?: string } | undefined)?.type === "text"
        ? ((content[0] as { text?: string }).text ?? "")
        : "";
  return text.trimStart().startsWith("[Request interrupted by user");
}

/** A slash command the human ran is written to the transcript as a `<command-name>/x</command-name>…
 *  <command-args>…</command-args>` envelope, its output on a following `<local-command-stdout>` line, and
 *  a `<local-command-caveat>` preamble. Claude flags neither the envelope nor the stdout as `isMeta`, so
 *  they fall through to a raw-XML "YOU" bubble. Recognize each here so the reducer can render the command
 *  cleanly (and drop the caveat boilerplate) instead of leaking tags into the chat. Returns undefined for
 *  ordinary text, so a human message that merely starts with prose is never mistaken for a command. */
function parseLocalCommand(
  text: string,
): { kind: "name"; command: string } | { kind: "stdout"; output: string } | { kind: "hidden" } | undefined {
  const t = text.trimStart();
  if (t.startsWith("<local-command-caveat>")) return { kind: "hidden" };
  if (t.startsWith("<local-command-stdout>") || t.startsWith("<command-stdout>")) {
    const m = /<(?:local-)?command-stdout>([\s\S]*?)<\/(?:local-)?command-stdout>/.exec(t);
    return { kind: "stdout", output: (m?.[1] ?? "").trim() };
  }
  if (t.startsWith("<command-name>")) {
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1]?.trim() ?? "";
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? "";
    if (!name) return { kind: "hidden" }; // unparseable envelope → hide rather than show raw tags
    return { kind: "name", command: args ? `${name} ${args}` : name };
  }
  return undefined;
}

/** Build an attachment TurnItem from a send_file/send_image tool_use (its input carries {path, caption}). */
function attachmentFromSend(id: string, name: string, input: unknown): Extract<TurnItem, { kind: "attachment" }> {
  const inp = (input ?? {}) as { path?: unknown; caption?: unknown };
  const path = typeof inp.path === "string" ? inp.path : "";
  return {
    kind: "attachment",
    id,
    path,
    name: path ? basename(path) : id,
    caption: typeof inp.caption === "string" ? inp.caption : undefined,
    isImage: name === SEND_IMAGE_TOOL,
  };
}

/** Pull the {header, question} list out of an ask_user tool input (`{ questions: [...] }`). */
function extractAskQuestions(input: unknown): AskedQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.map((q) => {
    const o = (q ?? {}) as { header?: unknown; question?: unknown };
    return {
      header: typeof o.header === "string" ? o.header : undefined,
      question: typeof o.question === "string" ? o.question : "",
    };
  });
}

/** Pull the human text out of a tool_result content blob (string | [{text}] | nested). */
function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * PARSE-BOUNDARY DEFENSE. The CLI JSON is untrusted: a `message.content` may be a non-array (e.g. a bare
 * string) or carry junk entries (`null`, a number, `undefined`). The reducer reads `block.type` on each
 * entry, which TypeErrors on a non-object — and since the store calls reduceFrame with NO try/catch, that
 * throw would propagate into React render (caught only by the ErrorBoundary). This normalizes any content
 * to an array of OBJECT blocks: a non-array → [], and non-object entries are dropped. For VALID lines the
 * output is identical (a real block is always a non-null object), so this never changes good behavior — it
 * only skips the junk that would otherwise have crashed. `B` is the caller's block shape (a partial record).
 */
function blockListOf<B>(content: unknown): B[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is B => b !== null && typeof b === "object");
}

/** Map a task status string to the SubagentThread status, or undefined to leave unchanged. */
function mapTaskStatus(s: string | undefined): SubagentThread["status"] | undefined {
  if (s === "completed") return "completed";
  if (s === "failed" || s === "error") return "failed";
  return undefined;
}

/** A LiveWire dot state for a finished/running subagent status. */
function wireForStatus(status: SubagentThread["status"]): LiveWireState {
  return status === "failed" ? "error" : status === "completed" ? "success" : "running-tool";
}

/** The honest wire state for a streaming content block, by its `content_block.type` (from
 *  `content_block_start`): a thinking block → "thinking", text → "streaming". A tool_use block is
 *  deliberately NOT mapped: while the call is being COMPOSED (its args stream as input_json_delta) no tool
 *  is executing yet — that is still generation, so the wire stays at the prior phase. "running-tool" is set
 *  only once the call is FINALIZED + dispatched (the assistant tool_use frame), which also keeps the LIVE
 *  wire identical to what a REOPEN can derive from the buffer (an unmatched finalized tool_use). */
function wireForBlockType(blockType?: string): LiveWireState | undefined {
  if (blockType === "thinking" || blockType === "redacted_thinking") return "thinking";
  if (blockType === "text") return "streaming";
  return undefined;
}

/** Merge a task_* usage object (totalTokens/...) into the thread's usage rollup (new values win). */
function mergeUsage(prev: SubagentUsage | undefined, tu: TaskInfo["usage"]): SubagentUsage | undefined {
  if (!tu) return prev;
  return {
    tokens: tu.totalTokens ?? prev?.tokens,
    toolUses: tu.toolUses ?? prev?.toolUses,
    durationMs: tu.durationMs ?? prev?.durationMs,
  };
}

// The `<usage>` trailer claude appends to a subagent's final tool_result, e.g.
// `<usage>subagent_tokens: 11401\ntool_uses: 1\nduration_ms: 4112</usage>`.
const USAGE_TRAILER_RE = /subagent_tokens:\s*(\d+)[\s\S]*?tool_uses:\s*(\d+)[\s\S]*?duration_ms:\s*(\d+)/;

/** Concatenate the text of a tool_result content (string, array of text blocks, or `{content}`). */
function collectResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && "content" in content) {
    return collectResultText((content as { content?: unknown }).content);
  }
  return "";
}

/** Parse the `<usage>` trailer from a subagent's final tool_result content, when present. */
export function parseSubagentUsage(content: unknown): SubagentUsage | undefined {
  const m = USAGE_TRAILER_RE.exec(collectResultText(content));
  if (!m) return undefined;
  return { tokens: Number(m[1]), toolUses: Number(m[2]), durationMs: Number(m[3]) };
}

/**
 * The human-readable answer text of a subagent's final result — every text block EXCEPT the trailing
 * `agentId:` / `<usage>` bookkeeping block. Used by SubagentView to render the Result as markdown.
 */
export function subagentResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          !!b &&
          typeof b === "object" &&
          (b as { type?: string }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .filter((text) => !/^agentId:/m.test(text) && !text.includes("<usage>"))
      .join("\n\n");
  }
  if (content && typeof content === "object" && "content" in content) {
    return subagentResultText((content as { content?: unknown }).content);
  }
  return "";
}

/**
 * Pure: fold one ServerFrame into the per-session view. Never throws on unknown shapes.
 *
 * Delta-replay dedup: a reconnect requests `?since=<lastSeq>` and the server replays only
 * `seq > since`, but to be defensive against any overlap we drop any frame whose `seq` is
 * at or below the last applied `seq`. This guarantees streamed text is never double-counted
 * and a `permission`/`result` is never re-fired on reconnect.
 */
export function reduceFrame(view: SessionView, frame: ServerFrame): SessionView {
  // Idempotent on replay: a frame we've already applied (or an out-of-order duplicate) is a no-op.
  if (frame.seq <= view.lastSeq) return view;

  const next: SessionView = { ...view, lastSeq: Math.max(view.lastSeq, frame.seq) };

  if (frame.kind === "question") {
    next.pendingQuestion = frame.payload as QuestionPayload;
    next.wireState = "awaiting";
    // Keep `awaitingReply` (the turn is still in flight — Claude paused to ask); the "awaiting" wireState
    // owns the display, and after the answer any resume gap is still bridged to "Thinking…".
    return next;
  }
  if (frame.kind === "permission") {
    next.pendingPermission = frame.payload as PermissionPayload;
    next.wireState = "awaiting";
    return next;
  }
  if (frame.kind === "resolve") {
    // A prompt (question/permission) was answered/cancelled server-side. Clear the matching pending
    // prompt NOW so it doesn't linger until the turn's `result` — and, crucially, so a reconnect / OTA
    // reload that re-folds the buffer doesn't re-show an already-answered question as if it were never
    // answered (the server also prunes the prompt's retained frame; this handles live + same-buffer folds).
    const requestId = (frame.payload as { requestId?: string } | null)?.requestId;
    if (requestId !== undefined) {
      if (next.pendingQuestion?.requestId === requestId) next.pendingQuestion = undefined;
      if (next.pendingPermission?.requestId === requestId) next.pendingPermission = undefined;
      // The agent resumes on the answer; drop the loud "awaiting you" unless another prompt is still
      // pending (the next assistant/stream/tool frame sets the real working state).
      if (next.wireState === "awaiting" && !next.pendingQuestion && !next.pendingPermission) {
        next.wireState = "thinking";
      }
    }
    return next;
  }
  if (frame.kind === "diagnostic") {
    next.diagnostics = [...view.diagnostics, frame.payload as DiagnosticPayload];
    return next;
  }
  if (frame.kind === "result") {
    const r = frame.payload as ResultPayload;
    // A user-initiated STOP (interrupt) ends the turn with subtype "error_during_execution" and a
    // terminal_reason of "aborted_streaming" (interrupted mid-stream) OR "aborted_tools" (interrupted
    // during a tool — the shape the real CLI emits, see fixtures/qa/interrupt). That is NOT a real error —
    // render it as a calm "Stopped" marker and return the wire to idle, never the red error.
    const stopped =
      r.terminalReason === "aborted_streaming" ||
      r.terminalReason === "aborted_tools" ||
      r.subtype === "error_during_execution";
    next.lastResult = r;
    // The result's usage is CUMULATIVE (it over-reads to many× the window on a long chat), so do NOT take
    // its contextTokens — the assistant handler owns the (per-turn) numerator. Take only the authoritative
    // contextWindow (the meter denominator, from the CLI's modelUsage) and outputTokens; keep the rest.
    if (r.usage?.contextWindow !== undefined || r.usage?.outputTokens !== undefined) {
      next.usage = {
        ...next.usage,
        ...(r.usage.contextWindow !== undefined ? { contextWindow: r.usage.contextWindow } : {}),
        ...(r.usage.outputTokens !== undefined ? { outputTokens: r.usage.outputTokens } : {}),
      };
    }
    next.pendingPermission = undefined;
    next.pendingQuestion = undefined;
    next.liveText = "";
    next.thinkingText = "";
    next.compacting = false; // a /compact turn ends here → clear the "Compacting…" indicator
    next.awaitingReply = false; // the turn settled → the "Thinking…" bridge is done
    next.liveTokens = undefined; // the turn ended → stop the live token counter (next turn rebuilds it)
    next.turnTokenBase = undefined;
    next.wireState = stopped ? "idle" : r.isError ? "error" : "success";
    next.turns = [
      ...view.turns,
      {
        kind: "result",
        result: r.result,
        isError: r.isError,
        totalCostUsd: r.totalCostUsd,
        stopped,
        durationMs: r.durationMs,
      },
    ];
    return next;
  }
  if (frame.kind === "attachment") {
    // Claude sent a file/image to the chat — append it as its own turn so the message list renders
    // it inline (image) or as a download chip (file). Does not change the live wire state.
    const a = frame.payload as AttachmentPayload;
    // DEDUPE: the send_file/send_image tool_use (which precedes this frame, and is the ONLY source on a
    // transcript reopen) already created the attachment turn for this path. Skip so the live frame doesn't
    // draw a SECOND card. If no matching turn exists (e.g. the tool_use was evicted from a delta replay),
    // fall through and create it — the critical frame is the safety net.
    if (a.path && view.turns.some((t) => t.kind === "attachment" && t.path === a.path)) return next;
    next.turns = [
      ...view.turns,
      { kind: "attachment", id: a.id, path: a.path, name: a.name, caption: a.caption, isImage: a.isImage },
    ];
    return next;
  }
  if (frame.kind === "rewound") {
    // REWIND / CHECKPOINT outcome. For conversation/both, the conversation was truncated server-side at
    // the checkpoint, so MIRROR that in the displayed thread: drop every turn AFTER the user turn whose
    // checkpointId matches (keep the checkpoint turn itself). `code` leaves the thread intact (files only).
    // Then append the "↩ Rewound to here" marker. A failed rewind (ok:false) still shows a marker (with
    // its error) but never truncates.
    const r = frame.payload as RewoundPayload;
    let turns = [...view.turns];
    if (r.ok && (r.mode === "conversation" || r.mode === "both")) {
      const cpIdx = turns.findIndex((t) => t.kind === "user" && t.checkpointId === r.checkpointId);
      if (cpIdx >= 0) turns = turns.slice(0, cpIdx + 1);
      next.liveText = "";
      next.thinkingText = "";
      next.pendingPermission = undefined;
      next.pendingQuestion = undefined;
      next.wireState = "idle";
      next.awaitingReply = false; // a rewind ends the turn → the "Thinking…" bridge is done
    }
    turns.push({
      kind: "rewound",
      checkpointId: r.checkpointId,
      mode: r.mode,
      ok: r.ok,
      ...(r.error ? { error: r.error } : {}),
    });
    next.turns = turns;
    return next;
  }
  if (frame.kind === "exit") {
    // A clean process end (code 0/none, or a graceful kill signal) is dormant/resumable, NOT an error —
    // only a non-zero code or a crash signal turns the wire red. (Mirrors the server's isCleanExit.)
    const info = frame.payload as { code?: number | null; signal?: string | null };
    const clean = info.signal
      ? info.signal === "SIGTERM" || info.signal === "SIGINT" || info.signal === "SIGHUP"
      : info.code === null || info.code === undefined || info.code === 0;
    next.wireState = clean ? "idle" : "error";
    next.awaitingReply = false; // the process ended → nothing is coming; the "Thinking…" bridge is done
    next.compacting = false; // a process that died MID-/compact never sends a result/status to clear this —
    // without this the strip would be stuck on a calm "Compacting…" masking the crash/dormancy.
    next.liveTokens = undefined;
    next.turnTokenBase = undefined;
    return next;
  }

  // kind === "event": an InboundEvent
  const ev = frame.payload as { type?: string } & DeltaEvent & AssistantMsg & UserMsg & SystemMsg;

  // --- Subagent registry mutation helpers (close over `next`; immutable per-call) -----------------
  /** Create-or-update the thread `id` via `fn`; registers it (status running) + spawn order on first touch. */
  const updateThread = (id: string, fn: (t: SubagentThread) => SubagentThread): void => {
    const isNew = next.subagents[id] === undefined;
    const cur = next.subagents[id] ?? emptyThread(id);
    next.subagents = { ...next.subagents, [id]: fn(cur) };
    if (isNew && !next.subagentOrder.includes(id)) next.subagentOrder = [...next.subagentOrder, id];
  };
  /** Seed a subagent from its Agent tool_use (description/type/prompt from input; parentId if nested). */
  const seedSubagent = (id: string, input: unknown, parentId: string | undefined): void => {
    const inp = asRecord(input);
    updateThread(id, (t) => ({
      ...t,
      type: t.type ?? asStr(inp.subagent_type),
      description: t.description ?? asStr(inp.description),
      prompt: t.prompt ?? asStr(inp.prompt),
      parentId: t.parentId ?? parentId,
      startedAt: t.startedAt ?? Date.now(),
    }));
  };
  /** Append turns into a subagent thread (and optionally bump its wire / clear its live text). */
  const appendThreadTurns = (
    id: string,
    add: TurnItem[],
    opts: { wire?: LiveWireState; clearLive?: boolean } = {},
  ): void => {
    updateThread(id, (t) => ({
      ...t,
      turns: [...t.turns, ...add],
      ...(opts.wire ? { wireState: opts.wire } : {}),
      ...(opts.clearLive ? { liveText: "", thinkingText: "" } : {}),
    }));
  };
  /** Capture a subagent's final result (the tool_result whose tool_use_id == the Agent id). */
  const applySubagentResult = (id: string, block: { content?: unknown; is_error?: boolean }): void => {
    const isError = block.is_error === true;
    const usage = parseSubagentUsage(block.content);
    updateThread(id, (t) => ({
      ...t,
      result: { content: block.content, isError },
      status: isError ? "failed" : t.status === "running" ? "completed" : t.status,
      usage: usage ?? t.usage,
      wireState: isError ? "error" : "success",
      endedAt: t.endedAt ?? Date.now(),
    }));
  };

  if (ev.type === "stream_event") {
    // NOTE: do NOT clear the "Thinking…" bridge here unconditionally. `message_start`/`message_delta` are
    // usage-only bookkeeping that set NO working wireState — clearing the bridge on them left a stale
    // "Ready" gap between message_start and the first real content. The bridge is handed off only when an
    // actual working state begins (a content delta below, or the assistant frame).
    const inner = (ev as { event?: DeltaEvent }).event;
    // Subagent partial deltas carry no parent linkage in practice, but route defensively if one ever does.
    const parent = ev.parentToolUseId;
    // LIVE TOKEN COUNTER (main turn only): `message_delta` carries this message's running output_tokens; we
    // add `turnTokenBase` (prior messages this turn) so a multi-message turn's count only grows. A new
    // `message_start` commits the finished message into the base. Subagent (parent) usage stays on its card.
    if (parent === undefined && inner) {
      if (inner.type === "message_start") {
        next.turnTokenBase = next.liveTokens ?? next.turnTokenBase ?? 0;
        const out = inner.message?.usage?.output_tokens;
        next.liveTokens = next.turnTokenBase + (typeof out === "number" ? out : 0);
      } else if (inner.type === "message_delta") {
        const out = inner.usage?.output_tokens;
        if (typeof out === "number") next.liveTokens = (next.turnTokenBase ?? 0) + out;
      }
    }
    // PHASE SIGNAL — `content_block_start` announces the block's type at its START, so the wire shows the
    // TRUE state (Thinking / Streaming / Running tool) the moment the block opens. This is the honest
    // source: it works even when extended-thinking content is REDACTED (deltas carry `thinking: ""`), the
    // case where the delta-only path below sees nothing and the state would otherwise stay stale.
    if (inner?.type === "content_block_start") {
      const wire = wireForBlockType(inner.content_block?.type);
      if (wire) {
        if (parent !== undefined) updateThread(parent, (t) => ({ ...t, wireState: wire }));
        else next.wireState = wire;
      }
    }
    if (inner?.type === "content_block_delta" && inner.delta) {
      // Set the wire on the delta TYPE regardless of whether its content is present: redacted thinking
      // streams as `thinking: ""`, so guarding on the text would drop the "Thinking" state entirely. Append
      // the text only when there is some (an empty delta still advances the phase, not the transcript).
      if (inner.delta.type === "text_delta") {
        const text = inner.delta.text ?? "";
        if (parent !== undefined) {
          updateThread(parent, (t) => ({ ...t, liveText: t.liveText + text, wireState: "streaming" }));
        } else {
          next.liveText = view.liveText + text;
          next.wireState = "streaming";
        }
      } else if (inner.delta.type === "thinking_delta") {
        const thinking = inner.delta.thinking ?? "";
        if (parent !== undefined) {
          updateThread(parent, (t) => ({ ...t, thinkingText: t.thinkingText + thinking, wireState: "thinking" }));
        } else {
          next.thinkingText = view.thinkingText + thinking;
          next.wireState = "thinking";
        }
      }
    }
    return next;
  }
  if (ev.type === "assistant") {
    const parent = ev.parentToolUseId;
    // Untrusted boundary: normalize content to object-blocks so a malformed CLI line (content:[null], a
    // non-array content, …) degrades to "skip the bad block" instead of TypeError-ing on `block.type`.
    const content = blockListOf<AssistantBlock>(ev.message?.content);
    // Build the turns for this message. Each `Agent`/`Task` tool_use becomes a `subagent-ref` anchor
    // (a card) + a seeded thread, INSTEAD of a generic tool-use cluster. A nested Agent tool_use (one
    // whose own message has a parent) creates a CHILD thread (parentId = that parent).
    const added: TurnItem[] = [];
    let sawTool = false;
    let sawAgentSpawn = false;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        // Skip EMPTY/whitespace-only text blocks (a tool-only assistant message commonly carries a "" text
        // block alongside its tool_use) — they rendered as a blank gap with a "You/assistant" rhythm break.
        added.push({ kind: "assistant-text", text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0) {
        // Persist NON-EMPTY thinking as its own turn (routed into the subagent thread too, via `added`),
        // so a reopened chat keeps the reasoning the transcript stored. Redacted ("") blocks are skipped.
        added.push({ kind: "thinking", text: block.thinking });
      } else if (block.type === "tool_use") {
        if (isAgentTool(block.name)) {
          const childId = String(block.id);
          seedSubagent(childId, block.input, parent);
          added.push({ kind: "subagent-ref", id: childId });
          sawAgentSpawn = true;
        } else if (parent === undefined && isAskUserTool(block.name)) {
          // AskUserQuestion → a persistent Q&A record (paired with its answer below), NOT a generic tool
          // cluster. Don't mark `active`: the separate `question` frame drives the "awaiting" wire live.
          added.push({ kind: "asked-question", id: String(block.id), questions: extractAskQuestions(block.input) });
        } else if (parent === undefined && isSendTool(block.name)) {
          // send_file/send_image → a clean attachment card (NOT raw MCP plumbing) so a reopened chat shows
          // the file/image the same way the live `attachment` frame does (that frame is deduped below).
          added.push(attachmentFromSend(String(block.id), String(block.name), block.input));
        } else {
          added.push({ kind: "tool-use", id: String(block.id), name: String(block.name), input: block.input });
          sawTool = true;
        }
      }
    }
    // Spawning a subagent (the Agent tool) means the turn is now actively running that tool — so the
    // wire reads "running-tool" (never idle) while agents are out, until the turn's `result` frame.
    const active = sawTool || sawAgentSpawn;
    if (parent !== undefined) {
      // A subagent's OWN inline message → route into its thread; don't touch the main wire/live text.
      appendThreadTurns(parent, added, { wire: active ? "running-tool" : undefined, clearLive: true });
      return next;
    }
    next.turns = [...view.turns, ...added];
    next.liveText = "";
    next.thinkingText = "";
    if (active) next.wireState = "running-tool";
    // CONTEXT METER numerator: this turn's per-turn usage IS the current context occupancy. Update
    // contextTokens here (NOT from the result, whose usage is cumulative); keep the contextWindow that a
    // `result` provides. Works live AND on reopen (the transcript's assistant lines carry message.usage).
    const ctxTokens = contextTokensFromUsage(ev.message?.usage);
    if (ctxTokens !== undefined) next.usage = { ...next.usage, contextTokens: ctxTokens };
    return next;
  }
  if (ev.type === "user") {
    const userEv = ev as UserMsg;
    const parent = ev.parentToolUseId;
    const content = userEv.message?.content;
    // Untrusted boundary: the object-block view of `content`, with junk entries (null / non-object) dropped
    // and a non-array content normalized to []. Reading `block.type` on a raw null would TypeError here (the
    // store has no try/catch around reduceFrame). The string-content path is handled separately below.
    const blocks0 = blockListOf<UserBlock>(content);
    // An INJECTED user-role message (skill content the Skill tool loaded, a <system-reminder>, command
    // output, or a background <task-notification>) — context for the model, NOT something the human
    // typed. It must never render as a "YOU" bubble (claude itself hides these). `isMeta` covers the
    // claude-flagged kinds (and, on reopen, harness-injected ones folded in by parseTranscript); an
    // `origin.kind` catches the harness-injected ones live, where the full raw is on the wire. Its
    // tool_result blocks, if any, are still processed below.
    const isMeta = userEv.raw?.isMeta === true || isInjectedOrigin(userEv.raw?.origin) || isInterruptNotice(content);
    // A SYNTHETIC system-injected user message (the post-compaction continuation seed is the dominant case),
    // NOT something the human typed. `isSynthetic` is the CANONICAL marker: the LIVE stream sets it, and the
    // server's resume boundary (transcript.ts) now normalizes the transcript's `isCompactSummary` INTO it —
    // so both render paths agree on one flag. `isCompactSummary` is kept ONLY as a back-compat fallback for
    // the OTHER reopen path (the session-hub slim raw still ships `isCompactSummary`, not normalized there).
    // It must never render as a "YOU" bubble; it becomes a clean, generic system note instead.
    const isSynthetic = userEv.raw?.isSynthetic === true || userEv.raw?.isCompactSummary === true;

    // A subagent's OWN inline message (its prompt turn, its tool_use's result) → route into its thread.
    // A tool_result whose tool_use_id is a known subagent id is THAT subagent's final result (captured
    // on the thread, never shown as a generic tool-result) — this also catches a depth-2 inner result
    // delivered into its OUTER parent's context.
    if (parent !== undefined) {
      const add: TurnItem[] = [];
      const textBlocks: ContentBlock[] = [];
      if (typeof content === "string") {
        if (content.length > 0) textBlocks.push({ type: "text", text: content });
      } else {
        for (const block of blocks0) {
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            textBlocks.push({ type: "text", text: block.text });
          }
        }
      }
      if (!isMeta && textBlocks.length > 0) add.push({ kind: "user", blocks: textBlocks });
      for (const block of blocks0) {
        if (block.type !== "tool_result") continue;
        const tuid = String(block.tool_use_id);
        if (next.subagents[tuid] !== undefined) {
          applySubagentResult(tuid, block);
          continue;
        }
        add.push({
          kind: "tool-result",
          toolUseId: tuid,
          content: block.content,
          ...(block.is_error === true ? { isError: true } : {}),
        });
      }
      if (add.length > 0) appendThreadTurns(parent, add);
      return next;
    }

    // A synthetic system-injected message → ONE clean, collapsible "system note" carrying its text, instead
    // of dumping the whole continuation summary as a giant "YOU" bubble. The post-compaction seed (manual
    // /compact OR auto-compaction, which has no /compact command envelope at all) is the dominant case; any
    // other synthetic system message renders the same generic way.
    if (isSynthetic) {
      const uuid = userEv.uuid ?? userEv.raw?.uuid;
      if (uuid !== undefined && view.seenUserUuids.has(uuid)) return next; // dedupe re-delivery
      const text =
        typeof content === "string"
          ? content
          : blocks0
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => (b as { text: string }).text)
              .join("\n");
      next.turns = [...view.turns, { kind: "system-note", text }];
      if (uuid !== undefined) next.seenUserUuids = new Set(view.seenUserUuids).add(uuid);
      next.compacting = false; // the seed IS the result → drop any in-flight "Compacting…" indicator
      return next;
    }

    // A slash command the human ran (e.g. `/compact`, `/model`). Its `<command-name>` envelope and
    // `<local-command-stdout>` output are NOT flagged isMeta, so without this they render as raw-XML "YOU"
    // bubbles. Surface the WHOLE class GENERICALLY as one clean command marker — no per-command special-
    // casing — so today's /compact and tomorrow's unknown command both render properly and stay visible
    // (never silently dropped); only the `<local-command-caveat>` boilerplate is hidden. The post-compaction
    // summary is handled separately above (its own system-note), so a /compact shows BOTH the note and this
    // marker. Skipped when isMeta already handles it.
    if (!isMeta && typeof content === "string") {
      const cmd = parseLocalCommand(content);
      if (cmd) {
        const uuid = userEv.uuid ?? userEv.raw?.uuid;
        if (uuid !== undefined && view.seenUserUuids.has(uuid)) return next; // dedupe re-delivery
        const last = view.turns[view.turns.length - 1];
        if (cmd.kind === "name") {
          next.turns = [...view.turns, { kind: "command", command: cmd.command }];
        } else if (cmd.kind === "stdout") {
          const turns = [...view.turns];
          if (last?.kind === "command" && last.output === undefined) {
            // fold the output into the command marker just emitted (one combined "/x · output" row).
            turns[turns.length - 1] = { ...last, output: cmd.output };
            next.turns = turns;
          } else if (cmd.output.length > 0) {
            // a bare stdout with no preceding command envelope (e.g. the LIVE "Compacted", which arrives
            // with no `<command-name>`) → its own clean marker, so it's shown rather than leaked as raw XML.
            next.turns = [...turns, { kind: "command", output: cmd.output }];
          }
        }
        if (uuid !== undefined) next.seenUserUuids = new Set(view.seenUserUuids).add(uuid);
        return next;
      }
    }

    const turns = [...view.turns];

    // A user turn's text. With `--replay-user-messages` claude now RE-EMITS each user message live as a
    // `{type:"user", uuid}` event (and also on resume from the transcript). That uuid IS the turn's
    // CHECKPOINT id (what REWIND targets). Three things must hold so a message shows EXACTLY ONCE and
    // carries its checkpointId:
    //   1. dedupe by uuid (a duplicate delivery / overlapping replay is a no-op);
    //   2. RECONCILE with the optimistic bubble: a live send appended an optimistic `user` turn (no
    //      checkpointId, appendUserMessage); the echo for the SAME text must NOT draw a second bubble —
    //      instead it stamps the checkpointId onto that existing turn;
    //   3. otherwise (resume replay, or no matching optimistic turn) append a fresh user turn carrying
    //      the checkpointId.
    // Collect the user turn's renderable blocks: text AND images. On reopen an uploaded screenshot is an
    // image block — a lazy `url` ref from the slim history payload (or inline base64 when no uuid existed
    // to ref it); keeping it here is what makes a reopened chat show the user's images, not drop them.
    const blocks: ContentBlock[] = [];
    if (typeof content === "string") {
      if (content.length > 0) blocks.push({ type: "text", text: content });
    } else {
      for (const block of blocks0) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          blocks.push({ type: "text", text: block.text });
        } else {
          const image = toImageBlock(block);
          if (image) blocks.push(image);
        }
      }
    }
    const uuid = userEv.uuid ?? userEv.raw?.uuid;
    const alreadySeen = uuid !== undefined && view.seenUserUuids.has(uuid);
    if (!isMeta && blocks.length > 0 && !alreadySeen) {
      const echoedText = textOf(blocks);
      // Reconcile against the OLDEST UNRECONCILED optimistic user bubble (no checkpointId) whose text
      // matches this echo — search FORWARD. The CLI replays user echoes in submission (FIFO) order, so
      // the first echo belongs to the first unreconciled bubble. (Searching from the END cross-wired the
      // checkpointIds of two identical-text sends, making REWIND target the wrong turn.)
      let reconciledIdx = -1;
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        if (t === undefined || t.kind !== "user") continue;
        if (t.checkpointId !== undefined) continue; // already reconciled — keep looking forward
        if (textOf(t.blocks) === echoedText) {
          reconciledIdx = i;
          break;
        }
      }
      if (reconciledIdx >= 0) {
        const existing = turns[reconciledIdx] as Extract<TurnItem, { kind: "user" }>;
        // The echo means the CLI is now PROCESSING this message — rebuild WITHOUT the `queued` flag so it
        // renders inline at its real position rather than below the live stream.
        turns[reconciledIdx] = { kind: "user", blocks: existing.blocks, checkpointId: uuid };
      } else {
        turns.push({ kind: "user", blocks, ...(uuid !== undefined ? { checkpointId: uuid } : {}) });
      }
      if (uuid !== undefined) next.seenUserUuids = new Set(view.seenUserUuids).add(uuid);
    }

    // tool_result blocks render as their own turns (unchanged from the live pipeline), EXCEPT a
    // tool_result whose tool_use_id == a known Agent id: that is a subagent's FINAL result, captured
    // on its thread (the SubagentCard) — never shown as a generic tool-result in the main chat.
    for (const block of blocks0) {
      if (block.type !== "tool_result") continue;
      const tuid = String(block.tool_use_id);
      if (next.subagents[tuid] !== undefined) {
        applySubagentResult(tuid, block);
        continue;
      }
      // An ask_user result is the user's ANSWER → attach it to the matching asked-question record
      // (which then renders as a clean Q&A card), never as a generic tool-result.
      const askIdx = turns.findIndex((t) => t.kind === "asked-question" && t.id === tuid);
      if (askIdx >= 0) {
        const aq = turns[askIdx] as Extract<TurnItem, { kind: "asked-question" }>;
        turns[askIdx] = { ...aq, answer: extractResultText(block.content) };
        continue;
      }
      // A send_file/send_image result ("Sent X to the user.") belongs to an attachment turn → suppress
      // it (the card already shows the file) so it doesn't surface as an orphan tool-result on reopen.
      if (turns.some((t) => t.kind === "attachment" && t.id === tuid)) continue;
      turns.push({
        kind: "tool-result",
        toolUseId: tuid,
        content: block.content,
        ...(block.is_error === true ? { isError: true } : {}),
      });
    }

    next.turns = turns;
    return next;
  }
  if (ev.type === "system") {
    // Subagent lifecycle (the AUTHORITATIVE source). Keyed off `task` fields; never touches main turns.
    const task = ev.task;
    if (task && ev.subtype) {
      if (ev.subtype === "task_started" && task.toolUseId) {
        const id = task.toolUseId;
        updateThread(id, (t) => ({
          ...t,
          taskId: task.taskId ?? t.taskId,
          type: t.type ?? task.subagentType,
          description: t.description ?? task.description,
          prompt: t.prompt ?? task.prompt,
          startedAt: t.startedAt ?? Date.now(),
        }));
        if (task.taskId) next.subagentTaskIndex = { ...next.subagentTaskIndex, [task.taskId]: id };
      } else if (ev.subtype === "task_progress" && task.toolUseId) {
        const id = task.toolUseId;
        updateThread(id, (t) => ({
          ...t,
          activity: task.description ?? t.activity,
          type: t.type ?? task.subagentType,
          usage: mergeUsage(t.usage, task.usage),
        }));
        if (task.taskId) next.subagentTaskIndex = { ...next.subagentTaskIndex, [task.taskId]: id };
      } else if (ev.subtype === "task_updated" && task.taskId) {
        // task_updated carries ONLY task_id → resolve the thread via the taskId→id map.
        const id = next.subagentTaskIndex[task.taskId];
        if (id !== undefined) {
          const status = mapTaskStatus(task.patch?.status);
          updateThread(id, (t) => ({
            ...t,
            status: status ?? t.status,
            endedAt: task.patch?.endTime ?? t.endedAt,
            wireState: status ? wireForStatus(status) : t.wireState,
          }));
        }
      } else if (ev.subtype === "task_notification") {
        const id = task.toolUseId ?? (task.taskId ? next.subagentTaskIndex[task.taskId] : undefined);
        if (id !== undefined) {
          const status = mapTaskStatus(task.status);
          updateThread(id, (t) => ({
            ...t,
            summary: task.summary ?? t.summary,
            status: status ?? t.status,
            usage: mergeUsage(t.usage, task.usage),
            wireState: status ? wireForStatus(status) : t.wireState,
          }));
        }
      }
      return next;
    }
    // The AUTHORITATIVE "Compacting…" signal. The CLI emits `system status:"compacting"` the moment a
    // /compact STARTS (then nothing for the seconds it summarizes), and a `status` carrying `compact_result`
    // when it ENDS. This fires for ANY trigger origin — a /compact from the web composer OR one typed in the
    // terminal — unlike the composer's optimistic flag (which only catches composer sends).
    if (ev.subtype === "status") {
      if (ev.status === "compacting") next.compacting = true;
      else if (ev.compactResult !== undefined) next.compacting = false;
      return next;
    }
    // A process (re)start (`system init`) carries NO active turn — the agent is idle, waiting for input.
    // The old code flipped idle→"thinking" here, which left a freshly-resumed / just-reconnected session
    // showing "working" forever with nothing running (and a stuck Stop button). And resuming a session
    // whose transcript ended MID-turn (a tool_use with no final result) would otherwise stay "running-
    // tool". So on init, reset the transient turn state to idle and drop any stale partial text from the
    // dead process; real turn frames (assistant/stream/tool/result) set the working state from here.
    if (ev.subtype === "init") {
      next.wireState = "idle";
      next.liveText = "";
      next.thinkingText = "";
      next.compacting = false; // a restart ends any in-flight /compact indicator
      // A fresh/resumed process has none of the OLD process's pending prompts — their requestIds belong
      // to the gone process, so clear them (the server also resolves them on respawn). Otherwise a stale
      // permission/question lingered after a resume and "answering" it hit a process that never issued it.
      next.pendingPermission = undefined;
      next.pendingQuestion = undefined;
      // Capture the session's REAL available slash commands so the composer offers them (not a hardcoded
      // list). init fires per turn, so this stays fresh; keep the prior list if an init omits it.
      if (ev.slashCommands !== undefined) next.commands = ev.slashCommands;
      // Capture the session's TOOL list (built-ins + mcp__server__tool) for the MCP visibility panel.
      // Kept fresh per init; the prior list is preserved if an init omits it.
      if (ev.tools !== undefined) next.tools = ev.tools;
    }
    return next;
  }
  return next;
}

/** Concatenate the text of a user turn's content blocks (used to match an echo to its optimistic bubble). */
function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
