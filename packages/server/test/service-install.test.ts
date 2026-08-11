import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  enableService,
  renderLaunchdPlist,
  restartService,
  type ServiceCommandResult,
  type ServiceRecord,
} from "../src/service-install.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): ServiceRecord {
  const root = mkdtempSync(join(tmpdir(), "roamcode-service-control-"));
  roots.push(root);
  const path = join(root, "com.roamcode.plist");
  writeFileSync(path, "plist");
  return { manager: "launchd", label: "com.roamcode", path };
}

function runner(outcomes: Map<string, ServiceCommandResult>): {
  calls: string[];
  runCommand: (command: string, args: string[]) => ServiceCommandResult;
} {
  const calls: string[] = [];
  return {
    calls,
    runCommand(command, args) {
      const key = [command, ...args].join(" ");
      calls.push(key);
      return outcomes.get(key) ?? { status: 99, stderr: `unexpected command: ${key}` };
    },
  };
}

describe("macOS service control", () => {
  test("loads the LaunchAgent in GUI and headless background sessions", () => {
    const plist = renderLaunchdPlist({
      label: "com.roamcode",
      executablePath: "/opt/roamcode/bin/roamcode",
      dataDir: "/var/lib/roamcode",
    });

    expect(plist).toContain("<key>LimitLoadToSessionType</key>");
    expect(plist).toContain("<string>Aqua</string>");
    expect(plist).toContain("<string>Background</string>");
  });

  test("restarts a loaded headless LaunchAgent in its user domain", () => {
    const record = fixture();
    const commands = runner(
      new Map([
        ["launchctl print gui/501/com.roamcode", { status: 1 }],
        ["launchctl print user/501/com.roamcode", { status: 0 }],
        ["launchctl kickstart -k user/501/com.roamcode", { status: 0 }],
      ]),
    );

    expect(restartService(record, { uid: 501, runCommand: commands.runCommand })).toEqual({ ok: true });
    expect(commands.calls).toEqual([
      "launchctl print gui/501/com.roamcode",
      "launchctl print user/501/com.roamcode",
      "launchctl kickstart -k user/501/com.roamcode",
    ]);
  });

  test("reloads a migrated plist in the domain that already owns the service", () => {
    const record = fixture();
    const commands = runner(
      new Map([
        ["launchctl print gui/501/com.roamcode", { status: 1 }],
        ["launchctl print user/501/com.roamcode", { status: 0 }],
        ["launchctl bootout user/501/com.roamcode", { status: 0 }],
        [`launchctl bootstrap user/501 ${record.path}`, { status: 0 }],
      ]),
    );

    expect(restartService(record, { reload: true, uid: 501, runCommand: commands.runCommand })).toEqual({ ok: true });
    expect(commands.calls).toEqual([
      "launchctl print gui/501/com.roamcode",
      "launchctl print user/501/com.roamcode",
      "launchctl bootout user/501/com.roamcode",
      `launchctl bootstrap user/501 ${record.path}`,
    ]);
  });

  test("enables a stopped LaunchAgent in an available headless user domain", () => {
    const record = fixture();
    const commands = runner(
      new Map([
        ["launchctl print gui/501/com.roamcode", { status: 1 }],
        ["launchctl print user/501/com.roamcode", { status: 1 }],
        ["launchctl print gui/501", { status: 1 }],
        ["launchctl print user/501", { status: 0 }],
        ["launchctl enable user/501/com.roamcode", { status: 0 }],
        [`launchctl bootstrap user/501 ${record.path}`, { status: 0 }],
      ]),
    );

    expect(enableService(record, { uid: 501, runCommand: commands.runCommand })).toEqual({ ok: true });
    expect(commands.calls.at(-2)).toBe("launchctl enable user/501/com.roamcode");
    expect(commands.calls.at(-1)).toBe(`launchctl bootstrap user/501 ${record.path}`);
  });

  test("falls back to a domain reload when kickstart cannot restart a loaded job", () => {
    const record = fixture();
    const commands = runner(
      new Map([
        ["launchctl print gui/501/com.roamcode", { status: 1 }],
        ["launchctl print user/501/com.roamcode", { status: 0 }],
        ["launchctl kickstart -k user/501/com.roamcode", { status: 1 }],
        ["launchctl bootout user/501/com.roamcode", { status: 0 }],
        [`launchctl bootstrap user/501 ${record.path}`, { status: 0 }],
      ]),
    );

    expect(restartService(record, { uid: 501, runCommand: commands.runCommand })).toEqual({ ok: true });
    expect(commands.calls).toContain("launchctl bootout user/501/com.roamcode");
  });
});
