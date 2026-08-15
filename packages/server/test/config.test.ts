import { expect, test } from "vitest";
import {
  loadConfig,
  buildMcpConfigDocument,
  mcpConfigPathFor,
  buildHooksSettingsDocument,
  hooksSettingsPathFor,
  hookAuthPathFor,
  hookAuthFileContent,
  buildCodexHookScript,
  codexHookScriptPathFor,
} from "../src/index.js";

test("loadConfig defaults claudeBin to 'claude'", () => {
  expect(loadConfig({})).toEqual({ claudeBin: "claude" });
});

test("loadConfig reads CLAUDE_BIN", () => {
  expect(loadConfig({ CLAUDE_BIN: "/opt/claude" })).toEqual({ claudeBin: "/opt/claude" });
});

test("loadConfig never surfaces ANTHROPIC_API_KEY", () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-should-be-ignored" });
  expect(JSON.stringify(cfg)).not.toContain("sk-should-be-ignored");
});

test("buildMcpConfigDocument carries the loopback URL, session id, token and the runnable mcp-send.js script", () => {
  const doc = buildMcpConfigDocument("sid-9", {
    baseUrl: "http://127.0.0.1:4280",
    token: "tok-9",
    mcpScriptPath: "/abs/dist/mcp-send.js",
    dataDir: "/data",
  });
  expect(doc.mcpServers["roamcode"]).toEqual({
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

test("buildHooksSettingsDocument wires the Claude lifecycle hooks with JSON stdin and token-file auth", () => {
  const doc = buildHooksSettingsDocument("sid-9", { baseUrl: "http://127.0.0.1:4280" }, "/data/hook-auth-sid-9");
  const stop = doc.hooks.Stop[0]!.hooks[0]!.command;
  const submit = doc.hooks.UserPromptSubmit[0]!.hooks[0]!.command;
  const tool = doc.hooks.PreToolUse[0]!.hooks[0]!.command;
  const postTool = doc.hooks.PostToolUse[0]!.hooks[0]!.command;
  const permission = doc.hooks.PermissionRequest[0]!.hooks[0]!.command;
  const permissionDenied = doc.hooks.PermissionDenied[0]!.hooks[0]!.command;
  const elicitation = doc.hooks.Elicitation[0]!.hooks[0]!.command;
  // Correct endpoint + event per hook.
  expect(stop).toContain("http://127.0.0.1:4280/sessions/sid-9/hook?event=stop");
  expect(submit).toContain("http://127.0.0.1:4280/sessions/sid-9/hook?event=submit");
  expect(tool).toContain("event=tool");
  expect(postTool).toContain("event=post-tool");
  expect(permission).toContain("event=permission");
  expect(permissionDenied).toContain("event=permission-denied");
  expect(elicitation).toContain("event=elicitation");
  // Token is read from the 0600 auth file, never inlined into the command (argv/ps stays clean).
  expect(stop).toContain("-H '@/data/hook-auth-sid-9'");
  expect(stop).toContain("--data-binary @-");
  expect(stop).toContain("Content-Type: application/json");
  // Never blocks/fails claude.
  expect(stop.trim().endsWith("|| true")).toBe(true);
});

test("hook file paths + auth content", () => {
  expect(hooksSettingsPathFor("/data", "sid-9")).toBe("/data/hooks-sid-9.json");
  expect(hookAuthPathFor("/data", "sid-9")).toBe("/data/hook-auth-sid-9");
  expect(hookAuthFileContent("tok-9")).toBe("Authorization: Bearer tok-9\n");
});

test("buildCodexHookScript posts ordered JSON lifecycle without putting the token in argv", () => {
  const script = buildCodexHookScript(
    "sid with/slash",
    { baseUrl: "http://127.0.0.1:4280" },
    "/data/it's-safe/hook-auth",
    "submit",
  );
  expect(script).toMatch(/^#!\/bin\/sh\n/u);
  expect(script).toContain("/sessions/sid%20with%2Fslash/hook?provider=codex&event=submit");
  expect(script).toContain("-H '@/data/it'\"'\"'s-safe/hook-auth'");
  expect(script).toContain("--data-binary @-");
  expect(script).toContain("-m 4");
  expect(script).toMatch(/\|\| true\nprintf '\{\}\\n'\n$/u);
  expect(script).not.toContain("Bearer");
  expect(codexHookScriptPathFor("/data", "sid-9", "post-tool")).toBe("/data/codex-hook-sid-9-post-tool.sh");
});
