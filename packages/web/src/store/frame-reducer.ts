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
  | { kind: "user"; blocks: ContentBlock[]; checkpointId?: string; queued?: boolean }
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-use"; id: string; name: string; input: unknown }
  | { kind: "tool-result"; toolUseId: string; content: unknown }
  // A SUBAGENT anchor: where an `Agent`/`Task` tool_use spawned a subagent. Renders as a SubagentCard
  // (in the main chat, or inside a parent subagent's transcript for a nested spawn) — NOT a generic
  // tool-use cluster. `id` is the Agent tool_use id == the SubagentThread key.
  | { kind: "subagent-ref"; id: string }
  // An AskUserQuestion (the `mcp__remote-coder__ask_user` MCP tool) the model asked. LIVE it's driven by
  // a transient `question` frame → the interactive iris card; this turn is the PERSISTENT record (it's in
  // the transcript, the question frame isn't) so a reopened chat shows a clean Q&A instead of raw MCP tool
  // plumbing. `answer` is filled from the paired tool_result; the card renders only once it has one.
  | { kind: "asked-question"; id: string; questions: AskedQuestion[]; answer?: string }
  | { kind: "result"; result?: string; isError?: boolean; totalCostUsd?: number; stopped?: boolean }
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
}
interface AssistantMsg {
  message?: { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }> };
  /** Top-level sibling of `message`: the Agent tool_use id when this is a subagent's own message. */
  parentToolUseId?: string;
}
interface UserMsg {
  message?: {
    content?:
      | string
      | Array<{ type?: string; tool_use_id?: string; content?: unknown; text?: string; is_error?: boolean }>;
  };
  parentToolUseId?: string;
  /** Present on transcript-replayed lines (parseLine passes the raw line through); used to dedupe. */
  uuid?: string;
  /** The full raw claude line. `isMeta` flags an INJECTED user-role message (skill content loaded by the
   * Skill tool, a `<system-reminder>`, command output) rather than something the human typed — these
   * must NOT render as a "YOU" turn. `origin.kind` is set by the harness on messages IT injected (e.g. a
   * background `task-notification`); a human message has no `origin`. The LIVE wire ships the full raw
   * (so `origin` is present here); on reopen the server folds the same signal into `isMeta`. */
  raw?: { uuid?: string; isMeta?: boolean; origin?: { kind?: string } };
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
    // A user-initiated STOP (interrupt) ends the turn with terminal_reason "aborted_streaming" (and
    // subtype "error_during_execution"). That is NOT a real error — render it as a calm "Stopped"
    // marker and return the wire to idle (so the user can type the next message), never the red error.
    const stopped = r.terminalReason === "aborted_streaming" || r.subtype === "error_during_execution";
    next.lastResult = r;
    next.pendingPermission = undefined;
    next.pendingQuestion = undefined;
    next.liveText = "";
    next.thinkingText = "";
    next.wireState = stopped ? "idle" : r.isError ? "error" : "success";
    next.turns = [
      ...view.turns,
      { kind: "result", result: r.result, isError: r.isError, totalCostUsd: r.totalCostUsd, stopped },
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
    const inner = (ev as { event?: DeltaEvent }).event;
    // Subagent partial deltas carry no parent linkage in practice, but route defensively if one ever does.
    const parent = ev.parentToolUseId;
    if (inner?.type === "content_block_delta" && inner.delta) {
      if (inner.delta.type === "text_delta" && inner.delta.text) {
        if (parent !== undefined) {
          updateThread(parent, (t) => ({ ...t, liveText: t.liveText + inner.delta!.text, wireState: "streaming" }));
        } else {
          next.liveText = view.liveText + inner.delta.text;
          next.wireState = "streaming";
        }
      } else if (inner.delta.type === "thinking_delta" && inner.delta.thinking) {
        if (parent !== undefined) {
          updateThread(parent, (t) => ({
            ...t,
            thinkingText: t.thinkingText + inner.delta!.thinking,
            wireState: "thinking",
          }));
        } else {
          next.thinkingText = view.thinkingText + inner.delta.thinking;
          next.wireState = "thinking";
        }
      }
    }
    return next;
  }
  if (ev.type === "assistant") {
    const parent = ev.parentToolUseId;
    const content = ev.message?.content ?? [];
    // Build the turns for this message. Each `Agent`/`Task` tool_use becomes a `subagent-ref` anchor
    // (a card) + a seeded thread, INSTEAD of a generic tool-use cluster. A nested Agent tool_use (one
    // whose own message has a parent) creates a CHILD thread (parentId = that parent).
    const added: TurnItem[] = [];
    let sawTool = false;
    let sawAgentSpawn = false;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        added.push({ kind: "assistant-text", text: block.text });
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
    return next;
  }
  if (ev.type === "user") {
    const userEv = ev as UserMsg;
    const parent = ev.parentToolUseId;
    const content = userEv.message?.content;
    // An INJECTED user-role message (skill content the Skill tool loaded, a <system-reminder>, command
    // output, or a background <task-notification>) — context for the model, NOT something the human
    // typed. It must never render as a "YOU" bubble (claude itself hides these). `isMeta` covers the
    // claude-flagged kinds (and, on reopen, harness-injected ones folded in by parseTranscript); an
    // `origin.kind` catches the harness-injected ones live, where the full raw is on the wire. Its
    // tool_result blocks, if any, are still processed below.
    const isMeta = userEv.raw?.isMeta === true || isInjectedOrigin(userEv.raw?.origin);

    // A subagent's OWN inline message (its prompt turn, its tool_use's result) → route into its thread.
    // A tool_result whose tool_use_id is a known subagent id is THAT subagent's final result (captured
    // on the thread, never shown as a generic tool-result) — this also catches a depth-2 inner result
    // delivered into its OUTER parent's context.
    if (parent !== undefined) {
      const add: TurnItem[] = [];
      const textBlocks: ContentBlock[] = [];
      if (typeof content === "string") {
        if (content.length > 0) textBlocks.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            textBlocks.push({ type: "text", text: block.text });
          }
        }
      }
      if (!isMeta && textBlocks.length > 0) add.push({ kind: "user", blocks: textBlocks });
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const tuid = String(block.tool_use_id);
          if (next.subagents[tuid] !== undefined) {
            applySubagentResult(tuid, block);
            continue;
          }
          add.push({ kind: "tool-result", toolUseId: tuid, content: block.content });
        }
      }
      if (add.length > 0) appendThreadTurns(parent, add);
      return next;
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
    const textBlocks: ContentBlock[] = [];
    if (typeof content === "string") {
      if (content.length > 0) textBlocks.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          textBlocks.push({ type: "text", text: block.text });
        }
      }
    }
    const uuid = userEv.uuid ?? userEv.raw?.uuid;
    const alreadySeen = uuid !== undefined && view.seenUserUuids.has(uuid);
    if (!isMeta && textBlocks.length > 0 && !alreadySeen) {
      const echoedText = textOf(textBlocks);
      // Reconcile against the most recent UNRECONCILED optimistic user bubble (no checkpointId) whose
      // text matches this echo — search from the end so the newest optimistic send is the one stamped.
      let reconciledIdx = -1;
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (t === undefined || t.kind !== "user") continue;
        if (t.checkpointId !== undefined) continue; // already reconciled — keep looking back
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
        turns.push({ kind: "user", blocks: textBlocks, ...(uuid !== undefined ? { checkpointId: uuid } : {}) });
      }
      if (uuid !== undefined) next.seenUserUuids = new Set(view.seenUserUuids).add(uuid);
    }

    // tool_result blocks render as their own turns (unchanged from the live pipeline), EXCEPT a
    // tool_result whose tool_use_id == a known Agent id: that is a subagent's FINAL result, captured
    // on its thread (the SubagentCard) — never shown as a generic tool-result in the main chat.
    if (Array.isArray(content)) {
      for (const block of content) {
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
        turns.push({ kind: "tool-result", toolUseId: tuid, content: block.content });
      }
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
      // A fresh/resumed process has none of the OLD process's pending prompts — their requestIds belong
      // to the gone process, so clear them (the server also resolves them on respawn). Otherwise a stale
      // permission/question lingered after a resume and "answering" it hit a process that never issued it.
      next.pendingPermission = undefined;
      next.pendingQuestion = undefined;
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
