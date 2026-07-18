import { createRequire } from "node:module";

export interface CliOptions {
  help: boolean;
  version: boolean;
  /** A leading positional subcommand; serve is the default. */
  command: "serve" | "install" | "uninstall" | "status" | "pair" | "reset-access" | "api" | "cloud";
  apiAction?: string;
  cloudAction?: string;
  port?: string;
  bind?: string;
  /** Public app origin used when building a one-time pairing URL. */
  publicUrl?: string;
  /** Static PWA origin advertised in cloud pairing links. */
  appUrl?: string;
  /** Hosted account/control-plane origin used by cloud login. */
  controlPlaneUrl?: string;
  /** Mode-0600 file containing a legacy/self-host standalone relay account credential. */
  accountTokenFile?: string;
  /** Mode-0600 file containing the relay operator root credential. */
  rootTokenFile?: string;
  /** Private destination for a newly generated cloud account credential. */
  output?: string;
  /** Hosted relay account id for operator lifecycle commands. */
  accountId?: string;
  /** Hosted relay account plan for operator lifecycle commands. */
  plan?: string;
  maxRoutes?: string;
  maxDevicesPerRoute?: string;
  accountStatus?: string;
  /** Mode-0600 file containing a credential issued by the remote peer host. */
  peerCredentialFile?: string;
  /** Mode-0600 file containing a five-minute, one-use remote pairing link. */
  peerPairingFile?: string;
  /** Human-readable label for a provisioned cloud host. */
  label?: string;
  noToken: boolean;
  /** Required destructive-operation acknowledgement for reset-access. */
  confirm: boolean;
  sessionId?: string;
  peerId?: string;
  workspaceId?: string;
  peerUrl?: string;
  actions?: string;
  workspaces?: string;
  expectedRevision?: string;
  peerStatus?: string;
  clientId?: string;
  leaseId?: string;
  agentId?: string;
  data?: string;
  cwd?: string;
  provider?: string;
  optionsJson?: string;
  timeoutMs?: string;
  after?: string;
  limit?: string;
  idempotencyKey?: string;
  activate: boolean;
  takeover: boolean;
  renew: boolean;
  release: boolean;
  revoke: boolean;
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
    takeover: false,
    renew: false,
    release: false,
    revoke: false,
    appendNewline: false,
    command: "serve",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    // A leading positional subcommand selects the mode (serve is the default when absent).
    if (
      i === 0 &&
      (arg === "install" ||
        arg === "uninstall" ||
        arg === "status" ||
        arg === "pair" ||
        arg === "reset-access" ||
        arg === "api" ||
        arg === "cloud")
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
    else if (flag === "--takeover") opts.takeover = true;
    else if (flag === "--renew") opts.renew = true;
    else if (flag === "--release") opts.release = true;
    else if (flag === "--revoke") opts.revoke = true;
    else if (flag === "--newline") opts.appendNewline = true;
    else if (flag === "--port") opts.port = takeValue();
    else if (flag === "--bind") opts.bind = takeValue();
    else if (flag === "--url") opts.publicUrl = takeValue();
    else if (flag === "--app-url") opts.appUrl = takeValue();
    else if (flag === "--control-plane-url") opts.controlPlaneUrl = takeValue();
    else if (flag === "--account-token-file") opts.accountTokenFile = takeValue();
    else if (flag === "--root-token-file") opts.rootTokenFile = takeValue();
    else if (flag === "--output") opts.output = takeValue();
    else if (flag === "--account-id") opts.accountId = takeValue();
    else if (flag === "--plan") opts.plan = takeValue();
    else if (flag === "--max-routes") opts.maxRoutes = takeValue();
    else if (flag === "--max-devices-per-route") opts.maxDevicesPerRoute = takeValue();
    else if (flag === "--account-status") opts.accountStatus = takeValue();
    else if (flag === "--peer-credential-file") opts.peerCredentialFile = takeValue();
    else if (flag === "--peer-pairing-file") opts.peerPairingFile = takeValue();
    else if (flag === "--label") opts.label = takeValue();
    else if (flag === "--session") opts.sessionId = takeValue();
    else if (flag === "--peer") opts.peerId = takeValue();
    else if (flag === "--workspace") opts.workspaceId = takeValue();
    else if (flag === "--peer-url") opts.peerUrl = takeValue();
    else if (flag === "--actions") opts.actions = takeValue();
    else if (flag === "--workspaces") opts.workspaces = takeValue();
    else if (flag === "--expected-revision") opts.expectedRevision = takeValue();
    else if (flag === "--peer-status") opts.peerStatus = takeValue();
    else if (flag === "--client") opts.clientId = takeValue();
    else if (flag === "--lease") opts.leaseId = takeValue();
    else if (flag === "--agent") opts.agentId = takeValue();
    else if (flag === "--data") opts.data = takeValue();
    else if (flag === "--cwd") opts.cwd = takeValue();
    else if (flag === "--provider") opts.provider = takeValue();
    else if (flag === "--options-json") opts.optionsJson = takeValue();
    else if (flag === "--timeout-ms") opts.timeoutMs = takeValue();
    else if (flag === "--after") opts.after = takeValue();
    else if (flag === "--limit") opts.limit = takeValue();
    else if (flag === "--idempotency-key") opts.idempotencyKey = takeValue();
    else if (flag.startsWith("-")) throw new Error(`unknown option: ${flag} (run with --help)`);
    else if (opts.command === "api" && opts.apiAction === undefined) opts.apiAction = flag;
    else if (opts.command === "cloud" && opts.cloudAction === undefined) opts.cloudAction = flag;
    else if (opts.command === "cloud") {
      throw new Error(
        "unexpected cloud argument; never pass credentials inline (legacy/operator credentials use --account-token-file or --root-token-file)",
      );
    }
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
    "roamcode — operate Claude Code or Codex sessions on this machine, remotely.",
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
    "  roamcode cloud <login|logout|whoami> [options]",
    "                       Sign in to RoamCode Cloud through browser-assisted device authorization.",
    "  roamcode cloud <connect|configure|pair|status|rotate|disconnect> [options]",
    "                       After `cloud login`, connect and manage this Node through the optional",
    "                       end-to-end encrypted RoamCode Cloud relay.",
    "  roamcode cloud <account-create|account-list|account-update|account-rotate|account-recover|account-delete>",
    "                       Operate standalone relay accounts without putting credentials in argv.",
    "  roamcode api <resource|action> [options]",
    "                       Stable agent control: capabilities, attention, sessions, agents,",
    "                       workspaces, devices, team, members, policy, fleet, presence, adapters,",
    "                       peers, peer-workspaces, peer-agents, peer-sessions, peer-add,",
    "                       peer-update, peer-verify, peer-discover, peer-rotate, peer-remove,",
    "                       extensions,",
    "                       plugins, automations, events, audit, audit-verify,",
    "                       audit-export, openapi, lease, send, wait, focus, or start.",
    "",
    "Options:",
    "  --port <n>      Port to listen on (default 4280; 0 = pick a free port). Sets PORT.",
    "                  With an installed service, use --port 0 for development; the implicit 4280 is refused.",
    "  --bind <addr>   Address to bind (default 127.0.0.1). Sets BIND_ADDRESS.",
    "                  Use 0.0.0.0 ONLY behind a secure tunnel (see below).",
    "  --url <origin>  Public app origin for `roamcode pair`; standalone relay origin for `cloud`.",
    "  --app-url <origin>  Trusted app origin for `cloud configure` or standalone relay provisioning.",
    "  --control-plane-url <origin>  Account service used by `cloud login` (default https://roamcode.ai).",
    "  --account-token-file <path>  Legacy/self-host/operator relay account credential (mode 0600).",
    "                  Normal hosted connect/rotate/disconnect uses the signed-in cloud session.",
    "  --root-token-file <path>  Mode-0600 relay operator credential for account lifecycle commands.",
    "  --output <path>  Private destination for account-create/account-rotate (created atomically as 0600).",
    "                  account-recover verifies and commits its retained .pending file after an ambiguous result.",
    "  --account-id <id>  Relay account targeted by account-update/account-rotate/account-delete.",
    "  --plan <free|team|enterprise>  Standalone relay account quota preset.",
    "  --max-routes <n>  Explicit standalone relay account route quota.",
    "  --max-devices-per-route <n>  Explicit per-route device quota.",
    "  --account-status <active|suspended>  Enable or suspend a standalone relay account.",
    "  --label <name>  Privacy-preserving cloud host label (default: RoamCode host).",
    "                  Also labels a peer for `api peer-add` or `api peer-update`.",
    "  --peer <id>     Target peer for discovery, start, lease, send, wait, and focus.",
    "  --workspace <id>  Registered remote workspace for `api start --peer`.",
    "  --peer-url <origin>  HTTPS peer origin for `api peer-add`; loopback HTTP is dev-only.",
    "  --peer-pairing-file <path>  Preferred: mode-0600 file containing a one-use pairing link.",
    "  --peer-credential-file <path>  Mode-0600 remote credential for peer add/rotation.",
    "  --actions <csv>  Peer capability scope: read,wait,send,start,focus.",
    "  --workspaces <csv|*>  Peer workspace ids; * still remains bounded by RBAC and policy.",
    "  --expected-revision <n>  Optimistic revision for peer or cloud-account mutations.",
    "  --peer-status <active|suspended>  Enable or suspend a peer without deleting it.",
    "  --no-token      Loopback dev only: run without an access token. Sets NO_TOKEN=1.",
    "  --confirm       Required acknowledgement for destructive recovery commands.",
    "  --session <id>  Target for `api lease` / `api send`.",
    "  --client <id>   Stable caller id used to bind an input lease to this credential.",
    "  --lease <id>    Lease returned by `api lease`; pass it to send, renew, or release.",
    "  --takeover      With `api lease --confirm`, explicitly take input from the current writer.",
    "  --renew         Renew an owned lease instead of acquiring one.",
    "  --release       Release an owned lease.",
    "  --revoke        Administrator action: with --confirm, revoke the current writer.",
    "  --newline       Append a terminal newline for `api send`.",
    "  --agent <id>    Target for `api wait` / `api focus`.",
    "  --cwd <path>    Working directory for `api start`; pair with --provider and --options-json.",
    "  --timeout-ms <n>  Long-poll timeout for `api wait` (0-30000).",
    "  --after <n>    Cursor for event or audit reads (default 0).",
    "  --limit <n>    Audit page/export size (1-1000; default 500).",
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
    "  ROAMCODE_PEER_CREDENTIAL_FILE  Mode-0600 remote credential for peer add/rotation.",
    "  ROAMCODE_PEER_PAIRING_FILE  Mode-0600 one-use pairing link for peer add/rotation.",
    "  ROAMCODE_CLOUD_URL   Standalone relay origin (default https://relay.roamcode.ai).",
    "  ROAMCODE_CLOUD_APP_URL  Standalone relay app origin (default https://roamcode.ai).",
    "  ROAMCODE_CLOUD_CONTROL_PLANE_URL  Account service origin (default https://roamcode.ai).",
    "  ROAMCODE_CLOUD_ACCOUNT_TOKEN_FILE  Legacy/self-host relay account credential file (mode 0600).",
    "  ROAMCODE_CLOUD_ROOT_TOKEN_FILE  Mode-0600 relay operator credential file.",
    "  CLAUDE_BIN      Claude Code executable to spawn (default claude).",
    "  CODEX_BIN       Codex executable to spawn (default codex).",
    "  ROAMCODE_VAPID_SUBJECT  mailto:/https: subject for Web Push (default mailto:roamcode@localhost).",
    "  WEB_DIR         Override the served PWA dir (default the built packages/web/dist).",
    "",
    "Full reference (every variable, verified against the code): docs/configuration.md",
    "",
    "On first run a host key is generated and stored in the data dir; the CLI exposes only a",
    "five-minute, one-use pairing link. For remote access, put it behind a stable HTTPS reverse proxy",
    "— Web Push and the installable PWA require a secure context. See the README.",
  ].join("\n");
}
