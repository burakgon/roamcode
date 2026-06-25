#!/usr/bin/env node
// Deterministic interactive mock of `claude` over stream-json stdio.
// Speaks the protocol from docs/protocol-notes.md so tests never need the real binary.
// Mode via env MOCK_MODE: "simple" (default) | "permission" | "question" | "resume" | "stderr".
import { stdin, stdout, env } from "node:process";

const MODE = env.MOCK_MODE ?? "simple";
const SESSION_ID = "mock-session";
const TOOL_USE_ID = "toolu_mock_0001";

function send(obj) {
  stdout.write(JSON.stringify(obj) + "\n");
}

function emitInitResponse(requestId) {
  // control_response: request_id + subtype nested under `response`; payload at response.response.
  send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { models: [], commands: [], account: { subscriptionType: "Mock" } },
    },
  });
  send({
    type: "system",
    subtype: "init",
    cwd: "/mock/cwd",
    session_id: SESSION_ID,
    tools: ["Write", "Read", "Bash"],
    model: "claude-mock",
    permissionMode: "default",
    apiKeySource: "none",
  });
}

// A pending "simple turn" result timer. The simple turn streams text immediately, then settles its
// success `result` on a short timer — so an `interrupt` arriving right after the user message can
// PREEMPT it (cancel the pending success and emit the aborted result instead). This removes a timing
// race in the interrupt test where the success result could otherwise win.
let pendingSimpleResult = null;

function emitSimpleTurn() {
  send({
    type: "stream_event",
    event: { type: "message_start", message: { role: "assistant", content: [] } },
    session_id: SESSION_ID,
  });
  send({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    session_id: SESSION_ID,
  });
  send({
    type: "assistant",
    message: { role: "assistant", model: "claude-mock", content: [{ type: "text", text: "Hello" }] },
    session_id: SESSION_ID,
  });
  pendingSimpleResult = setTimeout(() => {
    pendingSimpleResult = null;
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Hello",
      session_id: SESSION_ID,
      total_cost_usd: 0,
      permission_denials: [],
    });
  }, 25);
}

function emitWarmupThenReady() {
  // Mimic --resume: a synthetic warm-up user turn + assistant reply the daemon must suppress.
  send({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] },
    session_id: SESSION_ID,
  });
  send({
    type: "assistant",
    message: { role: "assistant", model: "claude-mock", content: [{ type: "text", text: "No response requested." }] },
    session_id: SESSION_ID,
  });
}

function emitToolUseAndPermissionRequest() {
  send({
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-mock",
      content: [
        {
          type: "tool_use",
          id: TOOL_USE_ID,
          name: "Write",
          input: { file_path: "/mock/cwd/spike.txt", content: "hello\n" },
        },
      ],
    },
    session_id: SESSION_ID,
  });
  // hook_callback control_request: request_id top-level; tool info under request.input.
  send({
    type: "control_request",
    request_id: "perm-req-0001",
    request: {
      subtype: "hook_callback",
      callback_id: "hook_0",
      tool_use_id: TOOL_USE_ID,
      input: {
        session_id: SESSION_ID,
        cwd: "/mock/cwd",
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/mock/cwd/spike.txt", content: "hello\n" },
        tool_use_id: TOOL_USE_ID,
      },
    },
  });
}

function emitPermissionResult(decision) {
  if (decision === "allow") {
    send({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: TOOL_USE_ID,
            content: "File created successfully at: /mock/cwd/spike.txt",
          },
        ],
      },
      session_id: SESSION_ID,
    });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Created spike.txt",
      session_id: SESSION_ID,
      total_cost_usd: 0,
      permission_denials: [],
    });
  } else {
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Write was blocked",
      session_id: SESSION_ID,
      total_cost_usd: 0,
      permission_denials: [
        { tool_name: "Write", tool_use_id: TOOL_USE_ID, tool_input: { file_path: "/mock/cwd/spike.txt" } },
      ],
    });
  }
}

function emitQuestionRequest() {
  send({
    type: "control_request",
    request_id: "q-req-0001",
    request: {
      subtype: "hook_callback",
      callback_id: "hook_0",
      tool_use_id: "toolu_q_0001",
      input: {
        session_id: SESSION_ID,
        cwd: "/mock/cwd",
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Which language?",
              header: "Language",
              multiSelect: false,
              options: [
                { label: "TypeScript", description: "TS" },
                { label: "Python", description: "Py" },
              ],
            },
          ],
        },
        tool_use_id: "toolu_q_0001",
      },
    },
  });
}

function emitQuestionResult(answers) {
  const picked = answers?.["Which language?"] ?? "(none)";
  send({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_q_0001", content: `Selected: ${picked}` }],
    },
    session_id: SESSION_ID,
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `You picked ${picked}`,
    session_id: SESSION_ID,
    total_cost_usd: 0,
    permission_denials: [],
  });
}

let buffer = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore malformed input
    }
    handle(msg);
  }
});
stdin.on("end", () => process.exit(0));

function handle(msg) {
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    emitInitResponse(msg.request_id);
    if (MODE === "resume") emitWarmupThenReady();
    if (MODE === "stderr") {
      process.stderr.write("auth expired → re-login on the host\n");
    }
    if (MODE === "echo-env") {
      // Echo the rewind-enable env var so a test can assert the daemon set it on the child.
      process.stderr.write(`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=${env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING}\n`);
    }
    return;
  }
  if (
    msg.type === "control_request" &&
    ["set_model", "set_max_thinking_tokens", "set_permission_mode"].includes(msg.request?.subtype)
  ) {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: msg.request_id, response: { ok: true } },
    });
    return;
  }
  if (msg.type === "control_request" && msg.request?.subtype === "rewind_files") {
    // LIVE-VALIDATED rewind_files: with checkpointing enabled the CLI replies with a success
    // control_response whose inner `response` is the RewindFilesResult (`{ canRewind: true }`).
    // MOCK_MODE=rewind-disabled simulates checkpointing being OFF (the error branch).
    if (MODE === "rewind-disabled") {
      send({
        type: "control_response",
        response: { subtype: "error", request_id: msg.request_id, error: "File rewinding is not enabled." },
      });
      return;
    }
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: msg.request_id,
        response: { canRewind: true, filesChanged: ["/mock/cwd/spike.txt"], insertions: 0, deletions: 1 },
      },
    });
    return;
  }
  if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    // LIVE-VALIDATED interrupt: ack with a success control_response, then end the turn with a `result`
    // whose subtype is error_during_execution and terminal_reason is aborted_streaming.
    // Preempt any pending simple-turn success so the aborted result is the one that lands.
    if (pendingSimpleResult) {
      clearTimeout(pendingSimpleResult);
      pendingSimpleResult = null;
    }
    send({
      type: "control_response",
      response: { subtype: "success", request_id: msg.request_id, response: { ok: true } },
    });
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      result: "Interrupted by user",
      session_id: SESSION_ID,
      total_cost_usd: 0,
      permission_denials: [],
    });
    return;
  }
  if (msg.type === "user") {
    if (MODE === "permission") emitToolUseAndPermissionRequest();
    else if (MODE === "question") emitQuestionRequest();
    else emitSimpleTurn();
    return;
  }
  if (msg.type === "control_response") {
    const out = msg.response?.response?.hookSpecificOutput;
    const decision = out?.permissionDecision;
    if (out?.updatedInput?.answers) {
      emitQuestionResult(out.updatedInput.answers);
      return;
    }
    emitPermissionResult(decision === "allow" ? "allow" : "deny");
    return;
  }
  // anything else: ignore
}
