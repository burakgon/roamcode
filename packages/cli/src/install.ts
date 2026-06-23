import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

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

export interface RenderLaunchdOptions {
  label: string;
  nodePath: string;
  cliPath: string;
  dataDir: string;
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
    <string>${dataDir}</string>
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
}

/**
 * A systemd --user unit (per-user, `~/.config/systemd/user`) — runs as the login user, NOT root.
 *
 * `Restart=on-failure` keeps it alive across crashes; `WantedBy=default.target` starts it at login.
 * Like the plist, no token is embedded — only the data dir the service reads the token from.
 *
 * LIMITATION: `ExecStart` splits on unquoted whitespace, so a `nodePath`/`cliPath` containing a space
 * is NOT supported here (systemd would treat the space as an argument separator). In practice
 * `process.execPath` (node) and the installed CLI path have no spaces; if yours does, edit the written
 * unit to quote the path. The macOS plist above has no such limitation (each arg is its own
 * `<string>`). `REMOTE_CODER_DATA_DIR` is set via `Environment=` so a space in the data dir is fine.
 */
export function renderSystemdUnit(opts: RenderSystemdOptions): string {
  return `[Unit]
Description=remote-coder — operate Claude Code sessions remotely
After=network-online.target

[Service]
ExecStart=${opts.nodePath} ${opts.cliPath}
Environment=REMOTE_CODER_DATA_DIR=${opts.dataDir}
Restart=on-failure
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
      }),
    );
    chmodSync(path, 0o644);
    return {
      path,
      instructions: `launchctl load -w "${path}"   # start now + at login\nlaunchctl unload -w "${path}"  # stop`,
    };
  }

  if (os === "linux") {
    const dir = join(home, ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "remote-coder.service");
    writeFileSync(path, renderSystemdUnit({ nodePath: ctx.nodePath, cliPath: ctx.cliPath, dataDir: ctx.dataDir }));
    chmodSync(path, 0o644);
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
