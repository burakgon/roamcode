import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

/**
 * Escape the five XML metacharacters so an interpolated path containing `&`, `<`, `>`, `"`, or `'`
 * can't break out of a plist `<string>` element (malformed XML). Used for every value we splice into
 * the plist below — a home dir like `/Users/a&b` is otherwise invalid plist XML.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the PATH the per-user service (and any OTA-spawned child it forks) needs so a bare
 * `git`/`pnpm`/`node` resolves. launchd / `systemd --user` hand a service a MINIMAL PATH that usually
 * lacks the node dir, homebrew, and pnpm's global bin — the #1 cause of an OTA update failing under the
 * service when it works in a login shell. We PREPEND, in priority order: the dir of the node binary the
 * service runs (so the service's own node + its sibling tools win), homebrew, /usr/local/bin, and pnpm's
 * global bin locations; then a sane baseline (`/usr/bin:/bin`) so common system tools still resolve.
 *
 * Derived from `nodePath` (the node binary the service is configured to run) + `home`, both known at
 * install time — no runtime PATH is captured (a service has none to inherit anyway).
 */
export function buildServicePath(nodePath: string, home: string): string {
  const nodeDir = dirname(nodePath);
  return [
    nodeDir,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "share", "pnpm"),
    join(home, "Library", "pnpm"),
    "/usr/bin",
    "/bin",
  ].join(":");
}

export interface RenderLaunchdOptions {
  label: string;
  nodePath: string;
  cliPath: string;
  dataDir: string;
  /** PATH for the service env (see buildServicePath) so the service + any OTA-spawned child resolve
   *  git/pnpm/node. Omitted in older callers/tests → the PATH entry is left out (back-compat). */
  servicePath?: string;
}

/**
 * A launchd LaunchAgent plist (per-user, `~/Library/LaunchAgents`) that keeps remote-coder running.
 *
 * It is a LaunchAgent — NOT a LaunchDaemon — so it runs as the LOGIN user and drives the user's real
 * `claude`, files, and `~/.claude`. No secret is embedded: the access token lives in the data dir,
 * which the service reads at runtime; the plist only references the data dir, never the token.
 */
export function renderLaunchdPlist(opts: RenderLaunchdOptions): string {
  // Every interpolated value is XML-escaped so a path with `&`/`<`/`>` can't corrupt the plist.
  const label = escapeXml(opts.label);
  const nodePath = escapeXml(opts.nodePath);
  const cliPath = escapeXml(opts.cliPath);
  const dataDir = escapeXml(opts.dataDir);
  const stdoutPath = escapeXml(join(opts.dataDir, "remote-coder.log"));
  const stderrPath = escapeXml(join(opts.dataDir, "remote-coder.err.log"));
  // PATH so the service + any OTA-spawned child resolve git/pnpm/node under launchd's minimal PATH.
  const pathEntry = opts.servicePath
    ? `\n    <key>PATH</key>\n    <string>${escapeXml(opts.servicePath)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REMOTE_CODER_DATA_DIR</key>
    <string>${dataDir}</string>${pathEntry}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
</dict>
</plist>
`;
}

export interface RenderSystemdOptions {
  nodePath: string;
  cliPath: string;
  dataDir: string;
  /** PATH for the service env (see buildServicePath) so the service + any OTA-spawned child resolve
   *  git/pnpm/node. Omitted in older callers/tests → the Environment=PATH line is left out (back-compat). */
  servicePath?: string;
}

/**
 * A systemd --user unit (per-user, `~/.config/systemd/user`) — runs as the login user, NOT root.
 *
 * `Restart=always` keeps it alive across crashes AND across a CLEAN exit — the OTA self-update's
 * restart fallback SIGTERMs this process (a clean exit), so the supervisor must bring it back even
 * then (`on-failure` would NOT restart a code-0 exit, stranding the server down after an update).
 * `WantedBy=default.target` starts it at login. Like the plist, no token is embedded — only the data
 * dir the service reads the token from.
 *
 * LIMITATION: `ExecStart` splits on unquoted whitespace, so a `nodePath`/`cliPath` containing a space
 * is NOT supported here (systemd would treat the space as an argument separator). In practice
 * `process.execPath` (node) and the installed CLI path have no spaces; if yours does, edit the written
 * unit to quote the path. The macOS plist above has no such limitation (each arg is its own
 * `<string>`). `REMOTE_CODER_DATA_DIR` is set via `Environment=` so a space in the data dir is fine.
 */
