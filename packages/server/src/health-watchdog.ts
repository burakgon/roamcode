import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HEALTH_INSTANCE_HEADER = "x-roamcode-instance";
export const WATCHDOG_INITIAL_DELAY_MS = 5_000;
export const WATCHDOG_INTERVAL_MS = 10_000;
export const WATCHDOG_PROBE_TIMEOUT_MS = 3_000;
export const WATCHDOG_FAILURE_THRESHOLD = 4;
export const WATCHDOG_TERMINATION_GRACE_MS = 10_000;

export interface HealthWatchdogConfig {
  parentPid: number;
  port: number;
  instanceId: string;
  initialDelayMs?: number;
  intervalMs?: number;
  probeTimeoutMs?: number;
  failureThreshold?: number;
  terminationGraceMs?: number;
}

export interface HealthWatchdogDeps {
  probe?: () => Promise<boolean>;
  parentAlive?: () => boolean;
  terminateParent?: (signal: NodeJS.Signals) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface ManagedHealthWatchdogHandle {
  stop(): void;
}

export interface StartManagedHealthWatchdogOptions {
  env: NodeJS.ProcessEnv;
  port: number;
  instanceId: string;
  parentPid?: number;
  watchdogPath?: string;
  spawnFn?: typeof spawn;
  log?: (message: string) => void;
}

function boundedInteger(value: string | undefined, min: number, max: number): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

export function parseHealthWatchdogEnv(env: NodeJS.ProcessEnv): HealthWatchdogConfig | undefined {
  const parentPid = boundedInteger(env.ROAMCODE_WATCHDOG_PARENT_PID, 2, 2 ** 31 - 1);
  const port = boundedInteger(env.ROAMCODE_WATCHDOG_PORT, 1, 65_535);
  const instanceId = env.ROAMCODE_WATCHDOG_INSTANCE_ID;
  if (!parentPid || !port || !instanceId || !/^[A-Za-z0-9_-]{16,128}$/.test(instanceId)) return undefined;
  return { parentPid, port, instanceId };
}

async function defaultProbe(config: HealthWatchdogConfig): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, {
      cache: "no-store",
      headers: { connection: "close" },
      signal: AbortSignal.timeout(config.probeTimeoutMs ?? WATCHDOG_PROBE_TIMEOUT_MS),
    });
    const matches = response.status === 200 && response.headers.get(HEALTH_INSTANCE_HEADER) === config.instanceId;
    await response.body?.cancel().catch(() => undefined);
    return matches;
  } catch {
    return false;
  }
}

function defaultParentAlive(parentPid: number): boolean {
  // Reparenting proves the original process is gone and avoids ever signalling a rapidly-reused PID.
  if (process.ppid !== parentPid) return false;
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Run in a process separate from Fastify so an event-loop wedge cannot also silence its liveness check. */
export async function runHealthWatchdog(config: HealthWatchdogConfig, deps: HealthWatchdogDeps = {}): Promise<void> {
  const probe = deps.probe ?? (() => defaultProbe(config));
  const parentAlive = deps.parentAlive ?? (() => defaultParentAlive(config.parentPid));
  const terminateParent =
    deps.terminateParent ??
    ((signal: NodeJS.Signals) => {
      try {
        process.kill(config.parentPid, signal);
      } catch {
        // The parent already exited; launchd/systemd will decide whether to restart it.
      }
    });
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const threshold = Math.max(1, config.failureThreshold ?? WATCHDOG_FAILURE_THRESHOLD);
  const intervalMs = config.intervalMs ?? WATCHDOG_INTERVAL_MS;
  const graceMs = config.terminationGraceMs ?? WATCHDOG_TERMINATION_GRACE_MS;
  let consecutiveFailures = 0;

  await sleep(config.initialDelayMs ?? WATCHDOG_INITIAL_DELAY_MS);
  while (parentAlive()) {
    const healthy = await probe().catch(() => false);
    consecutiveFailures = healthy ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= threshold) {
      log(
        `[roamcode] health watchdog observed ${consecutiveFailures} consecutive failed probes; restarting the unresponsive server`,
      );
      terminateParent("SIGTERM");
      const deadline = now() + graceMs;
      while (parentAlive() && now() < deadline) await sleep(Math.min(250, Math.max(1, deadline - now())));
      if (parentAlive()) terminateParent("SIGKILL");
      return;
    }
    await sleep(intervalMs);
  }
}

/** Spawn only for the managed launcher. The child receives no inherited credentials or user environment. */
export function startManagedHealthWatchdog(
  options: StartManagedHealthWatchdogOptions,
): ManagedHealthWatchdogHandle | undefined {
  if (options.env.ROAMCODE_MANAGED_EXEC !== "1" || options.env.ROAMCODE_DISABLE_WATCHDOG === "1") return undefined;
  const parentPid = options.parentPid ?? process.pid;
  const spawnFn = options.spawnFn ?? spawn;
  const watchdogPath = options.watchdogPath ?? fileURLToPath(new URL("./health-watchdog.js", import.meta.url));
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  let child: ChildProcess;
  try {
    child = spawnFn(process.execPath, [watchdogPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ROAMCODE_WATCHDOG_PARENT_PID: String(parentPid),
        ROAMCODE_WATCHDOG_PORT: String(options.port),
        ROAMCODE_WATCHDOG_INSTANCE_ID: options.instanceId,
      },
    });
  } catch {
    log("[roamcode] health watchdog could not be started");
    return undefined;
  }
  child.once("error", () => log("[roamcode] health watchdog could not be started"));
  child.unref();
  return {
    stop(): void {
      try {
        child.kill("SIGTERM");
      } catch {
        // It already observed the parent shutdown and exited.
      }
    },
  };
}
