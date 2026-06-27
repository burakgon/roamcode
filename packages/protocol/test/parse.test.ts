import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseLine, ProtocolParseError, type InboundEvent } from "../src/index.js";
import { parseModelsFromInitResponse } from "../src/parse.js";

function loadFixture(name: string): InboundEvent[] {
  const path = fileURLToPath(new URL(`../fixtures/${name}.jsonl`, import.meta.url));
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => parseLine(l))
    .filter((e): e is InboundEvent => e !== null);
}
// CLI-emitted lines only (drop the fixture's outbound `_dir:"out"` lines).
function inbound(events: InboundEvent[]): InboundEvent[] {
  return events.filter((e) => (e.raw as { _dir?: string })._dir !== "out");
}

test("blank lines return null", () => {
  expect(parseLine("")).toBeNull();
  expect(parseLine("   ")).toBeNull();
});

test("invalid JSON throws ProtocolParseError", () => {
  expect(() => parseLine("{nope")).toThrow(ProtocolParseError);
});

test("parses system/init with session and model", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "s1",
    model: "claude-opus-4-8[1m]",
    tools: ["Bash"],
    cwd: "/w",
  });
  expect(parseLine(line)).toMatchObject({
    type: "system",
    subtype: "init",
    sessionId: "s1",
    model: "claude-opus-4-8[1m]",
    cwd: "/w",
  });
});

test("surfaces the compaction status signal: status:'compacting' (start) and compact_result (end)", () => {
  // The CLI emits these on the live stream-json stdout during /compact — the authoritative signal the
  // web uses to show "Compacting…" (start) and to clear it (end), for ANY trigger origin.
  const start = JSON.stringify({ type: "system", subtype: "status", status: "compacting", session_id: "s1" });
  expect(parseLine(start)).toMatchObject({ type: "system", subtype: "status", status: "compacting" });
  const end = JSON.stringify({ type: "system", subtype: "status", compact_result: "success", session_id: "s1" });
  expect(parseLine(end)).toMatchObject({ type: "system", subtype: "status", compactResult: "success" });
});

test("parses a hook_callback control_request: requestId top-level, subtype from request", () => {
  const line = JSON.stringify({
    type: "control_request",
    request_id: "r1",
    request: { subtype: "hook_callback", callback_id: "hook_0", input: { tool_name: "Write" } },
  });
  expect(parseLine(line)).toMatchObject({ type: "control_request", requestId: "r1", subtype: "hook_callback" });
});

test("parses a control_response: requestId + subtype nested under response", () => {
  const line = JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: "r1", response: { ok: true } },
  });
  expect(parseLine(line)).toMatchObject({ type: "control_response", requestId: "r1", subtype: "success" });
});

test("parses an aborted (interrupted) result: terminalReason + error subtype carried through", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
    session_id: "s1",
  });
  expect(parseLine(line)).toMatchObject({
    type: "result",
    subtype: "error_during_execution",
    isError: true,
    terminalReason: "aborted_streaming",
  });
});

test("result usage: contextTokens sums input + cache-read + cache-creation + output", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "s1",
    total_cost_usd: 0.04,
    usage: {
      input_tokens: 1200,
      cache_read_input_tokens: 80000,
      cache_creation_input_tokens: 5000,
      output_tokens: 600,
    },
  });
  expect(parseLine(line)).toMatchObject({
    type: "result",
    usage: { contextTokens: 86800, outputTokens: 600 },
  });
});

test("result usage: contextWindow is taken from modelUsage (authoritative 1M window)", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "s1",
    usage: { input_tokens: 250000, output_tokens: 600 },
    modelUsage: {
      "claude-opus-4-8[1m]": { inputTokens: 250000, contextWindow: 1000000, maxOutputTokens: 64000 },
    },
  });
  expect(parseLine(line)).toMatchObject({
    type: "result",
    usage: { contextTokens: 250600, contextWindow: 1000000 },
  });
});

test("result usage: contextWindow is the max across modelUsage entries (main model, not a smaller subagent)", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "s1",
    usage: { input_tokens: 1000, output_tokens: 10 },
    modelUsage: {
      "claude-opus-4-8[1m]": { contextWindow: 1000000 },
      "claude-haiku-4-5": { contextWindow: 200000 },
    },
  });
  expect(parseLine(line)).toMatchObject({ type: "result", usage: { contextWindow: 1000000 } });
});

