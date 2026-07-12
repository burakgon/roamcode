#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const statePath = process.env.RC_FAKE_PROVIDER_STATE;
if (!statePath) process.exit(71);

function append(entry) {
  appendFileSync(statePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
}

function events() {
  try {
    return readFileSync(statePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

if (argv.includes("--version")) {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}

if (argv.includes("app-server")) {
  let activeLoginId;
  let controlCursor = events().length;
  const controls = setInterval(() => {
    const current = events();
    const commands = current.slice(controlCursor);
    controlCursor = current.length;
    for (const command of commands) {
      if (command.kind !== "control" || command.target !== "metadata" || command.action !== "login-complete") {
        continue;
      }
      append({ kind: "control-handled", target: "metadata", action: "login-complete", success: command.success });
      if (!activeLoginId) continue;
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "account/login/completed",
          params: {
            loginId: activeLoginId,
            success: command.success === true,
            error: command.success === true ? null : "fake login failure",
          },
        })}\n`,
      );
      activeLoginId = undefined;
    }
  }, 20);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.once("close", () => clearInterval(controls));
  input.on("line", (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame?.method === "string") append({ kind: "rpc", method: frame.method });
    if (!Number.isInteger(frame?.id)) return;
    const metadataMode = events()
      .filter((entry) => entry.kind === "control" && entry.target === "metadata")
      .at(-1)?.mode;
    if (metadataMode === "malformed") {
      process.stdout.write("{malformed-json\n");
      return;
    }
    if (metadataMode === "exit") process.exit(72);
    let result = {};
    switch (frame.method) {
      case "initialize":
        result = { userAgent: "fake-codex-app-server" };
        break;
      case "thread/list":
        result = {
          data: events()
            .filter((entry) => entry.kind === "thread")
            .map(({ id, cwd, source, createdAt }) => ({ id, cwd, source, createdAt })),
          nextCursor: null,
        };
        break;
      case "account/read":
        result = { account: { type: "chatgpt", email: null, planType: "test" }, requiresOpenaiAuth: true };
        break;
      case "model/list":
        result = {
          data: [
            {
              id: "fake-gpt",
              model: "gpt-5.6-sol",
              displayName: "Fake GPT",
              description: "Offline integration fixture",
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "high", description: "High" },
                { reasoningEffort: "xhigh", description: "Extra high" },
              ],
              defaultReasoningEffort: "high",
            },
          ],
          nextCursor: null,
        };
        break;
      case "account/rateLimits/read":
        result = {
          rateLimits: {
            limitId: "fake-primary",
            limitName: "Fake Codex",
            primary: { usedPercent: 7, resetsAt: null, windowDurationMins: 300 },
            secondary: null,
            credits: { hasCredits: false, unlimited: true, balance: null },
          },
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null,
        };
        break;
      case "config/read":
        result = { config: { model_provider: "openai" }, origins: {} };
        break;
      case "account/login/start":
        activeLoginId = `fake-login-${events().filter((entry) => entry.kind === "rpc" && entry.method === "account/login/start").length}`;
        result = {
          type: "chatgptDeviceCode",
          loginId: activeLoginId,
          userCode: "FAKE-CODE",
          verificationUrl: "https://example.test/device",
        };
        break;
      case "account/login/cancel":
        if (frame.params?.loginId === activeLoginId) activeLoginId = undefined;
        result = { status: "canceled" };
        break;
      default:
        result = {};
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`);
  });
  process.stdin.resume();
} else {
  const sessionId = process.env.RC_SESSION_ID ?? "unknown";
  const separator = argv.lastIndexOf("--");
  const resumedThreadId = argv[0] === "resume" && separator >= 0 ? argv[separator + 1] : undefined;
  append({
    kind: "launch",
    provider: "codex",
    sessionId,
    argv,
    resume: resumedThreadId ?? null,
    hasRcToken: typeof process.env.RC_TOKEN === "string",
    hasRcTokenFile: typeof process.env.RC_TOKEN_FILE === "string",
    hasOpenAiApiKey: typeof process.env.OPENAI_API_KEY === "string",
  });
  if (!resumedThreadId) {
    const ordinal = events().filter(
      (entry) => entry.kind === "launch" && entry.provider === "codex" && entry.sessionId === sessionId,
    ).length;
    append({
      kind: "thread",
      id: `thread-${sessionId}-${ordinal}`,
      cwd: process.cwd(),
      source: "cli",
      createdAt: Math.floor(Date.now() / 1000),
    });
  }
  process.stdout.write(`FAKE_CODEX_TUI:${sessionId}\r\n`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let controlCursor = events().length;
  setInterval(() => {
    const current = events();
    const commands = current.slice(controlCursor);
    controlCursor = current.length;
    for (const command of commands) {
      if (command.kind !== "control" || command.target !== sessionId) continue;
      append({ kind: "control-handled", sessionId, action: command.action });
      if (command.action === "approval")
        process.stdout.write("\u001bPtmux;\u001b\u001b]9;Approval requested: integration\u0007\u001b\\");
      else if (command.action === "complete")
        process.stdout.write("\u001bPtmux;\u001b\u001b]9;Agent turn complete\u0007\u001b\\");
      else if (command.action === "exit") process.exit(0);
    }
  }, 20);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (chunk.includes("__approval__")) {
      process.stdout.write("\u001b]9;Approval requested: integration\u0007");
    } else if (chunk.includes("__complete__")) {
      process.stdout.write("\u001b]9;Agent turn complete\u0007");
    } else if (chunk.includes("__exit__")) {
      process.exit(0);
    } else {
      process.stdout.write(`CODEX_ECHO:${chunk}`);
    }
  });
  process.stdin.resume();
}
