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

describe("summarizeToolInput", () => {
  it("uses the primary descriptive field for common tools", () => {
    expect(summarizeToolInput({ command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolInput({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
  });
  it("summarizes a structured tool (a list field) as an item count, not an empty string", () => {
    expect(summarizeToolInput({ todos: [{ content: "a" }, { content: "b" }, { content: "c" }] })).toBe("3 items");
    expect(summarizeToolInput({ todos: [{ content: "a" }] })).toBe("1 item");
  });
  it("recognizes descriptive fields beyond the path/command set (subject/title/description)", () => {
    expect(summarizeToolInput({ subject: "Design the API" })).toBe("Design the API");
    expect(summarizeToolInput({ status: "in_progress", description: "build it" })).toBe("build it");
  });
  it("collapses newlines and caps a long value to one readable line", () => {
    const r = summarizeToolInput({ command: "cd /tmp\ngit add .\ngit commit -m 'msg'" });
    expect(r).not.toContain("\n");
    expect(r.startsWith("cd /tmp git add .")).toBe(true);
    const long = summarizeToolInput({ command: "x".repeat(200) });
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
  });
  it("falls back to the first non-empty string field, else empty", () => {
    expect(summarizeToolInput({ weird: "value" })).toBe("value");
    expect(summarizeToolInput({})).toBe("");
    expect(summarizeToolInput(undefined)).toBe("");
  });
  it("enriches a Read with its line range (offset/limit) like the terminal", () => {
    expect(summarizeToolInput({ file_path: "/a/b.ts", offset: 120, limit: 41 })).toBe("/a/b.ts (lines 120–160)");
    expect(summarizeToolInput({ file_path: "/a/b.ts", limit: 50 })).toBe("/a/b.ts (first 50 lines)");
    expect(summarizeToolInput({ file_path: "/a/b.ts", offset: 40 })).toBe("/a/b.ts (from line 40)");
    // A plain Read (no offset/limit) stays the bare path.
    expect(summarizeToolInput({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
  });
  it("enriches a Write with its line count", () => {
    expect(summarizeToolInput({ file_path: "/a/b.ts", content: "l1\nl2\nl3" })).toBe("/a/b.ts (3 lines)");
    expect(summarizeToolInput({ file_path: "/a/b.ts", content: "only" })).toBe("/a/b.ts (1 line)");
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

  it("keeps ANSI in `text` (so it renders in color) but strips it for the one-line summary", () => {
    const ESC = String.fromCharCode(0x1b);
    const r = parseToolResult(`${ESC}[31mError:${ESC}[0m boom`);
    // text keeps the escapes so AnsiText can colorize the body…
    expect(r.text).toBe(`${ESC}[31mError:${ESC}[0m boom`);
    // …the collapsed-head summary is clean (no color codes in a tiny one-liner)…
    expect(r.summary).toBe("Error: boom");
    // …and raw still has the original bytes for the verbose panel.
    expect(r.raw).toContain(`${ESC}[31m`);
  });

  it("surfaces an image tool_result as an image, summary '[image]', with the base64 blob redacted from raw", () => {
    // Reading an image file yields a tool_result whose content is an image block. It must render as an
    // image, never as a giant base64 JSON dump.
    const data = "A".repeat(500);
    const content = [{ type: "image", source: { type: "base64", media_type: "image/png", data } }];
    const r = parseToolResult(content);
    expect(r.images).toHaveLength(1);
    expect(r.images[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data } });
    expect(r.text).toBe("");
    expect(r.summary).toBe("[image]");
    expect(r.raw).not.toContain(data); // the blob is redacted from the raw panel
    expect(r.raw).toContain("base64");
  });

  it("summarizes a tool_reference result (ToolSearch) readably instead of dumping raw JSON", () => {
    const content = [
      { type: "tool_reference", tool_name: "TaskList" },
      { type: "tool_reference", tool_name: "TaskCreate" },
    ];
    const r = parseToolResult(content);
    expect(r.text).toContain("TaskList");
    expect(r.text).toContain("TaskCreate");
    expect(r.summary).toContain("TaskList");
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
    if (!cluster || cluster.kind !== "cluster") throw new Error("expected cluster");
    expect(cluster.steps).toHaveLength(2);
    expect(cluster.steps[0]?.use.name).toBe("Bash");
    expect(cluster.steps[0]?.result?.content).toBe("a\nb");
    expect(cluster.steps[1]?.use.name).toBe("Read");
    expect(cluster.steps[1]?.result?.content).toBe("contents");
  });

  it("marks a ToolSearch step as meta", () => {
    const turns: TurnItem[] = [
      { kind: "tool-use", id: "m1", name: "ToolSearch", input: { query: "select:send_file" } },
      { kind: "tool-result", toolUseId: "m1", content: "loaded send_file" },
    ];
    const plan = planRender(turns);
    const cluster = plan[0];
    if (!cluster || cluster.kind !== "cluster") throw new Error("expected cluster");
    expect(cluster.steps[0]?.isMeta).toBe(true);
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

  it("emits a subagent-ref as a dedicated `subagent` node (NOT absorbed into a tool cluster)", () => {
    const turns: TurnItem[] = [
      { kind: "assistant-text", text: "dispatching" },
      { kind: "tool-use", id: "t1", name: "Bash", input: { command: "ls" } },
      { kind: "tool-result", toolUseId: "t1", content: "a" },
      { kind: "subagent-ref", id: "agent-1" },
      { kind: "tool-use", id: "t2", name: "Read", input: { file_path: "/x" } },
    ];
    const plan = planRender(turns);
    // The Bash plumbing folds into a cluster; the subagent is its own node; the trailing Read is a
    // separate cluster (the subagent node breaks the run).
    expect(plan.map((n) => n.kind)).toEqual(["turn", "cluster", "subagent", "cluster"]);
    const node = plan.find((n) => n.kind === "subagent");
    expect(node).toMatchObject({ kind: "subagent", id: "agent-1" });
  });
});
