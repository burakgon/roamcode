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
    "--replay-user-messages",
    "--session-id",
    "sid-1",
    "--permission-mode",
    "default",
  ]);
});

test("buildClaudeArgs always emits --replay-user-messages so user turns carry rewind checkpoints", () => {
  // Fresh AND resume must both replay user messages (a pre-restart turn stays rewindable after resume).
  expect(buildClaudeArgs({ sessionId: "s" })).toContain("--replay-user-messages");
  expect(buildClaudeArgs({ sessionId: "s", resume: true })).toContain("--replay-user-messages");
});

test("buildClaudeArgs emits the saved permission mode (so acceptEdits/plan survive a respawn)", () => {
  const accept = buildClaudeArgs({ sessionId: "s", permissionMode: "acceptEdits" });
  expect(accept[accept.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  const plan = buildClaudeArgs({ sessionId: "s", permissionMode: "plan" });
  expect(plan[plan.indexOf("--permission-mode") + 1]).toBe("plan");
  // Default when unset.
  const def = buildClaudeArgs({ sessionId: "s" });
  expect(def[def.indexOf("--permission-mode") + 1]).toBe("default");
  // An unknown/garbage mode is rejected → falls back to default (can't inject argv).
  const bad = buildClaudeArgs({ sessionId: "s", permissionMode: "--inject; rm -rf" });
  expect(bad[bad.indexOf("--permission-mode") + 1]).toBe("default");
  // dangerouslySkip still wins (no --permission-mode at all).
  const skip = buildClaudeArgs({ sessionId: "s", dangerouslySkip: true, permissionMode: "plan" });
  expect(skip).toContain("--dangerously-skip-permissions");
  expect(skip).not.toContain("--permission-mode");
});

test("REWIND conversation: resume + resumeSessionAt emits --resume-session-at <uuid>", () => {
  const args = buildClaudeArgs({ sessionId: "s", resume: true, resumeSessionAt: "uuid-7" });
  const i = args.indexOf("--resume-session-at");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toBe("uuid-7");
  // conversation-only mode does NOT also rewind files.
  expect(args).not.toContain("--rewind-files");
});

test("REWIND both: resume + rewindFilesAt also emits --rewind-files <uuid>", () => {
  const args = buildClaudeArgs({ sessionId: "s", resume: true, resumeSessionAt: "uuid-7", rewindFilesAt: "uuid-7" });
  expect(args).toContain("--resume-session-at");
  const i = args.indexOf("--rewind-files");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toBe("uuid-7");
});

test("a FRESH session never emits the resume-time rewind flags even if checkpoints are passed", () => {
  // resumeSessionAt/rewindFilesAt are only meaningful on a resume; a fresh spawn must ignore them.
  const args = buildClaudeArgs({ sessionId: "s", resumeSessionAt: "uuid-7", rewindFilesAt: "uuid-7" });
  expect(args).not.toContain("--resume-session-at");
  expect(args).not.toContain("--rewind-files");
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
  // The two send tools are auto-approved so Claude can deliver a file in any permission mode
  // without a prompt (MCP tools are otherwise gated; `allowedTools` is the documented grant).
  const a = args.indexOf("--allowedTools");
  expect(a).toBeGreaterThanOrEqual(0);
  expect(args).toContain("mcp__remote-coder__send_image");
  expect(args).toContain("mcp__remote-coder__send_file");
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

test("mcpConfigPath also allow-lists ask_user and appends a system prompt teaching Claude to use it", () => {
  const args = buildClaudeArgs({ sessionId: "sid-1", mcpConfigPath: "/data/mcp-config-sid-1.json" });
  // ask_user joins the two send tools in the standing allow-list.
  expect(args).toContain("mcp__remote-coder__ask_user");
  expect(args).toContain("mcp__remote-coder__send_image");
  expect(args).toContain("mcp__remote-coder__send_file");
  // The system prompt nudges Claude to call ask_user (the built-in AskUserQuestion is unavailable here).
  const i = args.indexOf("--append-system-prompt");
  expect(i).toBeGreaterThanOrEqual(0);
  const prompt = args[i + 1];
  expect(prompt).toContain("mcp__remote-coder__ask_user");
  expect(prompt).toMatch(/AskUserQuestion/);
});

test("NO --append-system-prompt and no ask_user allow when mcpConfigPath is absent (additive)", () => {
  const args = buildClaudeArgs({ sessionId: "sid-1" });
  expect(args).not.toContain("--append-system-prompt");
  expect(args).not.toContain("mcp__remote-coder__ask_user");
});
