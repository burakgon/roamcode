import { randomUUID } from "node:crypto";
import type { CanUseToolResult, ContentBlock, ControlRequestEvent, HookPermissionDecision, ImageBlock } from "./types.js";

export function buildImageBlock(mediaType: string, base64Data: string): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };
}

export function serializeUserMessage(content: string | ContentBlock[]): string {
  const blocks: ContentBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return JSON.stringify({ type: "user", message: { role: "user", content: blocks } });
}

export function serializeInitialize(opts: { requestId?: string; hookCallbackId?: string } = {}): string {
  const requestId = opts.requestId ?? `init-${randomUUID()}`;
  const hookCallbackId = opts.hookCallbackId ?? "hook_0";
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "initialize", hooks: { PreToolUse: [{ matcher: "", hookCallbackIds: [hookCallbackId] }] } },
  });
}

export function serializeHookPermissionResponse(requestId: string, decision: HookPermissionDecision, reason = ""): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { async: false, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } },
    },
  });
}

export function serializeCanUseToolResponse(requestId: string, result: CanUseToolResult): string {
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: result } });
}

export function classifyPermissionRequest(
  ev: ControlRequestEvent,
): { kind: "hook_callback" | "can_use_tool"; toolName?: string; toolInput?: unknown; toolUseId?: string } | null {
  if (ev.subtype === "hook_callback") {
    const input = (ev.request.input ?? {}) as Record<string, unknown>;
    return { kind: "hook_callback", toolName: input.tool_name as string, toolInput: input.tool_input, toolUseId: input.tool_use_id as string };
  }
  if (ev.subtype === "can_use_tool") {
    return { kind: "can_use_tool", toolName: ev.request.tool_name as string, toolInput: ev.request.input, toolUseId: ev.request.tool_use_id as string };
  }
  return null;
}
