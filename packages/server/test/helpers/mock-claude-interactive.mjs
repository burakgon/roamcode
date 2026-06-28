#!/usr/bin/env node
// Deterministic interactive mock of `claude` over stream-json stdio.
// Speaks the protocol from docs/protocol-notes.md so tests never need the real binary.
// Mode via env MOCK_MODE: "simple" (default) | "permission" | "question" | "resume" | "stderr".
import { stdin, stdout, env } from "node:process";

const MODE = env.MOCK_MODE ?? "simple";
const SESSION_ID = "mock-session";
const TOOL_USE_ID = "toolu_mock_0001";

// START-FAILURE modes (for the actionable first-run-error mapping): the process spawns OK but never
// completes the initialize handshake, modelling an installed-but-broken/unauthenticated `claude`. These
// exit WITHOUT ever installing the stdin handler below, so the initialize handshake is never answered.
//  - "exit-before-init": exit immediately, before any init response (the "exited before the handshake" path).
//  - "auth-fail":        write an auth-looking stderr line, THEN exit before init (the not-authenticated path).
if (MODE === "exit-before-init") {
  process.exit(1);
}
if (MODE === "auth-fail") {
  // Write the auth line and exit only AFTER it has flushed to the parent, so the startup-stderr capture
  // sees it. We never register the stdin handler (guarded below), so init is never answered.
  process.stderr.write("Invalid API key · Please run `claude login` to authenticate\n", () => process.exit(1));
}

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

let userEchoSeq = 0;
function emitUserEcho(msg) {
  // Mirror --replay-user-messages: echo the submitted message back as a `{type:"user", uuid}` event, the
  // uuid being the per-turn checkpoint id. The daemon serializes a user send as `{type:"user", message:
  // {role:"user", content:[...]}}` (serialize.ts), so replay the SAME `message.content` verbatim — exactly
  // what the real CLI re-emits — and the frame-reducer folds it into the user bubble + checkpointId.
  const content = msg.message?.content ?? "";
  send({
    type: "user",
    uuid: `mock-checkpoint-${++userEchoSeq}`,
    message: { role: "user", content },
    session_id: SESSION_ID,
  });
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

// START-FAILURE modes already exited above (auth-fail exits in the stderr-flush callback). Only register
// the stdin handler for the normal modes so a failure mode never answers the initialize handshake.
let buffer = "";
if (MODE !== "auth-fail") {
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
}

function handle(msg) {
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    // "hang": spawn OK but NEVER answer the initialize handshake — models a claude stuck (e.g. on an
    // interactive auth wall) so start() times out. Used to assert the init-timeout → CLAUDE_START_FAILED map.
    if (MODE === "hang") return;
    emitInitResponse(msg.request_id);
    if (MODE === "resume") emitWarmupThenReady();
    if (MODE === "stderr") {
      process.stderr.write("auth expired → re-login on the host\n");
    }
    if (MODE === "echo-env") {
      // Echo the rewind-enable env var so a test can assert the daemon set it on the child.
      process.stderr.write(
        `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=${env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING}\n`,
      );
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
    // --replay-user-messages parity: the REAL CLI (launched with that flag, see config.ts) re-emits each
    // submitted user message as a `{type:"user", uuid}` event — the uuid being the per-turn checkpoint id.
    // The frame-reducer folds THAT echo into the user bubble (+ checkpointId). Opt-in via MOCK_REPLAY_USER
    // so existing tests, which assert exact frame sequences, keep the mock's prior behavior byte-identical;
    // only the true-E2E reducer test enables it to exercise the full faithful path.
    if (env.MOCK_REPLAY_USER) emitUserEcho(msg);
    if (MODE === "permission") emitToolUseAndPermissionRequest();
    else if (MODE === "question") emitQuestionRequest();
    // "silent": accept the message but emit NOTHING (no echo, no result) — models the early-turn window
    // where the process is busy spinning up / thinking before any frame is streamed back. Used to verify
    // the server's `turnInFlight` makes a reopen show "working" even when the buffer has no turn frames.
    else if (MODE === "silent") return;
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
