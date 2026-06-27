import { describe, it, expect } from "vitest";
import { ClaudeProcess } from "../src/claude-process";

describe("ClaudeProcess init models capture", () => {
  it("captures the models array from an init control_response line", () => {
    const proc = new ClaudeProcess({ claudeBin: "claude", cwd: "/tmp", sessionId: "s1" });
    expect(proc.models).toEqual([]);
    const line = JSON.stringify({
      type: "control_response",
      response: {
        request_id: "init-s1",
        subtype: "success",
        response: { models: [{ value: "opus[1m]", displayName: "Opus", description: "Opus 4.8" }] },
      },
    });
    proc.ingestLineForTest(line);
    expect(proc.models).toEqual([{ value: "opus[1m]", displayName: "Opus", description: "Opus 4.8" }]);
  });
});
