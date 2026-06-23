import { expect, test } from "vitest";
import { encodeProjectDir, parseTranscript } from "../src/index.js";

test("encodeProjectDir maps every non-alphanumeric char to a dash (lossy)", () => {
  expect(encodeProjectDir("/private/tmp/rc-spike5")).toBe("-private-tmp-rc-spike5");
  expect(encodeProjectDir("/Users/u/Developer/remote-coder")).toBe("-Users-u-Developer-remote-coder");
  expect(encodeProjectDir("/a/magicplay.io")).toBe("-a-magicplay-io"); // the dot collapses to a dash
});

test("parseTranscript keeps user/assistant turns in file order and drops bookkeeping", () => {
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] }, uuid: "u1", parentUuid: null }),
    JSON.stringify({ type: "queue-operation", foo: 1 }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] }, uuid: "a1", parentUuid: "u1" }),
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
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "No response requested." }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "real" }] } }),
  ].join("\n");
  const turns = parseTranscript(lines);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.type).toBe("user");
});
