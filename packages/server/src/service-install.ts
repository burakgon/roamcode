import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function quoteSystemd(value: string): string {
  return /[\s\"\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"')}"` : value;
}

export function buildServicePath(nodePath: string, home: string): string {
  return [
    dirname(nodePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".local", "share", "pnpm"),
    join(home, "Library", "pnpm"),
    "/usr/bin",
    "/bin",
  ].join(":");
}

export interface RenderLaunchdOptions {
  label: string;
  nodePath?: string;
  cliPath?: string;
  executablePath?: string;
  dataDir: string;
  installRoot?: string;
  servicePath?: string;
}

function programArguments(opts: Pick<RenderLaunchdOptions, "nodePath" | "cliPath" | "executablePath">): string[] {
  if (opts.executablePath) return [opts.executablePath];
  if (opts.nodePath && opts.cliPath) return [opts.nodePath, opts.cliPath];
  throw new Error("service requires executablePath or nodePath + cliPath");
}

export function renderLaunchdPlist(opts: RenderLaunchdOptions): string {
  const args = programArguments(opts)
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  const pathEntry = opts.servicePath
    ? `\n    <key>PATH</key>\n    <string>${escapeXml(opts.servicePath)}</string>`
    : "";
  const installEntry = opts.installRoot
    ? `\n    <key>ROAMCODE_INSTALL_ROOT</key>\n    <string>${escapeXml(opts.installRoot)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROAMCODE_DATA_DIR</key>
    <string>${escapeXml(opts.dataDir)}</string>${installEntry}${pathEntry}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(opts.dataDir, "roamcode.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(opts.dataDir, "roamcode.err.log"))}</string>
</dict>
</plist>
`;
}

export interface RenderSystemdOptions {
  nodePath?: string;
  cliPath?: string;
  executablePath?: string;
  dataDir: string;
  installRoot?: string;
  servicePath?: string;
}

export function renderSystemdUnit(opts: RenderSystemdOptions): string {
  const command = programArguments(opts).map(quoteSystemd).join(" ");
  const pathLine = opts.servicePath ? `\nEnvironment=PATH=${opts.servicePath}` : "";
  const installLine = opts.installRoot ? `\nEnvironment=ROAMCODE_INSTALL_ROOT=${opts.installRoot}` : "";
  return `[Unit]
Description=roamcode — operate Claude Code or Codex sessions remotely
After=network-online.target

[Service]
ExecStart=${command}
Environment=ROAMCODE_DATA_DIR=${opts.dataDir}${installLine}${pathLine}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

export interface ServiceRecord {
  manager: "launchd" | "systemd";
  label: string;
  path: string;
  launcherPath?: string;
  installRoot?: string;
}

export interface InstallServiceContext {
  nodePath: string;
  cliPath?: string;
  executablePath?: string;
  dataDir: string;
  installRoot?: string;
  home?: string;
  os?: NodeJS.Platform;
  label?: string;
}

export interface InstallServiceResult {
  path: string;
  instructions: string;
  record: ServiceRecord;
}

function persistRecord(dataDir: string, record: ServiceRecord): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "service.json");
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function installService(ctx: InstallServiceContext): InstallServiceResult {
  const home = ctx.home ?? homedir();
  const os = ctx.os ?? platform();
  const servicePath = buildServicePath(ctx.nodePath, home);
  if (os === "darwin") {
    const label = ctx.label ?? "com.roamcode";
    const dir = join(home, "Library", "LaunchAgents");
    const path = join(dir, `${label}.plist`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      renderLaunchdPlist({
        label,
        nodePath: ctx.nodePath,
        cliPath: ctx.cliPath,
        executablePath: ctx.executablePath,
        dataDir: ctx.dataDir,
        installRoot: ctx.installRoot,
        servicePath,
      }),
    );
    chmodSync(path, 0o644);
    const record: ServiceRecord = {
      manager: "launchd",
      label,
      path,
      ...(ctx.executablePath ? { launcherPath: ctx.executablePath } : {}),
      ...(ctx.installRoot ? { installRoot: ctx.installRoot } : {}),
    };
    persistRecord(ctx.dataDir, record);
    return {
      path,
      record,
      instructions: `launchctl load -w "${path}"   # start now + at login\nlaunchctl unload -w "${path}"  # stop`,
    };
  }
  if (os === "linux") {
    const label = ctx.label ?? "roamcode";
    const dir = join(home, ".config", "systemd", "user");
    const path = join(dir, `${label}.service`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      renderSystemdUnit({
        nodePath: ctx.nodePath,
        cliPath: ctx.cliPath,
        executablePath: ctx.executablePath,
        dataDir: ctx.dataDir,
        installRoot: ctx.installRoot,
        servicePath,
      }),
    );
    chmodSync(path, 0o644);
    const record: ServiceRecord = {
      manager: "systemd",
      label,
      path,
      ...(ctx.executablePath ? { launcherPath: ctx.executablePath } : {}),
      ...(ctx.installRoot ? { installRoot: ctx.installRoot } : {}),
    };
    persistRecord(ctx.dataDir, record);
    return {
      path,
      record,
      instructions: [
        "systemctl --user daemon-reload",
        `systemctl --user enable --now ${label}   # start now + at login`,
        `systemctl --user disable --now ${label}  # stop`,
        "(run 'loginctl enable-linger $USER' so it runs without an active login session)",
      ].join("\n"),
    };
  }
  throw new Error(`unsupported platform: ${os} — run roamcode manually or under a user-level supervisor`);
}

