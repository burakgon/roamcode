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
