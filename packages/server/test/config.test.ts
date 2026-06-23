import { expect, test } from "vitest";
import { loadConfig, buildClaudeArgs } from "../src/index.js";

test("loadConfig defaults claudeBin to 'claude' and leaves model/effort undefined", () => {
  expect(loadConfig({})).toEqual({ claudeBin: "claude" });
});

test("loadConfig reads CLAUDE_BIN, CLAUDE_DEFAULT_MODEL, CLAUDE_DEFAULT_EFFORT", () => {
  const cfg = loadConfig({
    CLAUDE_BIN: "/opt/claude",
    CLAUDE_DEFAULT_MODEL: "opus",
    CLAUDE_DEFAULT_EFFORT: "high",
  });
  expect(cfg).toEqual({ claudeBin: "/opt/claude", defaultModel: "opus", defaultEffort: "high" });
});

test("loadConfig never surfaces ANTHROPIC_API_KEY", () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-should-be-ignored" });
  expect(JSON.stringify(cfg)).not.toContain("sk-should-be-ignored");
});

test("buildClaudeArgs always sets the stream-json flag block + session id (remote-approval path)", () => {
  const args = buildClaudeArgs({ sessionId: "sid-1" });
  expect(args).toEqual([
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--session-id", "sid-1",
    "--permission-mode", "default",
  ]);
});

test("buildClaudeArgs uses --dangerously-skip-permissions instead of --permission-mode when dangerouslySkip", () => {
  const args = buildClaudeArgs({ sessionId: "sid-2", dangerouslySkip: true });
  expect(args).toContain("--dangerously-skip-permissions");
  expect(args).not.toContain("--permission-mode");
  expect(args).not.toContain("default");
});

test("buildClaudeArgs never emits both the permission flags together", () => {
  const safe = buildClaudeArgs({ sessionId: "s", dangerouslySkip: false });
  expect(safe.includes("--permission-mode") && safe.includes("--dangerously-skip-permissions")).toBe(false);
  const danger = buildClaudeArgs({ sessionId: "s", dangerouslySkip: true });
  expect(danger.includes("--permission-mode") && danger.includes("--dangerously-skip-permissions")).toBe(false);
});

test("buildClaudeArgs appends optional --effort and --model when provided", () => {
  const args = buildClaudeArgs({ sessionId: "s", model: "opus", effort: "xhigh" });
  expect(args).toContain("--effort");
  expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
  expect(args).toContain("--model");
  expect(args[args.indexOf("--model") + 1]).toBe("opus");
});

test("buildClaudeArgs repeats --add-dir for each extra directory", () => {
  const args = buildClaudeArgs({ sessionId: "s", addDirs: ["/a", "/b"] });
  const flags = args.filter((a) => a === "--add-dir");
  expect(flags).toHaveLength(2);
  expect(args).toContain("/a");
  expect(args).toContain("/b");
});

test("buildClaudeArgs never includes -p or --print", () => {
  const args = buildClaudeArgs({ sessionId: "s" });
  expect(args).not.toContain("-p");
  expect(args).not.toContain("--print");
});
