import { describe, expect, it } from "vitest";
import { planRender, parseToolResult, summarizeToolInput, isMetaTool } from "./tool-cluster";
import type { TurnItem } from "../store/frame-reducer";

describe("isMetaTool", () => {
  it("flags ToolSearch and mcp__ tools as meta", () => {
    expect(isMetaTool("ToolSearch")).toBe(true);
    expect(isMetaTool("mcp__send_file")).toBe(true);
    expect(isMetaTool("Bash")).toBe(false);
    expect(isMetaTool("Read")).toBe(false);
  });
});

describe("summarizeToolInput", () => {
  it("prefers command, then file_path/path/etc.", () => {
    expect(summarizeToolInput({ command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolInput({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolInput({ path: "/x" })).toBe("/x");
    expect(summarizeToolInput({ query: "select:send_file" })).toBe("select:send_file");
  });
  it("returns empty string when nothing summarizable", () => {
    expect(summarizeToolInput({})).toBe("");
    expect(summarizeToolInput(null)).toBe("");
  });
});

describe("parseToolResult", () => {
  it("extracts the human text as the summary and keeps the full JSON as raw", () => {
    const content = [{ type: "text", text: "Sent untitled.wav (4.8 MB) to the chat." }];
    const r = parseToolResult(content);
    expect(r.summary).toBe("Sent untitled.wav (4.8 MB) to the chat.");
    // The raw payload preserves the ENTIRE structure (the previously-leaking JSON).
    expect(r.raw).toContain('"type": "text"');
    expect(r.raw).toContain("Sent untitled.wav");
    expect(r.isError).toBe(false);
  });

  it("handles a bare string result", () => {
    const r = parseToolResult("file written");
    expect(r.summary).toBe("file written");
    expect(r.raw).toBe("file written");
  });

  it("uses the first non-empty line for a multi-line result", () => {
    const r = parseToolResult("\n\nfirst line\nsecond line");
    expect(r.summary).toBe("first line");
  });

  it("detects an error result", () => {
    expect(parseToolResult({ is_error: true, content: "boom" }).isError).toBe(true);
  });

  it("truncates a very long summary but keeps the raw intact", () => {
    const long = "x".repeat(300);
    const r = parseToolResult(long);
    expect(r.summary.length).toBeLessThanOrEqual(118);
    expect(r.summary.endsWith("…")).toBe(true);
    expect(r.raw).toBe(long);
  });
});

describe("planRender — grouping tool plumbing into clusters", () => {
  it("keeps assistant/user/result turns standalone", () => {
    const turns: TurnItem[] = [
      { kind: "user", blocks: [{ type: "text", text: "hi" }] },
      { kind: "assistant-text", text: "hello" },
      { kind: "result", result: "done", isError: false },
    ];
    const plan = planRender(turns);
    expect(plan.map((n) => n.kind)).toEqual(["turn", "turn", "turn"]);
  });

  it("folds a contiguous run of tool-use + tool-result into ONE cluster, pairing by id", () => {
    const turns: TurnItem[] = [
      { kind: "assistant-text", text: "working" },
      { kind: "tool-use", id: "t1", name: "Bash", input: { command: "ls" } },
      { kind: "tool-result", toolUseId: "t1", content: "a\nb" },
      { kind: "tool-use", id: "t2", name: "Read", input: { file_path: "/x.ts" } },
      { kind: "tool-result", toolUseId: "t2", content: "contents" },
      { kind: "assistant-text", text: "done" },
    ];
    const plan = planRender(turns);
    expect(plan.map((n) => n.kind)).toEqual(["turn", "cluster", "turn"]);
    const cluster = plan[1];
    if (cluster.kind !== "cluster") throw new Error("expected cluster");
    expect(cluster.steps).toHaveLength(2);
    expect(cluster.steps[0].use.name).toBe("Bash");
    expect(cluster.steps[0].result?.content).toBe("a\nb");
    expect(cluster.steps[1].use.name).toBe("Read");
    expect(cluster.steps[1].result?.content).toBe("contents");
  });

  it("marks a ToolSearch step as meta", () => {
    const turns: TurnItem[] = [
      { kind: "tool-use", id: "m1", name: "ToolSearch", input: { query: "select:send_file" } },
      { kind: "tool-result", toolUseId: "m1", content: "loaded send_file" },
    ];
    const plan = planRender(turns);
    const cluster = plan[0];
    if (cluster.kind !== "cluster") throw new Error("expected cluster");
    expect(cluster.steps[0].isMeta).toBe(true);
  });

  it("does not group across a non-tool turn (two separate clusters)", () => {
    const turns: TurnItem[] = [
      { kind: "tool-use", id: "t1", name: "Bash", input: { command: "ls" } },
      { kind: "assistant-text", text: "interlude" },
      { kind: "tool-use", id: "t2", name: "Bash", input: { command: "pwd" } },
    ];
    const plan = planRender(turns);
    expect(plan.map((n) => n.kind)).toEqual(["cluster", "turn", "cluster"]);
  });
});
