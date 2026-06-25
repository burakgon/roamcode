import type { InboundEvent, SystemTaskInfo } from "./types.js";

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
  const patch =
    obj.patch !== undefined ? { status: str(patchRaw.status), endTime: num(patchRaw.end_time) } : undefined;
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
        // Subagent lifecycle: surface the task_* fields typed so the web never digs in `raw`.
        ...(subtype.startsWith("task_") ? { task: parseTaskInfo(obj) } : {}),
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
    case "result":
      return {
        type: "result",
        subtype: str(obj.subtype),
        isError: typeof obj.is_error === "boolean" ? obj.is_error : undefined,
        result: str(obj.result),
        sessionId: str(obj.session_id),
        totalCostUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        permissionDenials: Array.isArray(obj.permission_denials) ? obj.permission_denials : undefined,
        terminalReason: str(obj.terminal_reason),
        raw: obj,
      };
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
