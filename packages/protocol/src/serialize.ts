import { randomUUID } from "node:crypto";
import type {
  CanUseToolResult,
  ContentBlock,
  ControlRequestEvent,
  HookPermissionDecision,
  ImageBlock,
} from "./types.js";

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

export function serializeHookPermissionResponse(
  requestId: string,
  decision: HookPermissionDecision,
  reason = "",
): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        async: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision,
          permissionDecisionReason: reason,
        },
      },
    },
  });
}

export function serializeCanUseToolResponse(requestId: string, result: CanUseToolResult): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: result },
  });
}

export function classifyPermissionRequest(
  ev: ControlRequestEvent,
): { kind: "hook_callback" | "can_use_tool"; toolName?: string; toolInput?: unknown; toolUseId?: string } | null {
  if (ev.subtype === "hook_callback") {
    const input = (ev.request.input ?? {}) as Record<string, unknown>;
    return {
      kind: "hook_callback",
      toolName: input.tool_name as string,
      toolInput: input.tool_input,
      toolUseId: input.tool_use_id as string,
    };
  }
  if (ev.subtype === "can_use_tool") {
    return {
      kind: "can_use_tool",
      toolName: ev.request.tool_name as string,
      toolInput: ev.request.input,
      toolUseId: ev.request.tool_use_id as string,
    };
  }
  return null;
}

export interface QuestionOption {
  label: string;
  description?: string;
  /** Optional concrete artifact to compare (ASCII mockup / code / config). Rendered monospace. */
  preview?: string;
}
export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/**
 * Detect an AskUserQuestion hook_callback (docs/protocol-notes.md §A). The questions live at
 * request.input.tool_input.questions[]. Returns null for any other tool / control subtype.
 */
export function classifyQuestionRequest(
  ev: ControlRequestEvent,
): { requestId: string; toolUseId?: string; toolInput: unknown; questions: QuestionSpec[] } | null {
  if (ev.subtype !== "hook_callback") return null;
  const input = (ev.request.input ?? {}) as Record<string, unknown>;
  if (input.tool_name !== "AskUserQuestion") return null;
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const questions: QuestionSpec[] = rawQuestions.map((q) => {
    const obj = (q ?? {}) as Record<string, unknown>;
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    return {
      question: typeof obj.question === "string" ? obj.question : "",
      header: typeof obj.header === "string" ? obj.header : undefined,
      multiSelect: obj.multiSelect === true,
      options: rawOptions.map((o) => {
        const oo = (o ?? {}) as Record<string, unknown>;
        return {
          label: typeof oo.label === "string" ? oo.label : "",
          description: typeof oo.description === "string" ? oo.description : undefined,
          preview: typeof oo.preview === "string" ? oo.preview : undefined,
        };
      }),
    };
  });
  return {
    requestId: ev.requestId,
    toolUseId: typeof ev.request.tool_use_id === "string" ? ev.request.tool_use_id : undefined,
    toolInput,
    questions,
  };
}

/**
 * Answer an AskUserQuestion: an allow control_response whose hookSpecificOutput.updatedInput
 * merges the chosen answers (question text -> chosen option label[s]) into the original tool input.
 * The model then runs the tool with the answers pre-filled (docs/protocol-notes.md §A).
 */
export function serializeHookQuestionAnswer(
  requestId: string,
  originalToolInput: unknown,
  answers: Record<string, string | string[]>,
  reason = "",
): string {
  const baseInput = (originalToolInput ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        async: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: reason,
          updatedInput: { ...baseInput, answers },
        },
      },
    },
  });
}

function controlRequest(request: Record<string, unknown>, requestId?: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId ?? `ctl-${randomUUID()}`, request });
}

/** Client -> CLI: switch the model for the live session (docs/protocol-notes.md control protocol). */
export function serializeSetModel(model: string, opts: { requestId?: string } = {}): string {
  return controlRequest({ subtype: "set_model", model }, opts.requestId);
}

/**
 * Client -> CLI: set the thinking-token budget (our "effort" maps onto this). `null` clears it.
 * The optional thinking_display controls how thinking renders ("summarized" | "omitted" | null).
 * VERIFIED field names against the real binary (docs/protocol-notes.md → "Live settings").
 */
export function serializeSetMaxThinkingTokens(
  maxThinkingTokens: number | null,
  opts: { requestId?: string; thinkingDisplay?: "summarized" | "omitted" | null } = {},
): string {
  const request: Record<string, unknown> = {
    subtype: "set_max_thinking_tokens",
    max_thinking_tokens: maxThinkingTokens,
  };
  if (opts.thinkingDisplay !== undefined) request.thinking_display = opts.thinkingDisplay;
  return controlRequest(request, opts.requestId);
}

/** Client -> CLI: change the permission mode (default | acceptEdits | bypassPermissions | plan | dontAsk | auto). */
export function serializeSetPermissionMode(mode: string, opts: { requestId?: string } = {}): string {
  return controlRequest({ subtype: "set_permission_mode", mode }, opts.requestId);
}

/**
 * Client -> CLI: interrupt (STOP) the current turn. LIVE-VALIDATED: sending an `interrupt` control_request
 * on the CLI's stdin aborts the in-flight turn — Claude stops mid-output, replies with a success
 * control_response, and the turn ends with a `result` whose subtype is `error_during_execution` and
 * `terminal_reason` is `aborted_streaming`. The session stays open for the next user message.
 */
export function serializeInterrupt(requestId?: string): string {
  return controlRequest({ subtype: "interrupt" }, requestId);
}

/**
 * Client -> CLI: rewind tracked FILES to their state at a checkpoint (a user-message uuid). LIVE-VALIDATED
 * against `claude` 2.1.187: with file checkpointing enabled (env `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`
 * on the spawned process), this `rewind_files` control_request restores Write/Edit/NotebookEdit changes made
 * AFTER the checkpoint — files CREATED after it are deleted, files MODIFIED after it are restored. Bash-made
 * changes are NOT tracked. It restores files ONLY, not the conversation. The CLI replies with a success
 * control_response whose `response` is `{ canRewind, error?, filesChanged?, insertions?, deletions? }`
 * (the @anthropic-ai/claude-agent-sdk `RewindFilesResult` shape), or `{ subtype:"error", error }` when
 * checkpointing wasn't enabled. The field names (`user_message_id`, `dry_run`) match the SDK's
 * `rewindFiles(e,t){ this.request({subtype:"rewind_files",user_message_id:e,dry_run:t?.dryRun}) }`.
 */
export function serializeRewindFiles(
  userMessageId: string,
  opts: { dryRun?: boolean; requestId?: string } = {},
): string {
  return controlRequest(
    { subtype: "rewind_files", user_message_id: userMessageId, dry_run: opts.dryRun ?? false },
    opts.requestId,
  );
}
