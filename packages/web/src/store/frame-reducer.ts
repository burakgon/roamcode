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

export type TurnItem =
  // A user message. `checkpointId` is its turn's user-message uuid (from --replay-user-messages) — the id
  // the UI offers REWIND on. It's absent on the optimistic bubble until the live `user` echo reconciles it.
  | { kind: "user"; blocks: ContentBlock[]; checkpointId?: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-use"; id: string; name: string; input: unknown }
  | { kind: "tool-result"; toolUseId: string; content: unknown }
  | { kind: "result"; result?: string; isError?: boolean; totalCostUsd?: number; stopped?: boolean }
  | { kind: "attachment"; id: string; path: string; name: string; caption?: string; isImage: boolean }
  // The "↩ Rewound to here" marker appended after a rewind. For conversation/both the thread above is
  // truncated to the checkpoint before this marker is added.
  | { kind: "rewound"; checkpointId: string; mode: "code" | "conversation" | "both"; ok: boolean; error?: string };

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
    seenUserUuids: new Set(),
  };
}

interface DeltaEvent {
  type?: string;
  index?: number;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
}
interface AssistantMsg {
  message?: { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }> };
}
interface UserMsg {
  message?: { content?: string | Array<{ type?: string; tool_use_id?: string; content?: unknown; text?: string }> };
  /** Present on transcript-replayed lines (parseLine passes the raw line through); used to dedupe. */
  uuid?: string;
  raw?: { uuid?: string };
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
    turns.push({ kind: "rewound", checkpointId: r.checkpointId, mode: r.mode, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    next.turns = turns;
    return next;
  }
  if (frame.kind === "exit") {
    next.wireState = "error";
    return next;
  }

  // kind === "event": an InboundEvent
  const ev = frame.payload as { type?: string } & DeltaEvent & AssistantMsg & UserMsg;
  if (ev.type === "stream_event") {
    const inner = (ev as { event?: DeltaEvent }).event;
    if (inner?.type === "content_block_delta" && inner.delta) {
      if (inner.delta.type === "text_delta" && inner.delta.text) {
        next.liveText = view.liveText + inner.delta.text;
        next.wireState = "streaming";
      } else if (inner.delta.type === "thinking_delta" && inner.delta.thinking) {
        next.thinkingText = view.thinkingText + inner.delta.thinking;
        next.wireState = "thinking";
      }
    }
    return next;
  }
  if (ev.type === "assistant") {
    const content = ev.message?.content ?? [];
    const turns = [...view.turns];
    let sawTool = false;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        turns.push({ kind: "assistant-text", text: block.text });
      } else if (block.type === "tool_use") {
        turns.push({ kind: "tool-use", id: String(block.id), name: String(block.name), input: block.input });
        sawTool = true;
      }
    }
    next.turns = turns;
    next.liveText = "";
    next.thinkingText = "";
    if (sawTool) next.wireState = "running-tool";
    return next;
  }
  if (ev.type === "user") {
    const userEv = ev as UserMsg;
    const content = userEv.message?.content;
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
    if (textBlocks.length > 0 && !alreadySeen) {
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
        turns[reconciledIdx] = { ...existing, checkpointId: uuid };
      } else {
        turns.push({ kind: "user", blocks: textBlocks, ...(uuid !== undefined ? { checkpointId: uuid } : {}) });
      }
      if (uuid !== undefined) next.seenUserUuids = new Set(view.seenUserUuids).add(uuid);
    }

    // tool_result blocks render as their own turns (unchanged from the live pipeline).
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          turns.push({ kind: "tool-result", toolUseId: String(block.tool_use_id), content: block.content });
        }
      }
    }

    next.turns = turns;
    return next;
  }
  if (ev.type === "system") {
    // init/status — no turn content; keep the view as-is (live link is alive).
    if (next.wireState === "idle") next.wireState = "thinking";
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
