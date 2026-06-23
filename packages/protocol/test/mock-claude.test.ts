import { expect, test } from "vitest";
import { replayFixture } from "../src/index.js";

test("replayFixture emits CLI lines in order, skipping outbound and stripping _dir", async () => {
  const fixture = [
    JSON.stringify({ _dir: "out", type: "control_request", request: { subtype: "initialize" } }),
    JSON.stringify({ type: "control_response", response: { subtype: "success" } }),
    JSON.stringify({ _dir: "out", type: "user", message: { role: "user", content: [] } }),
    "",
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ].join("\n");

  const out: string[] = [];
  await replayFixture(fixture, (line) => out.push(line), { delayMs: 0 });

  expect(out).toHaveLength(3); // control_response, system/init, result — the two _dir:"out" and the blank dropped
  for (const line of out) expect(JSON.parse(line)._dir).toBeUndefined();
  expect(JSON.parse(out[0]!).type).toBe("control_response");
  expect(JSON.parse(out[1]!)).toMatchObject({ type: "system", subtype: "init" });
  expect(JSON.parse(out[2]!).type).toBe("result");
});
