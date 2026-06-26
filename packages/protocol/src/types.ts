/**
 * The subagent lifecycle fields surfaced from a `system` event whose `subtype` starts with `task_`
 * (`task_started` / `task_progress` / `task_updated` / `task_notification`). These are the
 * AUTHORITATIVE subagent lifecycle (the Agent/Task tool). Typed here so the web reads them directly
 * (never digging in `raw`).
 *
 * Keying: `toolUseId` == the Agent tool_use id == the children's `parentToolUseId` == the thread key.
 * `taskId` == the resume `agentId`. NOTE: `task_started` is the ONLY event carrying BOTH `taskId` and
 * `toolUseId`; `task_updated` carries ONLY `taskId` (no `toolUseId`) — so consumers must keep a
 * `taskId → toolUseId` map (seeded from `task_started`) to apply a `task_updated` status patch.
 */
export interface SystemTaskInfo {
  taskId?: string;
  toolUseId?: string;
  subagentType?: string;
  description?: string;
  prompt?: string;
  /** task_notification.status (e.g. "completed" | "failed"). */
  status?: string;
  summary?: string;
  /** task_updated.patch — a partial status update (carries no toolUseId). */
  patch?: { status?: string; endTime?: number };
  /** Normalized usage (from task_progress/task_notification `usage`). */
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  /** task_progress.last_tool_name — the subagent's most recent tool. */
  lastToolName?: string;
}

export interface SystemEvent {
  type: "system";
  subtype: string; // "init" | "status" | "thinking_tokens" | "task_started" | "task_progress" | ...
  sessionId?: string;
  // present when subtype === "init":
  model?: string;
  tools?: string[];
  cwd?: string;
  /** Available subagent types (from system/init `agents`), e.g. ["general-purpose","Explore",...]. */
  agents?: string[];
  /** present when subtype starts with `task_` — the subagent lifecycle, typed (see SystemTaskInfo). */
  task?: SystemTaskInfo;
  raw: unknown;
}
export interface StreamEvent {
  type: "stream_event";
  event: unknown;
  sessionId?: string;
  /** Top-level sibling of the message; `null`/absent for main, else the Agent tool_use id. Note: live
   * partial deltas carry NO parent linkage, so this is virtually always absent on stream_event. */
  parentToolUseId?: string;
  uuid?: string;
  raw: unknown;
}
export interface AssistantEvent {
  type: "assistant";
  message: unknown;
  sessionId?: string;
  /** Top-level sibling of `message` (NOT inside message.content). `null`/absent for main-agent
   * messages; equals the Agent tool_use id for that subagent's own inline messages. */
  parentToolUseId?: string;
  uuid?: string;
  raw: unknown;
}
export interface UserEvent {
  type: "user";
  message: unknown;
  sessionId?: string;
  /** Top-level sibling of `message`. `null`/absent for main; the Agent tool_use id for a subagent's
   * own inline prompt/tool_result messages. */
  parentToolUseId?: string;
  uuid?: string;
  raw: unknown;
}
export interface ResultEvent {
  type: "result";
  subtype?: string;
  isError?: boolean;
  result?: string;
  sessionId?: string;
  totalCostUsd?: number;
  /**
   * Token usage for the turn, normalized for the UI's context meter. `contextTokens` is how full the
   * model's context window now is — the whole prompt that was sent (input + cache-read + cache-creation)
   * plus this turn's output, i.e. what the next request will carry. `outputTokens` is just this turn's
   * generated tokens. `contextWindow` is the AUTHORITATIVE window size the CLI reports for the model in
   * `modelUsage` (e.g. 1_000_000 for a 1M variant) — the meter's denominator, so it never has to guess
   * from the model name. All omitted when the CLI doesn't report them.
   */
  usage?: { contextTokens?: number; outputTokens?: number; contextWindow?: number };
  permissionDenials?: unknown[];
  /**
   * How the turn terminated, when the CLI reports it. A user-initiated STOP (interrupt) ends the turn
   * with `terminal_reason:"aborted_streaming"` (and `subtype:"error_during_execution"`). Surfaced here
   * so the UI can render an aborted turn as a calm "Stopped" marker rather than a scary error.
   */
  terminalReason?: string;
  raw: unknown;
}
export interface ControlRequestEvent {
  type: "control_request";
  requestId: string; // top-level request_id
  subtype: string; // request.subtype: "hook_callback" | "can_use_tool" | ...
  request: Record<string, unknown>;
  raw: unknown;
}
export interface ControlResponseEvent {
  type: "control_response";
  requestId?: string; // response.request_id
  subtype?: string; // response.subtype: "success" | "error"
  response: Record<string, unknown>;
  raw: unknown;
}
export interface RateLimitEvent {
  type: "rate_limit_event";
  raw: unknown;
}
export interface UnknownEvent {
  type: "unknown";
  rawType?: string;
  raw: unknown;
}

export type InboundEvent =
  | SystemEvent
  | StreamEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | ControlRequestEvent
  | ControlResponseEvent
  | RateLimitEvent
  | UnknownEvent;

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export type ContentBlock = TextBlock | ImageBlock;

export type HookPermissionDecision = "allow" | "deny";
export type CanUseToolResult =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny" | "ask"; message: string };
