import { createRequire } from "node:module";

export interface CliOptions {
  help: boolean;
  version: boolean;
  /** A leading positional subcommand; serve is the default. */
  command: "serve" | "install" | "uninstall" | "status" | "pair" | "reset-access" | "api";
  apiAction?: string;
  port?: string;
  bind?: string;
  /** Public app origin used when building a one-time pairing URL. */
  publicUrl?: string;
  noToken: boolean;
  /** Required destructive-operation acknowledgement for reset-access. */
  confirm: boolean;
  sessionId?: string;
  agentId?: string;
  data?: string;
  cwd?: string;
  timeoutMs?: string;
  after?: string;
  idempotencyKey?: string;
  activate: boolean;
  appendNewline: boolean;
}

/**
 * Parse `--flag value`, `--flag=value`, and the short `-h` / `-v` aliases.
 *
 * Unknown options THROW (a clear, actionable error) rather than being silently swallowed: a typo'd
 * flag on the command that drives the user's real coding-agent TUI/files should fail fast, not start with
 * the wrong (default) config. Non-flag positionals are ignored (none are defined yet).
 */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    help: false,
    version: false,
    noToken: false,
    confirm: false,
    activate: false,
    appendNewline: false,
    command: "serve",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (i === 0 && arg === "cloud") {
      throw new Error("cloud commands were removed; RoamCode now runs as a standalone-only service");
    }
    // A leading positional subcommand selects the mode (serve is the default when absent).
    if (
      i === 0 &&
      (arg === "install" ||
        arg === "uninstall" ||
        arg === "status" ||
        arg === "pair" ||
        arg === "reset-access" ||
        arg === "api")
    ) {
      opts.command = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const [flag, inlineValue] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const takeValue = (): string | undefined => (inlineValue !== undefined ? inlineValue : argv[(i += 1)]);
    if (flag === "--help" || flag === "-h") opts.help = true;
    else if (flag === "--version" || flag === "-v") opts.version = true;
    else if (flag === "--no-token") opts.noToken = true;
    else if (flag === "--confirm") opts.confirm = true;
    else if (flag === "--activate") opts.activate = true;
    else if (flag === "--newline") opts.appendNewline = true;
    else if (flag === "--port") opts.port = takeValue();
    else if (flag === "--bind") opts.bind = takeValue();
    else if (flag === "--url") opts.publicUrl = takeValue();
    else if (flag === "--session") opts.sessionId = takeValue();
    else if (flag === "--agent") opts.agentId = takeValue();
    else if (flag === "--data") opts.data = takeValue();
    else if (flag === "--cwd") opts.cwd = takeValue();
    else if (flag === "--timeout-ms") opts.timeoutMs = takeValue();
    else if (flag === "--after") opts.after = takeValue();
    else if (flag === "--idempotency-key") opts.idempotencyKey = takeValue();
    else if (flag.startsWith("-")) throw new Error(`unknown option: ${flag} (run with --help)`);
    else if (opts.command === "api" && opts.apiAction === undefined) opts.apiAction = flag;
    // Other bare positionals are ignored for backward compatibility.
  }
  return opts;
}

/** The CLI's own version, read from its package.json (the published `roamcode` version). */
export function versionText(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version?: string };
  return pkg.version ?? "0.0.0";
}

export function helpText(): string {
  return [
    "roamcode — open persistent terminals and operate coding agents on this machine, remotely.",
    "",
    "Usage:",
    "  roamcode [options]",
    "  roamcode install     Permanently install/update and start the per-user service.",
    "  roamcode uninstall   Print how to remove the service.",
    "  roamcode status      Is the service installed and the server reachable? Set ACCESS_TOKEN",
    "                       explicitly to also report the running version (the persisted token is",
    "                       never sent automatically).",
    "  roamcode pair        Create a 5-minute, one-use device pairing link + terminal QR.",
    "  roamcode reset-access --confirm",
    "                       Offline recovery: replace host access, revoke every device, and pair again.",
    "  roamcode api <resource|action> [options]",
    "                       Stable agent control: capabilities, sessions, agents, workspaces,",
    "                       devices, presence, adapters, events, openapi, send, wait, focus, or start.",
    "",
    "Options:",
    "  --port <n>      Port to listen on (default 4280; 0 = pick a free port). Sets PORT.",
    "                  With an installed service, use --port 0 for development; the implicit 4280 is refused.",
    "  --bind <addr>   Address to bind (default 127.0.0.1). Sets BIND_ADDRESS.",
    "                  Use 0.0.0.0 ONLY behind a secure tunnel (see below).",
    "  --url <origin>  Public app origin for `roamcode pair`.",
    "  --no-token      Loopback dev only: run without an access token. Sets NO_TOKEN=1.",
    "  --confirm       Required acknowledgement for destructive recovery commands.",
    "  --session <id>  Target for `api send`.",
    "  --newline       Append a terminal newline for `api send`.",
    "  --agent <id>    Target for `api wait` / `api focus`.",
    "  --cwd <path>    Working directory for `api start`; opens a neutral interactive terminal.",
    "  --timeout-ms <n>  Long-poll timeout for `api wait` (0-30000).",
    "  --after <n>    Cursor for event reads or agent waits (default 0).",
    "  --idempotency-key <key>  Stable retry key for an API mutation.",
    "  --activate      Explicitly request activation for `api focus` (default never steals focus).",
    "                  NOT for public binds.",
    "  -v, --version   Print the version and exit.",
    "  -h, --help      Show this help and exit.",
    "",
    "Environment (read by the server; flags above set the first three):",
    "  PORT            Port to listen on (default 4280).",
    "  BIND_ADDRESS    Address to bind (default 127.0.0.1).",
    "  NO_TOKEN        1 = loopback dev mode with no access token.",
    "  ACCESS_TOKEN    Use this token instead of the generated/persisted one.",
    "  FS_ROOT         Root dir the file picker is confined to (default $HOME).",
    "  ROAMCODE_DATA_DIR  Where the SQLite DBs + access token are stored.",
    "  ROAMCODE_API_URL    Host origin for `roamcode api` (default http://127.0.0.1:4280).",
    "  ROAMCODE_API_TOKEN  Device/host bearer credential for `roamcode api`; never put it in a URL.",
    "  CLAUDE_BIN      Claude Code executable for managed Sessions (default claude).",
    "  CODEX_BIN       Codex executable for managed Sessions (default codex).",
    "  ROAMCODE_VAPID_SUBJECT  mailto:/https: subject for Web Push (default https://roamcode.ai).",
    "  WEB_DIR         Override the served PWA dir (default the built packages/web/dist).",
    "",
    "Full reference (every variable, verified against the code): docs/configuration.md",
    "",
    "On first run a host key is generated and stored in the data dir; the CLI exposes only a",
    "five-minute, one-use pairing link. For remote access, put it behind a stable HTTPS reverse proxy",
    "— Web Push and the installable PWA require a secure context. See the README.",
  ].join("\n");
}
