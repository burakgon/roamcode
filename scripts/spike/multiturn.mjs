// Multi-turn spike for remote-coder Plan 3.
//
// ONE architecture question: does the REAL `claude` binary, in bidirectional
// stream-json mode, process a SECOND user message in the SAME process when we
// KEEP stdin open after the first `result` — or does each process only handle
// one turn?
//
// Adapted from drive.mjs. The crucial difference: on the FIRST `result` we do
// NOT close stdin. Instead we send user message 2 and wait for a SECOND
// `result` on the same process.
//
//   1. Send `initialize` control_request (registers a PreToolUse hook so a
//      tool-using turn could be answered — but the core question uses math
//      prompts with no tools, so no permission round-trip is needed).
//   2. On the init `control_response`: send user message 1 ("What is 2+2?…").
//   3. On the FIRST `result`: WITHOUT closing stdin, send user message 2
//      ("Now what is 3+3?…").
//   4. On the SECOND `result`: success — keep-alive multi-turn works. Close
//      stdin and exit.
//
// Math prompts (no tools) so the core question needs no permission round-trip.
//
// Usage:
//   node multiturn.mjs <out.jsonl>
//
// Run from a THROWAWAY temp dir, never the repo. Subscription auth only.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { argv, env } from "node:process";
import { randomUUID } from "node:crypto";

const outPath = argv[2] ?? "multiturn-out.jsonl";
const out = createWriteStream(outPath, { flags: "w" });

const PROMPT_1 = "What is 2+2? Reply with just the number.";
const PROMPT_2 = "Now what is 3+3? Just the number.";

// Console-only progress banner (never written to the fixture file).
function banner(s) {
  process.stdout.write(s);
}
// Record an outbound message we send to the CLI, as a pure JSON line in the
// fixture, tagged with `_dir:"out"` so direction is recoverable.
function record(obj) {
  out.write(JSON.stringify({ _dir: "out", ...obj }) + "\n");
}

// Subscription auth only: never pass an API key.
const childEnv = { ...env };
delete childEnv.ANTHROPIC_API_KEY;

const child = spawn(
  "claude",
  [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--permission-mode", "default",
    "--session-id", randomUUID(),
  ],
  { cwd: process.cwd(), env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
);

// Hard safety timeout: kill the child if anything hangs.
const KILL_AFTER_MS = 150_000;
const killTimer = setTimeout(() => {
  banner(`\n>>> SAFETY TIMEOUT ${KILL_AFTER_MS}ms — killing child\n`);
  finish("safety-timeout");
}, KILL_AFTER_MS);

// Per-turn watchdog: after sending user message 2, give it up to ~90s.
let turn2Timer = null;

function write(obj) {
  record(obj);
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function hookAllow(requestId) {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        async: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "spike auto-allow",
        },
      },
    },
  };
}

let buf = "";
let userSent = false;
let resultCount = 0;
const answeredHooks = new Set();
let done = false;

function finish(why) {
  if (done) return;
  done = true;
  banner(`\n>>> FINISH (${why}); closing stdin\n`);
  clearTimeout(killTimer);
  if (turn2Timer) clearTimeout(turn2Timer);
  try { child.stdin.end(); } catch { /* already closed */ }
  // If the child doesn't exit on its own shortly, force it.
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
}

function sendUser(text, label) {
  const userMsg = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
  banner(`\n>>> SENDING ${label}:\n${JSON.stringify(userMsg)}\n`);
  write(userMsg);
}

child.stdout.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  out.write(text);
  process.stdout.write(text);
  buf += text;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    // Reply to our initialize handshake → send user message 1.
    if (msg.type === "control_response" && !userSent) {
      userSent = true;
      sendUser(PROMPT_1, "user message 1 (2+2)");
      continue;
    }

    // Defensive: answer any hook_callback (math turns shouldn't trigger one).
    if (msg.type === "control_request") {
      const reqId = msg.request_id ?? msg.id;
      const sub = msg.request?.subtype;
      if (sub === "hook_callback" && !answeredHooks.has(reqId)) {
        answeredHooks.add(reqId);
        const tool = msg.request?.input?.tool_name ?? "?";
        banner(`\n>>> SENDING control_response (hook allow, tool=${tool}, reqId=${reqId})\n`);
        write(hookAllow(reqId));
      } else {
        banner(`\n>>> OBSERVED control_request subtype=${sub} (not answered)\n`);
      }
    }

    if (msg.type === "result") {
      resultCount += 1;
      banner(`\n>>> RESULT #${resultCount} subtype=${msg.subtype} session_id=${msg.session_id} result=${JSON.stringify(msg.result)}\n`);
      if (resultCount === 1) {
        // KEY: do NOT close stdin. Send turn 2 on the SAME process.
        banner(`\n>>> Turn 1 done. KEEPING stdin OPEN; sending turn 2 in 500ms…\n`);
        setTimeout(() => {
          sendUser(PROMPT_2, "user message 2 (3+3)");
          turn2Timer = setTimeout(() => {
            banner(`\n>>> NO SECOND RESULT within 90s of sending turn 2 — keep-alive appears NOT viable\n`);
            finish("turn2-timeout");
          }, 90_000);
        }, 500);
      } else if (resultCount >= 2) {
        banner(`\n>>> SECOND RESULT arrived on the SAME process — keep-alive VIABLE\n`);
        finish("got-turn2");
      }
    }
  }
});

child.stderr.on("data", (c) => process.stderr.write(c));
child.on("exit", (code, signal) => {
  clearTimeout(killTimer);
  if (turn2Timer) clearTimeout(turn2Timer);
  out.end();
  process.stderr.write(`\n[child exit code=${code} signal=${signal} resultCount=${resultCount}]\n`);
  // Note for the operator: an exit BEFORE resultCount>=2 means the process did
  // not stay alive for turn 2.
  process.exitCode = 0;
});

// Step 1: send the initialize control handshake (register PreToolUse hook).
const initReq = {
  type: "control_request",
  request_id: `init-${randomUUID()}`,
  request: { subtype: "initialize", hooks: { PreToolUse: [{ matcher: "", hookCallbackIds: ["hook_0"] }] } },
};
banner(`>>> SENDING initialize control_request:\n${JSON.stringify(initReq)}\n`);
write(initReq);