export function readServiceRecord(dataDir: string): ServiceRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, "service.json"), "utf8")) as Partial<ServiceRecord>;
    if ((parsed.manager !== "launchd" && parsed.manager !== "systemd") || typeof parsed.label !== "string") {
      return undefined;
    }
    const fallbackPath =
      parsed.manager === "launchd"
        ? join(homedir(), "Library", "LaunchAgents", `${parsed.label}.plist`)
        : join(homedir(), ".config", "systemd", "user", `${parsed.label}.service`);
    return { ...parsed, path: typeof parsed.path === "string" ? parsed.path : fallbackPath } as ServiceRecord;
  } catch {
    return undefined;
  }
}

export function migrateServiceToLauncher(opts: {
  dataDir: string;
  installRoot: string;
  launcherPath: string;
  nodePath: string;
}): ServiceRecord | undefined {
  const current = readServiceRecord(opts.dataDir);
  if (!current) return undefined;
  return installService({
    nodePath: opts.nodePath,
    executablePath: opts.launcherPath,
    dataDir: opts.dataDir,
    installRoot: opts.installRoot,
    os: current.manager === "launchd" ? "darwin" : "linux",
    label: current.label,
  }).record;
}

export function restartService(record: ServiceRecord): { ok: boolean; error?: string } {
  if (!existsSync(record.path)) return { ok: false, error: `service file not found: ${record.path}` };
  if (record.manager === "launchd") {
    spawnSync("launchctl", ["unload", record.path], { stdio: "ignore" });
    const res = spawnSync("launchctl", ["load", "-w", record.path], { encoding: "utf8" });
    return res.status === 0 ? { ok: true } : { ok: false, error: res.stderr || "launchctl load failed" };
  }
  const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  if (reload.status !== 0) return { ok: false, error: reload.stderr || "systemctl daemon-reload failed" };
  const restart = spawnSync("systemctl", ["--user", "restart", record.label], { encoding: "utf8" });
  return restart.status === 0 ? { ok: true } : { ok: false, error: restart.stderr || "systemctl restart failed" };
}

/** Enable the per-user service and start it immediately. This is only called by the explicit
 * `roamcode install` command; OTA updates use restartService and never change enablement. */
export function enableService(record: ServiceRecord): { ok: boolean; error?: string } {
  if (!existsSync(record.path)) return { ok: false, error: `service file not found: ${record.path}` };
  if (record.manager === "launchd") {
    spawnSync("launchctl", ["unload", record.path], { stdio: "ignore" });
    const result = spawnSync("launchctl", ["load", "-w", record.path], { encoding: "utf8" });
    return result.status === 0 ? { ok: true } : { ok: false, error: result.stderr || "launchctl load failed" };
  }
  const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  if (reload.status !== 0) return { ok: false, error: reload.stderr || "systemctl daemon-reload failed" };
  const result = spawnSync("systemctl", ["--user", "enable", "--now", record.label], { encoding: "utf8" });
  return result.status === 0 ? { ok: true } : { ok: false, error: result.stderr || "systemctl enable failed" };
}
