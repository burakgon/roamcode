import { createRequire } from "node:module";

export interface CliOptions {
  help: boolean;
  version: boolean;
  port?: string;
  bind?: string;
  noToken: boolean;
}

/**
 * Parse `--flag value`, `--flag=value`, and the short `-h` / `-v` aliases.
 *
 * Unknown options THROW (a clear, actionable error) rather than being silently swallowed: a typo'd
 * flag on the command that drives the user's real `claude`/files should fail fast, not start with
 * the wrong (default) config. Non-flag positionals are ignored (none are defined yet).
 */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { help: false, version: false, noToken: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
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

/** The CLI's own version, read from its package.json (the published `remote-coder` version). */
export function versionText(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version?: string };
  return pkg.version ?? "0.0.0";
}

export function helpText(): string {
  return [
    "remote-coder — operate Claude Code sessions on this machine, remotely.",
    "",
    "Usage:",
    "  remote-coder [options]",
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
    "  REMOTE_CODER_DATA_DIR  Where the SQLite DBs + access token are stored.",
    "  VAPID_SUBJECT   mailto:/https: subject for Web Push (default mailto:remote-coder@localhost).",
    "  WEB_DIR         Override the served PWA dir (default the built packages/web/dist).",
    "",
    "On first run an access token is generated, stored in the data dir, and printed ONCE with",
    "the open URL. For remote access, put it behind an HTTPS tunnel (Cloudflare Tunnel / Tailscale)",
    "— Web Push and the installable PWA require a secure context. See the README.",
  ].join("\n");
}