test("result usage: contextWindow prefers the result's OWN model over a larger subagent model", () => {
  // The MAIN conversation is 200k; a subagent ran a 1M model. The meter must use the MAIN model's window
  // (200k), not the max — else a 1M subagent would deflate the main conversation's fill %.
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "s1",
    model: "claude-opus-4-8",
    usage: { input_tokens: 1000, output_tokens: 10 },
    modelUsage: {
      "claude-opus-4-8": { contextWindow: 200000 },
      "some-1m-subagent": { contextWindow: 1000000 },
    },
  });
  expect(parseLine(line)).toMatchObject({ type: "result", usage: { contextWindow: 200000 } });
});

test("result usage: contextWindow omitted when modelUsage is absent (heuristic fallback in UI)", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "s1",
    usage: { input_tokens: 1200, output_tokens: 600 },
  });
  const ev = parseLine(line) as { usage?: { contextWindow?: number } };
  expect(ev.usage?.contextWindow).toBeUndefined();
});

test("result without usage omits the usage field", () => {
  const ev = parseLine(JSON.stringify({ type: "result", subtype: "success", session_id: "s1" }));
  expect(ev?.type).toBe("result");
  expect((ev as { usage?: unknown }).usage).toBeUndefined();
});

test("unknown type becomes UnknownEvent and keeps raw", () => {
  const ev = parseLine(JSON.stringify({ type: "brand_new", x: 1 }));
  expect(ev?.type).toBe("unknown");
  expect((ev as { raw: { x: number } }).raw.x).toBe(1);
});

test("golden: simple-turn parses; has system/init and a result; no permission request", () => {
  const cli = inbound(loadFixture("simple-turn"));
  expect(cli.some((e) => e.type === "system" && (e as { subtype: string }).subtype === "init")).toBe(true);
  expect(cli.some((e) => e.type === "result")).toBe(true);
  expect(cli.some((e) => e.type === "control_request")).toBe(false);
});

test("golden: permission-turn has a hook_callback control_request and a result", () => {
  const cli = inbound(loadFixture("permission-turn"));
  expect(cli.some((e) => e.type === "control_request" && (e as { subtype: string }).subtype === "hook_callback")).toBe(
    true,
  );
  expect(cli.some((e) => e.type === "result")).toBe(true);
});

// --- subagent linkage + task lifecycle (the Agent tool) -----------------------

test("lifts parent_tool_use_id + uuid onto assistant/user/stream_event", () => {
  const a = parseLine(
    JSON.stringify({ type: "assistant", message: { content: [] }, parent_tool_use_id: "X", uuid: "a1" }),
  );
  expect(a).toMatchObject({ type: "assistant", parentToolUseId: "X", uuid: "a1" });
  const u = parseLine(JSON.stringify({ type: "user", message: { content: [] }, parent_tool_use_id: "X", uuid: "u1" }));
  expect(u).toMatchObject({ type: "user", parentToolUseId: "X", uuid: "u1" });
  const s = parseLine(JSON.stringify({ type: "stream_event", event: {}, parent_tool_use_id: null }));
  expect(s).toMatchObject({ type: "stream_event", parentToolUseId: undefined });
});

test("parses system/init agents (available subagent types)", () => {
  const ev = parseLine(
    JSON.stringify({ type: "system", subtype: "init", agents: ["general-purpose", "Explore", "Plan"] }),
  );
  expect(ev).toMatchObject({ type: "system", subtype: "init", agents: ["general-purpose", "Explore", "Plan"] });
});

test("surfaces typed task fields for a task_started (taskId + toolUseId + type/description/prompt)", () => {
  const ev = parseLine(
    JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "toolu_X",
      subagent_type: "general-purpose",
      description: "Run echo command",
      prompt: "echo hello",
    }),
  );
  expect(ev).toMatchObject({
    type: "system",
    subtype: "task_started",
    task: {
      taskId: "task-1",
      toolUseId: "toolu_X",
      subagentType: "general-purpose",
      description: "Run echo command",
      prompt: "echo hello",
    },
  });
});

