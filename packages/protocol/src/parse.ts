import type { InboundEvent, ModelInfo, SystemTaskInfo } from "./types.js";

export class ProtocolParseError extends Error {
  constructor(
    message: string,
    readonly line: string,
  ) {
    super(message);
    this.name = "ProtocolParseError";
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/** The MAIN model's `contextWindow` for the UI meter denominator. `modelUsage` is keyed by model id and
 *  may include SUBAGENT models too, so prefer the entry for the result's own `model` id when present; only
 *  if that's missing fall back to the max across entries (a smaller subagent never shrinks the window, and
 *  a larger subagent can't inflate it past the main model). Undefined when no entry reports a window. */
const contextWindowFromUsage = (modelUsage: Record<string, unknown>, mainModel?: string): number | undefined => {
  if (mainModel !== undefined) {
    const own = num(rec(modelUsage[mainModel]).contextWindow);
    if (own !== undefined) return own;
  }
  let max: number | undefined;
  for (const entry of Object.values(modelUsage)) {
    const w = num(rec(entry).contextWindow);
    if (w !== undefined && (max === undefined || w > max)) max = w;
  }
  return max;
};

/** Extract the subagent lifecycle fields from a `system` `task_*` event into the typed SystemTaskInfo. */
function parseTaskInfo(obj: Record<string, unknown>): SystemTaskInfo {
  const usageRaw = rec(obj.usage);
  const usage =
    obj.usage !== undefined
      ? {
          totalTokens: num(usageRaw.total_tokens),
          toolUses: num(usageRaw.tool_uses),
          durationMs: num(usageRaw.duration_ms),
        }
      : undefined;
  const patchRaw = rec(obj.patch);
  const patch = obj.patch !== undefined ? { status: str(patchRaw.status), endTime: num(patchRaw.end_time) } : undefined;
  return {
    taskId: str(obj.task_id),
    toolUseId: str(obj.tool_use_id),
    subagentType: str(obj.subagent_type),
    description: str(obj.description),
    prompt: str(obj.prompt),
    status: str(obj.status),
    summary: str(obj.summary),
    lastToolName: str(obj.last_tool_name),
    ...(patch ? { patch } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Extract the selectable model list from the CLI's `initialize` control-response payload. Accepts either
 *  the payload object (has `.models`) or the control-response inner (`.response.models`). Defensive: skips
 *  entries missing `value`/`displayName`; returns [] for absent/garbage input (old CLIs, parse failures). */
export function parseModelsFromInitResponse(input: unknown): ModelInfo[] {
  const root = rec(input);
  const raw = Array.isArray(root.models)
    ? root.models
    : Array.isArray(rec(root.response).models)
      ? (rec(root.response).models as unknown[])
      : null;
  if (!raw) return [];
  const out: ModelInfo[] = [];
  for (const entry of raw) {
    const r = rec(entry);
    const value = str(r.value);
    const displayName = str(r.displayName);
    if (value === undefined || displayName === undefined) continue;
    const description = str(r.description);
    out.push(description !== undefined ? { value, displayName, description } : { value, displayName });
  }
  return out;
}

export function parseLine(line: string): InboundEvent | null {
  if (!line.trim()) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch (err) {
    throw new ProtocolParseError(`invalid JSON: ${(err as Error).message}`, line);
  }
  switch (str(obj.type)) {
    case "system": {
      const subtype = str(obj.subtype) ?? "";
      return {
        type: "system",
        subtype,
        sessionId: str(obj.session_id),
        model: str(obj.model),
        tools: Array.isArray(obj.tools) ? (obj.tools as string[]) : undefined,
        cwd: str(obj.cwd),
        agents: Array.isArray(obj.agents) ? (obj.agents as string[]) : undefined,
        // The session's available slash commands (custom skills, plugin + project commands, built-ins) so
        // the composer can offer the REAL per-session menu, not a hardcoded list. Names only (no `/`).
        slashCommands: Array.isArray(obj.slash_commands) ? (obj.slash_commands as string[]) : undefined,
        // Subagent lifecycle: surface the task_* fields typed so the web never digs in `raw`.
        ...(subtype.startsWith("task_") ? { task: parseTaskInfo(obj) } : {}),
        // Compaction signal (subtype "status"): `status:"compacting"` starts a /compact, a status carrying
        // `compact_result` ends it. Surfaced typed so the reducer drives "Compacting…" without digging raw.
        status: str(obj.status),
        compactResult: str(obj.compact_result),
        raw: obj,
      };
    }
    case "stream_event":
      return {
        type: "stream_event",
        event: obj.event,
        sessionId: str(obj.session_id),
        parentToolUseId: str(obj.parent_tool_use_id),
        uuid: str(obj.uuid),
        raw: obj,
      };
    case "assistant":
      return {
        type: "assistant",
        message: obj.message,
        sessionId: str(obj.session_id),
        parentToolUseId: str(obj.parent_tool_use_id),
        uuid: str(obj.uuid),
        raw: obj,
      };
    case "user":
      return {
        type: "user",
        message: obj.message,
        sessionId: str(obj.session_id),
        parentToolUseId: str(obj.parent_tool_use_id),
        uuid: str(obj.uuid),
        raw: obj,
      };
    case "result": {
      // Context-window fill for the UI meter: the whole prompt that was sent (fresh input + cached reads
      // + cache writes) plus this turn's output ≈ what the next request will carry. Cached tokens still
      // occupy the window, so they count. 0 → omit (the CLI didn't report usage).
      const u = rec(obj.usage);
      const contextTokens =
        (num(u.input_tokens) ?? 0) +
        (num(u.cache_read_input_tokens) ?? 0) +
        (num(u.cache_creation_input_tokens) ?? 0) +
        (num(u.output_tokens) ?? 0);
      // The AUTHORITATIVE context-window denominator for the UI meter. The CLI reports the real window
      // per model in `modelUsage` (e.g. a 1M-context variant → `contextWindow:1000000`), so the meter
      // must use THIS rather than guessing from the model NAME — a session can run a 1M model while its
      // stored model string carries no `[1m]` marker (left "default"), which made the meter divide by
      // 200k and pin to a false "full". Take the MAX across entries so a smaller subagent model never
      // shrinks the main conversation's window. Absent → omit; the UI falls back to a name heuristic.
      const contextWindow = contextWindowFromUsage(rec(obj.modelUsage), str(obj.model));
      return {
        type: "result",
        subtype: str(obj.subtype),
        isError: typeof obj.is_error === "boolean" ? obj.is_error : undefined,
        result: str(obj.result),
        sessionId: str(obj.session_id),
        totalCostUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        ...(contextTokens > 0
          ? {
              usage: {
                contextTokens,
                outputTokens: num(u.output_tokens),
                ...(contextWindow !== undefined ? { contextWindow } : {}),
              },
            }
          : {}),
        permissionDenials: Array.isArray(obj.permission_denials) ? obj.permission_denials : undefined,
        terminalReason: str(obj.terminal_reason),
        raw: obj,
      };
    }
    case "control_request": {
      const request = rec(obj.request);
      return {
        type: "control_request",
        requestId: str(obj.request_id) ?? "",
        subtype: str(request.subtype) ?? "",
        request,
        raw: obj,
      };
    }
    case "control_response": {
      const response = rec(obj.response);
      return {
        type: "control_response",
        requestId: str(response.request_id),
        subtype: str(response.subtype),
        response,
        raw: obj,
      };
    }
    case "rate_limit_event":
      return { type: "rate_limit_event", raw: obj };
    default:
      return { type: "unknown", rawType: str(obj.type), raw: obj };
  }
}
