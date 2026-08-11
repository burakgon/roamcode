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

function runner(outcomes: ReadonlyMap<string, ServiceCommandResult | readonly ServiceCommandResult[]>): {
  calls: string[];
  runCommand: (command: string, args: string[]) => ServiceCommandResult;
} {
  const calls: string[] = [];
  const uses = new Map<string, number>();
  return {
    calls,
    runCommand(command, args) {
      const key = [command, ...args].join(" ");
      calls.push(key);
      const outcome = outcomes.get(key);
      if (!outcome) return { status: 99, stderr: `unexpected command: ${key}` };
      if (!Array.isArray(outcome)) return outcome;
      const index = uses.get(key) ?? 0;
      uses.set(key, index + 1);
      return outcome[Math.min(index, outcome.length - 1)]!;
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
        ["launchctl print user/501/com.roamcode", [{ status: 0 }, { status: 1 }]],
        ["launchctl bootout user/501/com.roamcode", { status: 0 }],
        [`launchctl bootstrap user/501 ${record.path}`, { status: 0 }],
      ]),
    );

    expect(restartService(record, { reload: true, uid: 501, runCommand: commands.runCommand })).toEqual({ ok: true });
    expect(commands.calls).toEqual([
      "launchctl print gui/501/com.roamcode",
      "launchctl print user/501/com.roamcode",
      "launchctl bootout user/501/com.roamcode",
      "launchctl print user/501/com.roamcode",
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
        ["launchctl print user/501/com.roamcode", [{ status: 0 }, { status: 1 }]],
        ["launchctl kickstart -k user/501/com.roamcode", { status: 1 }],
        ["launchctl bootout user/501/com.roamcode", { status: 0 }],
        [`launchctl bootstrap user/501 ${record.path}`, { status: 0 }],
      ]),
    );

    expect(restartService(record, { uid: 501, runCommand: commands.runCommand })).toEqual({ ok: true });
    expect(commands.calls).toContain("launchctl bootout user/501/com.roamcode");
  });

  test("retries a transient bootstrap failure while launchd retires the old job", () => {
    const record = fixture();
    const calls: string[] = [];
    const delays: number[] = [];
    let userPrints = 0;
    let bootstraps = 0;
    const runCommand = (command: string, args: string[]): ServiceCommandResult => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      if (call === "launchctl print gui/501/com.roamcode") return { status: 1 };
      if (call === "launchctl print user/501/com.roamcode") {
        userPrints += 1;
        return { status: userPrints <= 2 ? 0 : 1 };
      }
      if (call === "launchctl bootout user/501/com.roamcode") return { status: 0 };
      if (call === `launchctl bootstrap user/501 ${record.path}`) {
        bootstraps += 1;
        return bootstraps === 1 ? { status: 5, stderr: "Input/output error" } : { status: 0 };
      }
      return { status: 99, stderr: `unexpected command: ${call}` };
    };

    expect(
      restartService(record, { reload: true, uid: 501, runCommand, sleep: (delay) => delays.push(delay) }),
    ).toEqual({ ok: true });
    expect(bootstraps).toBe(2);
    expect(delays).toEqual([250, 500]);
    expect(calls).toContain("launchctl print user/501/com.roamcode");
  });

  test("fails without bootstrapping when launchd never retires the old job", () => {
    const record = fixture();
    const commands = runner(
      new Map([
        ["launchctl print gui/501/com.roamcode", { status: 1 }],
        ["launchctl print user/501/com.roamcode", { status: 0 }],
        ["launchctl bootout user/501/com.roamcode", { status: 0 }],
      ]),
    );
    const delays: number[] = [];

    expect(
      restartService(record, {
        reload: true,
        uid: 501,
        runCommand: commands.runCommand,
        sleep: (delay) => delays.push(delay),
      }),
    ).toEqual({ ok: false, error: "launchctl bootout did not retire the service" });
    expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000]);
    expect(commands.calls.some((call) => call.startsWith("launchctl bootstrap "))).toBe(false);
  });
});
