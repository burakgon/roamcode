import { join } from "node:path";

export interface ServerConfig {
  claudeBin: string;
  defaultModel?: string;
  defaultEffort?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const config: ServerConfig = { claudeBin: env.CLAUDE_BIN ?? "claude" };
  if (env.CLAUDE_DEFAULT_MODEL) config.defaultModel = env.CLAUDE_DEFAULT_MODEL;
  if (env.CLAUDE_DEFAULT_EFFORT) config.defaultEffort = env.CLAUDE_DEFAULT_EFFORT;
  return config;
}

/**
 * Wiring for the mcp-send server (Claude → user attachments). When present, the spawn layer writes a
 * per-session 0600 MCP config FILE (carrying the loopback base URL, this session's id, and the access
 * token via env) and passes its PATH to buildClaudeArgs as `--mcp-config <path>`. The token therefore
 * NEVER lands in any process's argv (where `ps`/`/proc` would expose it to other local users) — it
 * lives only in the mode-0600 file. ABSENT → spawn exactly as before (the feature is additive).
 */
export interface AttachSpawnOptions {
  /** Loopback base URL of remote-coder (e.g. http://127.0.0.1:4280) the tool POSTs back to. */
  baseUrl: string;
  /** The access token the mcp-send tool sends as `Authorization: Bearer <token>`. */
  token: string;
  /** Absolute path to the built dist/mcp-send.js node script. */
  mcpScriptPath: string;
  /** Host data dir (mode 0700) the per-session 0600 mcp-config-<id>.json is written into. */
  dataDir: string;
}

/** The `{ mcpServers: { ... } }` document written to the per-session 0600 config file. */
export interface McpConfigDocument {
  mcpServers: {
    "remote-coder": {
      command: string;
      args: string[];
      env: { RC_BASE_URL: string; RC_SESSION_ID: string; RC_TOKEN: string };
    };
  };
}

/**
 * Build the MCP config document for a session. PURE: no fs, no token leakage — the caller writes the
 * returned object to a 0600 file and passes its path to buildClaudeArgs.
 */
export function buildMcpConfigDocument(sessionId: string, attach: AttachSpawnOptions): McpConfigDocument {
  return {
    mcpServers: {
      "remote-coder": {
        command: process.execPath,
        args: [attach.mcpScriptPath],
        env: {
          RC_BASE_URL: attach.baseUrl,
          RC_SESSION_ID: sessionId,
          RC_TOKEN: attach.token,
        },
      },
    },
  };
}

/** Absolute path of the per-session MCP config file inside the data dir. */
export function mcpConfigPathFor(dataDir: string, sessionId: string): string {
  return join(dataDir, `mcp-config-${sessionId}.json`);
}

export interface BuildClaudeArgsOptions {
  sessionId: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  /** When true, spawn with --dangerously-skip-permissions instead of --permission-mode default. */
  dangerouslySkip?: boolean;
  /** When true, RESUME an existing session: emit --resume <sessionId> and omit --session-id. */
  resume?: boolean;
  /**
   * Filesystem path to a per-session MCP config file. When set, emit `--mcp-config <path>` so claude
   * loads the mcp-send server. The token lives in that 0600 file, never here in the argv.
   */
  mcpConfigPath?: string;
}

/**
 * Build the argv for spawning `claude` per docs/protocol-notes.md.
 * Returns flags only — no binary name, no cwd (cwd is the spawn cwd, not an arg).
 * Never includes -p/--print.
 */
export function buildClaudeArgs(opts: BuildClaudeArgsOptions): string[] {
  const args: string[] = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
  ];

  // Resume reuses the transcript for <sessionId>; a fresh session ASSIGNS it via --session-id.
  // The binary rejects --resume together with --session-id for an existing id.
  if (opts.resume) {
    args.push("--resume", opts.sessionId);
  } else {
    args.push("--session-id", opts.sessionId);
  }

  if (opts.dangerouslySkip) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "default");
  }

  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.model) args.push("--model", opts.model);
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);

  // mcp-send wiring: `claude --mcp-config` accepts a FILE PATH (verified via `claude --help`: "Load
  // MCP servers from JSON files or strings"). We pass a PATH — never inline JSON — so the access token
  // inside that config (RC_TOKEN) never enters this process's (or claude's) argv, where `ps auxww` /
  // `/proc/<pid>/cmdline` would expose it to any other local user. The spawn layer wrote the config to
  // a per-session mode-0600 file before calling this; we only reference its path here.
  if (opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath);
    // Auto-approve the send + ask tools so Claude can deliver a file/image to the user AND ask the user
    // a multiple-choice question WITHOUT a permission prompt, in ANY permission mode. Per the Agent docs,
    // `allowedTools` is the right way to grant MCP tools (a permission mode like `default` would otherwise
    // prompt for every MCP call; `bypassPermissions` auto-approves but is broader than needed). All three
    // act on the already-authenticated user's own chat, so a standing allow is appropriate. The server
    // name in the generated config is `remote-coder`, so the tool ids are `mcp__remote-coder__<tool>`.
    args.push(
      "--allowedTools",
      "mcp__remote-coder__send_image",
      "mcp__remote-coder__send_file",
      "mcp__remote-coder__ask_user",
    );
    // Teach Claude to USE our ask_user tool: the built-in AskUserQuestion is NOT available in this
    // stream-json environment, so without this nudge Claude would try (and fail) to ask multi-choice
    // questions. Keep it concise — and free of secrets (this lands in argv).
    args.push(
      "--append-system-prompt",
      "To ask the user a single- or multiple-choice question, you MUST call the " +
        "mcp__remote-coder__ask_user tool with a `questions` array (each question has 1+ `options`; set " +
        "`multiSelect: true` to allow several). When the options are best judged by SEEING them (UI/" +
        "layout choices, code snippets, diagrams, configs), give each option a `preview` string — an " +
        "ASCII mockup or a code/config block — shown in a monospace box for visual comparison. It " +
        "returns the user's selection(s). The built-in AskUserQuestion tool is unavailable in this " +
        "environment — do not rely on it.",
    );
  }

  return args;
}
