#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const statePath = process.env.RC_FAKE_PROVIDER_STATE;
if (!statePath) process.exit(71);

if (argv.includes("--version")) {
  process.stdout.write("0.0.0 (Claude Code fake)\n");
  process.exit(0);
}

const mcpPath = argv[argv.indexOf("--mcp-config") + 1];
const sessionId =
  process.env.RC_SESSION_ID ??
  (typeof mcpPath === "string" ? /mcp-config-([0-9a-f-]+)\.json$/i.exec(mcpPath)?.[1] : undefined) ??
  "unknown";
appendFileSync(
  statePath,
  `${JSON.stringify({
    kind: "launch",
    provider: "claude",
    sessionId,
    argv,
    hasRcToken: typeof process.env.RC_TOKEN === "string",
    hasAnthropicApiKey: typeof process.env.ANTHROPIC_API_KEY === "string",
  })}\n`,
  { encoding: "utf8" },
);
process.stdout.write(`FAKE_CLAUDE_TUI:${sessionId}\r\n`);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.includes("__exit__")) process.exit(0);
  else process.stdout.write(`CLAUDE_ECHO:${chunk}`);
});
process.stdin.resume();
