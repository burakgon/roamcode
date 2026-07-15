import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { parseHealthWatchdogEnv, runHealthWatchdog, startManagedHealthWatchdog } from "../src/health-watchdog.js";

describe("managed health watchdog", () => {
  test("parses only bounded process, port, and boot-identity input", () => {
    expect(
      parseHealthWatchdogEnv({
        ROAMCODE_WATCHDOG_PARENT_PID: "42",
        ROAMCODE_WATCHDOG_PORT: "4280",
        ROAMCODE_WATCHDOG_INSTANCE_ID: "instance_abcdefghijklmnop",
      }),
    ).toMatchObject({ parentPid: 42, port: 4280, instanceId: "instance_abcdefghijklmnop" });
    expect(parseHealthWatchdogEnv({ ROAMCODE_WATCHDOG_PARENT_PID: "1" })).toBeUndefined();
    expect(
      parseHealthWatchdogEnv({
        ROAMCODE_WATCHDOG_PARENT_PID: "42",
        ROAMCODE_WATCHDOG_PORT: "70000",
        ROAMCODE_WATCHDOG_INSTANCE_ID: "too-short",
      }),
    ).toBeUndefined();
  });

  test("requires consecutive failures and resets the counter after a healthy response", async () => {
    const results = [false, false, true, false, false, false, false];
    let alive = true;
    const signals: NodeJS.Signals[] = [];
    await runHealthWatchdog(
      {
        parentPid: 42,
        port: 4280,
        instanceId: "instance_abcdefghijklmnop",
        initialDelayMs: 0,
        intervalMs: 0,
        failureThreshold: 4,
      },
      {
        probe: async () => results.shift() ?? false,
        parentAlive: () => alive,
        terminateParent: (signal) => {
          signals.push(signal);
          alive = false;
        },
        sleep: async () => undefined,
        log: () => undefined,
      },
    );
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("escalates to SIGKILL only when a wedged parent ignores the graceful signal", async () => {
    let alive = true;
    let clock = 0;
    const signals: NodeJS.Signals[] = [];
    await runHealthWatchdog(
      {
        parentPid: 42,
        port: 4280,
        instanceId: "instance_abcdefghijklmnop",
        initialDelayMs: 0,
        intervalMs: 0,
        failureThreshold: 1,
        terminationGraceMs: 500,
      },
      {
        probe: async () => false,
        parentAlive: () => alive,
        terminateParent: (signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") alive = false;
        },
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        now: () => clock,
        log: () => undefined,
      },
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("spawns only for managed installs and passes no inherited credentials to the helper", () => {
    const child = new EventEmitter() as EventEmitter & {
      unref: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
    };
    child.unref = vi.fn();
    child.kill = vi.fn();
    const spawnFn = vi.fn(() => child);

    const handle = startManagedHealthWatchdog({
      env: { ROAMCODE_MANAGED_EXEC: "1", ACCESS_TOKEN: "must-not-leak", PRIVATE_SETTING: "nope" },
      port: 4280,
      instanceId: "instance_abcdefghijklmnop",
      parentPid: 42,
      watchdogPath: "/isolated/health-watchdog.js",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      log: () => undefined,
    });
    expect(handle).toBeDefined();

    const options = spawnFn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env).toEqual({
      ROAMCODE_WATCHDOG_PARENT_PID: "42",
      ROAMCODE_WATCHDOG_PORT: "4280",
      ROAMCODE_WATCHDOG_INSTANCE_ID: "instance_abcdefghijklmnop",
    });
    expect(options.env).not.toHaveProperty("ACCESS_TOKEN");
    expect(child.unref).toHaveBeenCalled();
    handle?.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(
      startManagedHealthWatchdog({
        env: {},
        port: 4280,
        instanceId: "instance_abcdefghijklmnop",
        spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      }),
    ).toBeUndefined();
    expect(
      startManagedHealthWatchdog({
        env: { ROAMCODE_MANAGED_EXEC: "1", ROAMCODE_DISABLE_WATCHDOG: "1" },
        port: 4280,
        instanceId: "instance_abcdefghijklmnop",
        spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
      }),
    ).toBeUndefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
