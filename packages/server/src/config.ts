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

export interface BuildClaudeArgsOptions {
  sessionId: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  /** When true, spawn with --dangerously-skip-permissions instead of --permission-mode default. */
  dangerouslySkip?: boolean;
}

/**
 * Build the argv for spawning `claude` per docs/protocol-notes.md.
 * Returns flags only — no binary name, no cwd (cwd is the spawn cwd, not an arg).
 * Never includes -p/--print.
 */
export function buildClaudeArgs(opts: BuildClaudeArgsOptions): string[] {
  const args: string[] = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--session-id", opts.sessionId,
  ];

  if (opts.dangerouslySkip) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "default");
  }

  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.model) args.push("--model", opts.model);
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);

  return args;
}
