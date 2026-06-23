import type { ContentBlock, DiagnosticPayload, PermissionPayload, ResultPayload, ServerFrame } from "../types/server";
import type { LiveWireState } from "../ui/LiveWire";

export type TurnItem =
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-use"; id: string; name: string; input: unknown }
  | { kind: "tool-result"; toolUseId: string; content: unknown }
  | { kind: "user"; blocks: ContentBlock[] }
  | { kind: "result"; result?: string; isError?: boolean; totalCostUsd?: number };

export interface SessionView {
  liveText: string;
  thinkingText: string;
  turns: TurnItem[];
  pendingPermission?: PermissionPayload;
  lastResult?: ResultPayload;
  diagnostics: DiagnosticPayload[];
  wireState: LiveWireState;
  lastSeq: number;
}

export function emptyView(): SessionView {
  return { liveText: "", thinkingText: "", turns: [], diagnostics: [], wireState: "idle", lastSeq: 0 };
}

interface DeltaEvent { type?: string; index?: number; delta?: { type?: string; text?: string; thinking?: string; partial_json?: string } }
interface AssistantMsg { message?: { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }> } }
interface UserMsg { message?: { content?: Array<{ type?: string; tool_use_id?: string; content?: unknown }> } }

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
    next.lastResult = r;
    next.pendingPermission = undefined;
    next.liveText = "";
    next.thinkingText = "";
    next.wireState = r.isError ? "error" : "success";
    next.turns = [...view.turns, { kind: "result", result: r.result, isError: r.isError, totalCostUsd: r.totalCostUsd }];
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
    const content = ev.message?.content ?? [];
    const turns = [...view.turns];
    for (const block of content) {
      if (block.type === "tool_result") {
        turns.push({ kind: "tool-result", toolUseId: String(block.tool_use_id), content: block.content });
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
