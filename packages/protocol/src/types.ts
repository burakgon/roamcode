export interface SystemEvent {
  type: "system";
  subtype: string; // "init" | "status" | "thinking_tokens" | "hook_started" | "hook_response" | ...
  sessionId?: string;
  // present when subtype === "init":
  model?: string;
  tools?: string[];
  cwd?: string;
  raw: unknown;
}
export interface StreamEvent { type: "stream_event"; event: unknown; sessionId?: string; raw: unknown; }
export interface AssistantEvent { type: "assistant"; message: unknown; sessionId?: string; raw: unknown; }
export interface UserEvent { type: "user"; message: unknown; sessionId?: string; raw: unknown; }
export interface ResultEvent {
  type: "result";
  subtype?: string;
  isError?: boolean;
  result?: string;
  sessionId?: string;
  totalCostUsd?: number;
  permissionDenials?: unknown[];
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
export interface RateLimitEvent { type: "rate_limit_event"; raw: unknown; }
export interface UnknownEvent { type: "unknown"; rawType?: string; raw: unknown; }

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

export interface TextBlock { type: "text"; text: string; }
export interface ImageBlock { type: "image"; source: { type: "base64"; media_type: string; data: string }; }
export type ContentBlock = TextBlock | ImageBlock;

export type HookPermissionDecision = "allow" | "deny";
export type CanUseToolResult =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny" | "ask"; message: string };
