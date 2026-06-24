import { expect, test } from "vitest";
import { loadConfig, buildClaudeArgs, buildMcpConfigDocument, mcpConfigPathFor } from "../src/index.js";

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
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--session-id",
    "sid-1",
    "--permission-mode",
    "default",
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

test("buildClaudeArgs never includes -p/--print even with all options set", () => {
  const args = buildClaudeArgs({
    sessionId: "s",
    dangerouslySkip: true,
    effort: "high",
    model: "opus",
    addDirs: ["/a", "/b"],
  });
  expect(args).not.toContain("-p");
  expect(args).not.toContain("--print");
});

test("buildClaudeArgs emits --mcp-config followed by a FILE PATH (never inline JSON) when given mcpConfigPath", () => {
  const path = "/data/mcp-config-sid-9.json";
  const args = buildClaudeArgs({ sessionId: "sid-9", mcpConfigPath: path });
  const i = args.indexOf("--mcp-config");
  expect(i).toBeGreaterThanOrEqual(0);
  // The arg after --mcp-config is a plain path, not a JSON document.
  expect(args[i + 1]).toBe(path);
  expect(() => JSON.parse(args[i + 1])).toThrow();
});

test("buildClaudeArgs never puts the access token in the argv (regression: token must stay in the 0600 file)", () => {
  // The path is the ONLY mcp-related thing in argv; the token lives in the file, never here.
  const args = buildClaudeArgs({ sessionId: "sid-9", mcpConfigPath: mcpConfigPathFor("/data", "sid-9") });
  for (const a of args) expect(a).not.toContain("SUPER-SECRET-TOKEN");
  // Sanity: had the token been threaded through, this would be the value — confirm it is truly absent.
  const doc = buildMcpConfigDocument("sid-9", {
    baseUrl: "http://127.0.0.1:4280",
    token: "SUPER-SECRET-TOKEN",
    mcpScriptPath: "/abs/dist/mcp-send.js",
    dataDir: "/data",
  });
  expect(doc.mcpServers["remote-coder"].env.RC_TOKEN).toBe("SUPER-SECRET-TOKEN");
  expect(JSON.stringify(args)).not.toContain("SUPER-SECRET-TOKEN");
});

test("buildMcpConfigDocument carries the loopback URL, session id, token and the runnable mcp-send.js script", () => {
  const doc = buildMcpConfigDocument("sid-9", {
    baseUrl: "http://127.0.0.1:4280",
    token: "tok-9",
    mcpScriptPath: "/abs/dist/mcp-send.js",
    dataDir: "/data",
  });
  expect(doc.mcpServers["remote-coder"]).toEqual({
    command: process.execPath,
    args: ["/abs/dist/mcp-send.js"],
    env: {
      RC_BASE_URL: "http://127.0.0.1:4280",
      RC_SESSION_ID: "sid-9",
      RC_TOKEN: "tok-9",
    },
  });
});

test("mcpConfigPathFor builds a per-session path inside the data dir", () => {
  expect(mcpConfigPathFor("/data", "sid-9")).toBe("/data/mcp-config-sid-9.json");
});

test("buildClaudeArgs emits NO --mcp-config when mcpConfigPath is absent (additive, unchanged spawn)", () => {
  const args = buildClaudeArgs({ sessionId: "sid-9" });
  expect(args).not.toContain("--mcp-config");
});

test("resume emits --resume <id> and omits --session-id", () => {
  const args = buildClaudeArgs({ sessionId: "sid-1", resume: true });
  expect(args).toContain("--resume");
  expect(args[args.indexOf("--resume") + 1]).toBe("sid-1");
  expect(args).not.toContain("--session-id");
});

test("a fresh session emits --session-id and not --resume", () => {
  const args = buildClaudeArgs({ sessionId: "sid-1" });
  expect(args).toContain("--session-id");
  expect(args).not.toContain("--resume");
});
