import { join } from "node:path";

export interface ServerConfig {
  claudeBin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return { claudeBin: env.CLAUDE_BIN ?? "claude" };
}

/**
 * Wiring for the mcp-send server (Claude → user attachments). When present, the spawn layer writes a
 * per-session 0600 MCP config FILE (carrying the loopback base URL, this session's id, and the access
 * token via env) and passes its PATH to the terminal spawn as `--mcp-config <path>`. The token therefore
 * NEVER lands in any process's argv (where `ps`/`/proc` would expose it to other local users) — it
 * lives only in the mode-0600 file. ABSENT → spawn exactly as before (the feature is additive).
 */
export interface AttachSpawnOptions {
  /** Loopback base URL of roamcode (e.g. http://127.0.0.1:4280) the tool POSTs back to. */
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
    roamcode: {
      command: string;
      args: string[];
      env: { RC_BASE_URL: string; RC_SESSION_ID: string; RC_TOKEN: string };
    };
  };
}

/**
 * Build the MCP config document for a session. PURE: no fs, no token leakage — the caller writes the
 * returned object to a 0600 file and passes its path to the terminal spawn as `--mcp-config`.
 */
export function buildMcpConfigDocument(sessionId: string, attach: AttachSpawnOptions): McpConfigDocument {
  return {
    mcpServers: {
      roamcode: {
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

/** Reserved filename prefix for per-session Codex MCP token artifacts. */
export const CODEX_MCP_TOKEN_PREFIX = "codex-mcp-token-";

/** Absolute path of the per-session 0600 bare token file forwarded only to Codex's MCP subprocess. */
export function codexMcpTokenPathFor(dataDir: string, sessionId: string): string {
  return join(dataDir, `${CODEX_MCP_TOKEN_PREFIX}${sessionId}`);
}

/**
 * Per-session Claude Code settings document (written 0600, passed as `--settings <path>`). Its HOOKS let
 * Claude signal lifecycle boundaries directly. The live screen remains the visual authority, while hooks make
 * transitions immediate and cover forms that may be too narrow to render every marker:
 *   - `UserPromptSubmit`, ordinary `PreToolUse`, and `PostToolUse` → working;
 *   - `PermissionRequest`, Elicitation, AskUserQuestion and ExitPlanMode → blocked on the user;
 *   - `Stop` → idle only when its payload reports no active background work.
 * Each hook curls a loopback endpoint, reading the access token from a 0600 file via `-H '@authFile'` so the
 * token never lands in the hook's argv (ps/proc), and ends in `|| true` so a hook can NEVER block/fail claude.
 * The JSON hook payload is forwarded on stdin and bounded by the receiving route. Hooks fire in an interactive
 * tmux pane, including under `--dangerously-skip-permissions` (verified).
 */
export interface HookCommand {
  type: "command";
  command: string;
}
export interface HooksSettingsDocument {
  hooks: {
    SessionStart: Array<{ hooks: HookCommand[] }>;
    Stop: Array<{ hooks: HookCommand[] }>;
    UserPromptSubmit: Array<{ hooks: HookCommand[] }>;
    PreToolUse: Array<{ hooks: HookCommand[] }>;
    PostToolUse: Array<{ hooks: HookCommand[] }>;
    PermissionRequest: Array<{ hooks: HookCommand[] }>;
    PermissionDenied: Array<{ hooks: HookCommand[] }>;
    Elicitation: Array<{ hooks: HookCommand[] }>;
    Notification: Array<{ hooks: HookCommand[] }>;
  };
}

/** Build the per-session hooks settings. PURE: the caller writes it to a 0600 file + the 0600 `authFilePath`. */
export function buildHooksSettingsDocument(
  sessionId: string,
  attach: Pick<AttachSpawnOptions, "baseUrl">,
  authFilePath: string,
): HooksSettingsDocument {
  const post = (
    event:
      | "start"
      | "stop"
      | "submit"
      | "tool"
      | "post-tool"
      | "permission"
      | "permission-denied"
      | "elicitation"
      | "notification",
  ): HookCommand => ({
    type: "command",
    command:
      `curl -sS -m 4 -X POST -H '@${authFilePath}' -H 'Content-Type: application/json' --data-binary @- ` +
      `'${attach.baseUrl}/sessions/${sessionId}/hook?event=${event}' >/dev/null 2>&1 || true`,
  });
  return {
    hooks: {
      SessionStart: [{ hooks: [post("start")] }],
      Stop: [{ hooks: [post("stop")] }],
      UserPromptSubmit: [{ hooks: [post("submit")] }],
      PreToolUse: [{ hooks: [post("tool")] }],
      PostToolUse: [{ hooks: [post("post-tool")] }],
      PermissionRequest: [{ hooks: [post("permission")] }],
      PermissionDenied: [{ hooks: [post("permission-denied")] }],
      Elicitation: [{ hooks: [post("elicitation")] }],
      Notification: [{ hooks: [post("notification")] }],
    },
  };
}

/** Absolute path of the per-session hooks settings file inside the data dir. */
export function hooksSettingsPathFor(dataDir: string, sessionId: string): string {
  return join(dataDir, `hooks-${sessionId}.json`);
}

/** Absolute path of the per-session 0600 auth-header file the hook curls read via `-H '@file'`. */
export function hookAuthPathFor(dataDir: string, sessionId: string): string {
  return join(dataDir, `hook-auth-${sessionId}`);
}

/** The exact bytes of that auth-header file (a single curl `-H` line). Keeps the token out of hook argv. */
export function hookAuthFileContent(token: string): string {
  return `Authorization: Bearer ${token}\n`;
}

export const CODEX_HOOK_EVENTS = [
  { agentEvent: "SessionStart", routeEvent: "start", timeout: 10_000 },
  { agentEvent: "UserPromptSubmit", routeEvent: "submit", timeout: 10_000 },
  { agentEvent: "Stop", routeEvent: "stop", timeout: 10_000 },
  { agentEvent: "PreToolUse", routeEvent: "tool", timeout: 120_000 },
  { agentEvent: "PostToolUse", routeEvent: "post-tool", timeout: 10_000 },
  { agentEvent: "PermissionRequest", routeEvent: "permission", timeout: 120_000 },
] as const;

export type CodexHookRouteEvent = (typeof CODEX_HOOK_EVENTS)[number]["routeEvent"];
export const CODEX_HOOK_SCRIPT_PREFIX = "codex-hook-";

/** Absolute path of one executable per-session Codex lifecycle hook. */
export function codexHookScriptPathFor(dataDir: string, sessionId: string, event: CodexHookRouteEvent): string {
  return join(dataDir, `${CODEX_HOOK_SCRIPT_PREFIX}${sessionId}-${event}.sh`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Codex-compatible hook helper. A bare executable path works both in Codex's shell runner and in compatible
 * runtimes that exec the command directly. The request is synchronous and bounded so lifecycle events retain
 * provider order; delivery failure cannot fail the agent and its delay is capped at four seconds. The bearer
 * token stays in curl's 0600 header file, not argv.
 */
export function buildCodexHookScript(
  sessionId: string,
  attach: Pick<AttachSpawnOptions, "baseUrl">,
  authFilePath: string,
  event: CodexHookRouteEvent,
): string {
  const url = `${attach.baseUrl}/sessions/${encodeURIComponent(sessionId)}/hook?provider=codex&event=${event}`;
  return (
    "#!/bin/sh\n" +
    `curl -sS -m 4 -X POST -H ${shellQuote(`@${authFilePath}`)} -H 'Content-Type: application/json' ` +
    `--data-binary @- ${shellQuote(url)} >/dev/null 2>&1 || true\n` +
    "printf '{}\\n'\n"
  );
}
