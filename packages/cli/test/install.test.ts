import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { installService, renderLaunchdPlist, renderSystemdUnit, buildServicePath } from "../src/install.js";

describe("buildServicePath", () => {
  test("prepends the node dir + homebrew + /usr/local/bin + pnpm globals, then a sane baseline", () => {
    const p = buildServicePath("/usr/local/bin/node", "/Users/me");
    const parts = p.split(":");
    // node dir wins (so the service's own node + sibling tools resolve first)
    expect(parts[0]).toBe("/usr/local/bin");
    expect(p).toContain("/opt/homebrew/bin");
    expect(p).toContain("/usr/local/bin");
    expect(p).toContain("/Users/me/.local/share/pnpm");
    expect(p).toContain("/Users/me/Library/pnpm");
    // baseline so common system tools still resolve
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
  });
});

describe("renderLaunchdPlist", () => {
  test("is a valid-looking LaunchAgent plist running node on the CLI as the login user", () => {
    const plist = renderLaunchdPlist({
      label: "com.remote-coder",
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/rc/index.js",
      dataDir: "/Users/me/.config/remote-coder",
    });
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain("<string>com.remote-coder</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/rc/index.js</string>");
    expect(plist).toContain("REMOTE_CODER_DATA_DIR");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  test("the data dir env value is the supplied dir (no embedded secret/token)", () => {
    const plist = renderLaunchdPlist({
      label: "com.remote-coder",
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/rc/index.js",
      dataDir: "/Users/me/.config/remote-coder",
    });
    expect(plist).toContain("<string>/Users/me/.config/remote-coder</string>");
    expect(plist).not.toMatch(/ACCESS_TOKEN|token/i);
  });

  test("includes a PATH EnvironmentVariables entry so the service + OTA child resolve git/pnpm/node", () => {
    const plist = renderLaunchdPlist({
      label: "com.remote-coder",
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/rc/index.js",
      dataDir: "/Users/me/.config/remote-coder",
      servicePath: "/usr/local/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/share/pnpm",
    });
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain(
      "<string>/usr/local/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/share/pnpm</string>",
    );
  });

  test("omits the PATH entry when no servicePath is supplied (back-compat)", () => {
    const plist = renderLaunchdPlist({
      label: "com.remote-coder",
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/rc/index.js",
      dataDir: "/Users/me/.config/remote-coder",
    });
    expect(plist).not.toContain("<key>PATH</key>");
  });

  test("escapes XML metacharacters in interpolated <string> values (no malformed plist)", () => {
    // A home dir containing `&`, `<`, `>` would otherwise produce malformed plist XML.
    const plist = renderLaunchdPlist({
      label: "com.remote-coder",
      nodePath: "/usr/local/bin/node",
      cliPath: "/Users/a&b/Tom <dev>/index.js",
      dataDir: "/Users/a&b/.config/remote-coder",
    });
    // The raw metacharacters must NOT appear inside the interpolated path values.
    expect(plist).not.toContain("/Users/a&b/Tom <dev>/index.js");
    // They must appear escaped instead.
    expect(plist).toContain("<string>/Users/a&amp;b/Tom &lt;dev&gt;/index.js</string>");
    expect(plist).toContain("<string>/Users/a&amp;b/.config/remote-coder</string>");
    // And the standard log paths derived from the data dir are escaped too.
    expect(plist).toContain("/Users/a&amp;b/.config/remote-coder/remote-coder.log");
  });
});

describe("renderSystemdUnit", () => {
  test("is a [Service] unit for the user manager running node on the CLI", () => {
    const unit = renderSystemdUnit({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/rc/index.js",
      dataDir: "/home/me/.config/remote-coder",
    });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/rc/index.js");
    expect(unit).toContain("Environment=REMOTE_CODER_DATA_DIR=/home/me/.config/remote-coder");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("restarts ALWAYS (incl. a clean exit, so the OTA-update SIGTERM is recovered) and never embeds a secret/token", () => {
    const unit = renderSystemdUnit({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/rc/index.js",
      dataDir: "/home/me/.config/remote-coder",
    });
    // Restart=always (not on-failure): the OTA self-update's restart fallback SIGTERMs the parent (a
    // code-0 exit), which on-failure would NOT recover — leaving the server down after an update.
    expect(unit).toContain("Restart=always");
    expect(unit).not.toMatch(/ACCESS_TOKEN|token/i);
  });

  test("includes Environment=PATH so the service + OTA child resolve git/pnpm/node", () => {
    const unit = renderSystemdUnit({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/rc/index.js",
      dataDir: "/home/me/.config/remote-coder",
      servicePath: "/usr/bin:/opt/homebrew/bin:/usr/local/bin:/home/me/.local/share/pnpm",
    });
    expect(unit).toContain("Environment=PATH=/usr/bin:/opt/homebrew/bin:/usr/local/bin:/home/me/.local/share/pnpm");
  });

  test("omits the PATH line when no servicePath is supplied (back-compat)", () => {
    const unit = renderSystemdUnit({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/rc/index.js",
      dataDir: "/home/me/.config/remote-coder",
    });
    expect(unit).not.toContain("Environment=PATH=");
  });
});

describe("installService (against a temp HOME — never the real ~)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rc-install-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("darwin writes a per-user LaunchAgent plist (~/Library/LaunchAgents) and prints launchctl", () => {
    const dataDir = join(home, ".config", "remote-coder");
    const { path, instructions } = installService({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/rc/index.js",
      dataDir,
      home,
      os: "darwin",
    });
    expect(path).toBe(join(home, "Library", "LaunchAgents", "com.remote-coder.plist"));
    const written = readFileSync(path, "utf8");
    expect(written).toContain("<string>com.remote-coder</string>");
    expect(written).toContain("<string>/opt/rc/index.js</string>");
    // A PATH env entry is written, derived from the node dir + home, so the service + OTA child resolve tools.
    expect(written).toContain("<key>PATH</key>");
    expect(written).toContain("/usr/local/bin"); // dirname(/usr/local/bin/node)
    expect(written).toContain("/opt/homebrew/bin");
    expect(written).toContain(join(home, ".local", "share", "pnpm"));
    // user-level load command, NOT a system daemon / sudo
    expect(instructions).toContain("launchctl load");
    expect(instructions).not.toMatch(/sudo|LaunchDaemons/);
    // world-readable but owner-writable only
    expect(statSync(path).mode & 0o777).toBe(0o644);
    // service.json records the launchd identity for the OTA updater's restart resolution.
    const svc = JSON.parse(readFileSync(join(dataDir, "service.json"), "utf8")) as {
      manager: string;
      label: string;
    };
    expect(svc).toEqual({ manager: "launchd", label: "com.remote-coder" });
    expect(statSync(join(dataDir, "service.json")).mode & 0o777).toBe(0o600);
  });

  test("linux writes a systemd --user unit (~/.config/systemd/user) and prints systemctl --user", () => {
    const dataDir = join(home, ".config", "remote-coder");
    const { path, instructions } = installService({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/rc/index.js",
      dataDir,
      home,
      os: "linux",
    });
    expect(path).toBe(join(home, ".config", "systemd", "user", "remote-coder.service"));
    const written = readFileSync(path, "utf8");
    expect(written).toContain("ExecStart=/usr/bin/node /opt/rc/index.js");
    expect(written).toContain("WantedBy=default.target");
    // A PATH env line is written, derived from the node dir + home, so the service + OTA child resolve tools.
    expect(written).toContain("Environment=PATH=");
    expect(written).toContain("/usr/bin"); // dirname(/usr/bin/node)
    expect(written).toContain(join(home, ".local", "share", "pnpm"));
    // user-level enable, NOT a system unit / sudo
    expect(instructions).toContain("systemctl --user");
    expect(instructions).not.toMatch(/sudo/);
    // service.json records the systemd identity for the OTA updater's restart resolution.
    const svc = JSON.parse(readFileSync(join(dataDir, "service.json"), "utf8")) as {
      manager: string;
      label: string;
    };
    expect(svc).toEqual({ manager: "systemd", label: "remote-coder" });
  });

  test("an unsupported platform errors clearly instead of writing the wrong unit", () => {
    expect(() =>
      installService({
        nodePath: "/usr/bin/node",
        cliPath: "/opt/rc/index.js",
        dataDir: join(home, ".config", "remote-coder"),
        home,
        os: "win32",
      }),
    ).toThrow(/unsupported|manually/i);
  });
});
