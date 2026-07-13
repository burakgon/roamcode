import { createRequire } from "node:module";

export interface CliOptions {
  help: boolean;
  version: boolean;
  /** A leading positional subcommand: serve (default), install, uninstall, or status. */
  command: "serve" | "install" | "uninstall" | "status";
  port?: string;
  bind?: string;
  noToken: boolean;
}

/**
 * Parse `--flag value`, `--flag=value`, and the short `-h` / `-v` aliases.
 *
 * Unknown options THROW (a clear, actionable error) rather than being silently swallowed: a typo'd
 * flag on the command that drives the user's real coding-agent TUI/files should fail fast, not start with
 * the wrong (default) config. Non-flag positionals are ignored (none are defined yet).
 */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { help: false, version: false, noToken: false, command: "serve" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    // A leading positional subcommand selects the mode (serve is the default when absent).
    if (i === 0 && (arg === "install" || arg === "uninstall" || arg === "status")) {
      opts.command = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const [flag, inlineValue] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const takeValue = (): string | undefined => (inlineValue !== undefined ? inlineValue : argv[(i += 1)]);
    if (flag === "--help" || flag === "-h") opts.help = true;
    else if (flag === "--version" || flag === "-v") opts.version = true;
    else if (flag === "--no-token") opts.noToken = true;
    else if (flag === "--port") opts.port = takeValue();
    else if (flag === "--bind") opts.bind = takeValue();
    else if (flag.startsWith("-")) throw new Error(`unknown option: ${flag} (run with --help)`);
    // A bare positional (not starting with `-`) is ignored — no positional args are defined.
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
    "roamcode — operate Claude Code or Codex sessions on this machine, remotely.",
    "",
    "Usage:",
    "  roamcode [options]",
    "  roamcode install     Permanently install/update and start the per-user service.",
    "  roamcode uninstall   Print how to remove the service.",
    "  roamcode status      Is the service installed and the server reachable? Set ACCESS_TOKEN",
    "                       explicitly to also report the running version (the persisted token is",
    "                       never sent automatically).",
    "",
    "Options:",
    "  --port <n>      Port to listen on (default 4280; 0 = pick a free port). Sets PORT.",
    "  --bind <addr>   Address to bind (default 127.0.0.1). Sets BIND_ADDRESS.",
    "                  Use 0.0.0.0 ONLY behind a secure tunnel (see below).",
    "  --no-token      Loopback dev only: run without an access token. Sets NO_TOKEN=1.",
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
    "  CLAUDE_BIN      Claude Code executable to spawn (default claude).",
    "  CODEX_BIN       Codex executable to spawn (default codex).",
    "  ROAMCODE_VAPID_SUBJECT  mailto:/https: subject for Web Push (default mailto:roamcode@localhost).",
    "  WEB_DIR         Override the served PWA dir (default the built packages/web/dist).",
    "",
    "Full reference (every variable, verified against the code): docs/configuration.md",
    "",
    "On first run an access token is generated, stored in the data dir, and printed ONCE with",
    "the open URL. For remote access, put it behind an HTTPS tunnel (Cloudflare Tunnel / Tailscale)",
    "— Web Push and the installable PWA require a secure context. See the README.",
  ].join("\n");
}
