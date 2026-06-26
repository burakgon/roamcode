import { expect, test } from "vitest";
import { encodeProjectDir, parseTranscript } from "../src/index.js";

test("encodeProjectDir maps every non-alphanumeric char to a dash (lossy)", () => {
  expect(encodeProjectDir("/private/tmp/rc-spike5")).toBe("-private-tmp-rc-spike5");
  expect(encodeProjectDir("/Users/u/Developer/remote-coder")).toBe("-Users-u-Developer-remote-coder");
  expect(encodeProjectDir("/a/magicplay.io")).toBe("-a-magicplay-io"); // the dot collapses to a dash
});

test("encodeProjectDir does NOT truncate/hash very long cwds (documented Plan-6 limitation)", () => {
  // Claude's real encoder truncates an over-long encoded name and appends a base36 hash; this
  // implementation does NOT. We pin that documented behavior: a long cwd produces the plain,
  // full-length dash substitution (one-to-one length, no `-<hash>` suffix). For such a deep path
  // the computed projects/<dir> may diverge from Claude's, so history can read empty (see the
  // function doc-comment + docs/protocol-notes.md).
  const deep = "/Users/somebody/" + "really-long-segment/".repeat(20) + "project";
  const encoded = encodeProjectDir(deep);
  // Pure substitution: same length, only [A-Za-z0-9] and '-' survive, nothing truncated/hashed.
  expect(encoded.length).toBe(deep.length);
  expect(encoded).toMatch(/^[A-Za-z0-9-]+$/);
  expect(encoded).toBe(deep.replace(/[^a-zA-Z0-9]/g, "-"));
});

test("parseTranscript keeps user/assistant turns in file order and drops bookkeeping", () => {
  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
      uuid: "u1",
      parentUuid: null,
    }),
    JSON.stringify({ type: "queue-operation", foo: 1 }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      uuid: "a1",
      parentUuid: "u1",
    }),
    JSON.stringify({ type: "attachment" }),
    "", // blank line tolerated
    "{ not json", // malformed line tolerated (skipped)
  ].join("\n");
  const turns = parseTranscript(lines);
  expect(turns.map((t) => t.type)).toEqual(["user", "assistant"]);
  expect(turns[0]?.uuid).toBe("u1");
  expect(turns[1]?.parentUuid).toBe("u1");
});

test("parseTranscript carries isMeta so replayed history can skip injected (skill) user lines", () => {
  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "skill content" }] },
      uuid: "m1",
      isMeta: true,
    }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "typed" }] }, uuid: "u1" }),
  ].join("\n");
  const turns = parseTranscript(lines);
  expect(turns).toHaveLength(2);
  expect(turns[0]?.isMeta).toBe(true); // injected line flagged → client renders it as meta, not "YOU"
  expect(turns[1]?.isMeta).toBeUndefined(); // a normal typed line is not meta
});

test("parseTranscript folds a harness-injected origin (task-notification) into isMeta — not a 'YOU' turn", () => {
  const lines = [
    // A background task-notification: injected by the harness as a plain user line. It carries NO
    // `isMeta` but an `origin.kind`; a human line has no `origin`.
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "<task-notification><task-id>x</task-id></task-notification>" },
      uuid: "tn1",
      origin: { kind: "task-notification" },
    }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "typed" }] }, uuid: "u1" }),
  ].join("\n");
  const turns = parseTranscript(lines);
  expect(turns).toHaveLength(2);
  expect(turns[0]?.isMeta).toBe(true); // origin-tagged injection → meta, never a "YOU" bubble on reopen
  expect(turns[1]?.isMeta).toBeUndefined(); // a human message has no origin → stays a real "YOU" turn
});

test("parseTranscript carries parent_tool_use_id (subagent linkage) with a sidechain fallback", () => {
  const lines = [
    // A subagent's own line with an explicit parent_tool_use_id (the Agent tool_use id).
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "sub work" }] },
      uuid: "s1",
      parent_tool_use_id: "ag1",
    }),
    // A sidechain line MISSING parent_tool_use_id → falls back to its agentId (so it still routes off main).
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "sidechain" }] },
      uuid: "s2",
      isSidechain: true,
      agentId: "agent-xyz",
    }),
    // A normal main line → no parent linkage.
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "main" }] }, uuid: "m1" }),
  ].join("\n");
  const turns = parseTranscript(lines);
  expect(turns[0]?.parentToolUseId).toBe("ag1");
  expect(turns[1]?.parentToolUseId).toBe("agent-xyz"); // sidechain fallback → never leaks into main
  expect(turns[2]?.parentToolUseId).toBeUndefined();
});

test("parseTranscript drops the synthetic --resume warm-up pair", () => {
  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
    }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "real" }] } }),
  ].join("\n");
  const turns = parseTranscript(lines);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.type).toBe("user");
});