export function renderSystemdUnit(opts: RenderSystemdOptions): string {
  // PATH so the service + any OTA-spawned child resolve git/pnpm/node under `systemd --user`'s minimal
  // PATH. systemd `Environment=` values are space-separated, but a PATH (colon-separated, no spaces) is
  // safe unquoted; node/cli paths with spaces are the documented ExecStart limitation below.
  const pathLine = opts.servicePath ? `\nEnvironment=PATH=${opts.servicePath}` : "";
  return `[Unit]
Description=remote-coder — operate Claude Code sessions remotely
After=network-online.target

[Service]
ExecStart=${opts.nodePath} ${opts.cliPath}
Environment=REMOTE_CODER_DATA_DIR=${opts.dataDir}${pathLine}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

export interface InstallContext {
  nodePath: string;
  cliPath: string;
  dataDir: string;
  /** Override the home dir (tests inject a temp HOME so they never touch the real `~`). */
  home?: string;
  /** Override the platform (tests exercise both branches + the unsupported case). */
  os?: NodeJS.Platform;
}

export interface InstallResult {
  path: string;
  instructions: string;
}

/**
 * Persist {manager,label} to `<dataDir>/service.json` so the OTA self-updater can restart THIS exact
 * service after a build — cross-install, without re-deriving the label. The updater reads this first
 * (then env REMOTE_CODER_SERVICE_*; then a platform default). 0600 — no secret, but keep it tidy.
 */
function writeServiceJson(dataDir: string, manager: "launchd" | "systemd", label: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "service.json");
  writeFileSync(path, JSON.stringify({ manager, label }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Write the per-user service unit and return the path + the commands the user should run to load it.
 *
 * It does NOT auto-load (`launchctl load` / `systemctl --user enable`) — it writes the reviewable
 * unit and PRINTS the load command so the user explicitly opts in. The file is `0o644` (owner-write,
 * world-read); since no secret is embedded that is safe.
 */
export function installService(ctx: InstallContext): InstallResult {
  const home = ctx.home ?? homedir();
  const os = ctx.os ?? platform();

  if (os === "darwin") {
    const dir = join(home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "com.remote-coder.plist");
    writeFileSync(
      path,
      renderLaunchdPlist({
        label: "com.remote-coder",
        nodePath: ctx.nodePath,
        cliPath: ctx.cliPath,
        dataDir: ctx.dataDir,
        servicePath: buildServicePath(ctx.nodePath, home),
      }),
    );
    chmodSync(path, 0o644);
    // Record the service identity so the OTA updater can restart this exact LaunchAgent.
    writeServiceJson(ctx.dataDir, "launchd", "com.remote-coder");
    return {
      path,
      instructions: `launchctl load -w "${path}"   # start now + at login\nlaunchctl unload -w "${path}"  # stop`,
    };
  }

  if (os === "linux") {
    const dir = join(home, ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "remote-coder.service");
    writeFileSync(
      path,
      renderSystemdUnit({
        nodePath: ctx.nodePath,
        cliPath: ctx.cliPath,
        dataDir: ctx.dataDir,
        servicePath: buildServicePath(ctx.nodePath, home),
      }),
    );
    chmodSync(path, 0o644);
    // Record the service identity so the OTA updater can restart this exact --user unit.
    writeServiceJson(ctx.dataDir, "systemd", "remote-coder");
    return {
      path,
      instructions: [
        "systemctl --user daemon-reload",
        "systemctl --user enable --now remote-coder   # start now + at login",
        "systemctl --user disable --now remote-coder  # stop",
        "(run 'loginctl enable-linger $USER' so it runs without an active login session)",
      ].join("\n"),
    };
  }

  throw new Error(
    `unsupported platform: ${os} — no per-user service template. ` +
      `Run \`remote-coder\` manually (or under your platform's own user-level supervisor).`,
  );
}