test("task_updated carries ONLY task_id + patch.status (no tool_use_id)", () => {
  const ev = parseLine(
    JSON.stringify({
      type: "system",
      subtype: "task_updated",
      task_id: "task-1",
      patch: { status: "completed", end_time: 123 },
    }),
  );
  expect(ev).toMatchObject({
    type: "system",
    subtype: "task_updated",
    task: { taskId: "task-1", patch: { status: "completed", endTime: 123 } },
  });
  expect((ev as { task: { toolUseId?: string } }).task.toolUseId).toBeUndefined();
});

test("normalizes task usage (total_tokens/tool_uses/duration_ms → totalTokens/toolUses/durationMs)", () => {
  const ev = parseLine(
    JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      tool_use_id: "toolu_X",
      status: "completed",
      summary: "did it",
      usage: { total_tokens: 11389, tool_uses: 1, duration_ms: 4111 },
    }),
  );
  expect(ev).toMatchObject({
    type: "system",
    subtype: "task_notification",
    task: { status: "completed", summary: "did it", usage: { totalTokens: 11389, toolUses: 1, durationMs: 4111 } },
  });
});

test("golden: subagent-turn has a task_started, the Agent tool_use, and inline children tagged parent=Agent id", () => {
  const cli = inbound(loadFixture("subagent-turn"));
  const started = cli.find((e) => e.type === "system" && (e as { subtype: string }).subtype === "task_started");
  expect(started).toBeDefined();
  const agentId = (started as { task: { toolUseId?: string } }).task.toolUseId;
  expect(agentId).toBeTruthy();
  // The spawning Agent tool_use is present with that id.
  const spawn = cli.find(
    (e) =>
      e.type === "assistant" &&
      Array.isArray((e as { message?: { content?: unknown[] } }).message?.content) &&
      (e as { message: { content: Array<{ name?: string; id?: string }> } }).message.content.some(
        (b) => b.name === "Agent" && b.id === agentId,
      ),
  );
  expect(spawn).toBeDefined();
  // At least one inline child message is tagged parent_tool_use_id == the Agent id.
  expect(cli.some((e) => (e as { parentToolUseId?: string }).parentToolUseId === agentId)).toBe(true);
});

test("golden: subagent-nested has the inner Agent tool_use inline under the outer (parent = outer id)", () => {
  const cli = inbound(loadFixture("subagent-nested"));
  // An assistant message with a non-null parentToolUseId whose content has an Agent tool_use = the nested spawn.
  const innerSpawn = cli.find(
    (e) =>
      e.type === "assistant" &&
      (e as { parentToolUseId?: string }).parentToolUseId !== undefined &&
      Array.isArray((e as { message?: { content?: unknown[] } }).message?.content) &&
      (e as { message: { content: Array<{ name?: string }> } }).message.content.some((b) => b.name === "Agent"),
  );
  expect(innerSpawn).toBeDefined();
});

test("parseModelsFromInitResponse: extracts value/displayName/description, skips malformed", () => {
  const payload = {
    models: [
      { value: "default", displayName: "Default (recommended)", description: "Opus 4.8 with 1M context" },
      { value: "opus[1m]", displayName: "Opus" },
      { displayName: "no value — skipped" },
      "garbage",
    ],
  };
  expect(parseModelsFromInitResponse(payload)).toEqual([
    { value: "default", displayName: "Default (recommended)", description: "Opus 4.8 with 1M context" },
    { value: "opus[1m]", displayName: "Opus" },
  ]);
});

test("parseModelsFromInitResponse: reads nested .response.models (control-response inner shape)", () => {
  const ctrlInner = {
    request_id: "init-1",
    subtype: "success",
    response: { models: [{ value: "sonnet", displayName: "Sonnet" }] },
  };
  expect(parseModelsFromInitResponse(ctrlInner)).toEqual([{ value: "sonnet", displayName: "Sonnet" }]);
});

test("parseModelsFromInitResponse: absent/garbage → []", () => {
  expect(parseModelsFromInitResponse(undefined)).toEqual([]);
  expect(parseModelsFromInitResponse({})).toEqual([]);
  expect(parseModelsFromInitResponse({ models: "nope" })).toEqual([]);
});
