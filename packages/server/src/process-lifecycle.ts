import { homedir } from "node:os";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_ERROR_SUMMARY_BYTES = 2_000;

export interface ProcessLifecycleTarget {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code: number): never | void;
}

export interface ProcessLifecycleOptions {
  /** Close only on an intentional signal. Fatal errors exit immediately because process state is unknown. */
  close: () => void | Promise<unknown>;
  target?: ProcessLifecycleTarget;
  log?: (message: string) => void;
  shutdownTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface ProcessLifecycleHandle {
  dispose(): void;
}

function replaceAllLiteral(value: string, needle: string, replacement: string): string {
  return needle ? value.split(needle).join(replacement) : value;
}

/**
 * Keep fatal diagnostics useful without copying bearer credentials, pairing links, or a maintainer's absolute
 * home path into service logs. The summary deliberately uses Error.message rather than the full stack.
 */
export function safeProcessErrorSummary(reason: unknown, home = homedir()): string {
  const source = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  const redacted = replaceAllLiteral(source, home, "~")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/([?&#](?:token|access_token|pair|secret|credential)=)[^\s&#]+/gi, "$1[redacted]")
    .replace(/\b(?:rcp|rcd|rcr|rc)_[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
  return Buffer.from(redacted, "utf8").subarray(0, MAX_ERROR_SUMMARY_BYTES).toString("utf8") || "unknown error";
}

/**
 * Own the process boundary for the always-on server.
 *
 * Intentional SIGTERM/SIGINT gets a bounded graceful close. An uncaught exception or unhandled rejection is
 * different: Node cannot promise that application state remains valid, so the process exits non-zero immediately
 * and lets launchd/systemd restart it. Keeping a possibly-corrupt process alive is how a listener can remain bound
 * while every HTTP request stalls indefinitely.
 */
export function installProcessLifecycle(options: ProcessLifecycleOptions): ProcessLifecycleHandle {
  const target = options.target ?? (process as unknown as ProcessLifecycleTarget);
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let stopping = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;

  const exit = (code: number): void => {
    if (forceTimer) {
      clearTimer(forceTimer);
      forceTimer = undefined;
    }
    target.exit(code);
  };

  const shutdown = (signal: "SIGTERM" | "SIGINT"): void => {
    if (stopping) return;
    stopping = true;
    log(`[roamcode] received ${signal}; closing the server`);
    forceTimer = setTimer(() => {
      log(`[roamcode] graceful shutdown exceeded ${shutdownTimeoutMs}ms; exiting for supervisor recovery`);
      exit(1);
    }, shutdownTimeoutMs);
    if (typeof forceTimer.unref === "function") forceTimer.unref();
    void Promise.resolve()
      .then(options.close)
      .then(
        () => exit(0),
        (error: unknown) => {
          log(`[roamcode] graceful shutdown failed: ${safeProcessErrorSummary(error)}`);
          exit(1);
        },
      );
  };

  const fatal = (kind: "uncaught exception" | "unhandled rejection", reason: unknown): void => {
    if (stopping) return;
    stopping = true;
    log(
      `[roamcode] ${kind}: ${safeProcessErrorSummary(reason)}; exiting so the service supervisor can restart a clean process`,
    );
    // Do not attempt asynchronous cleanup from an unknown/corrupt state. Terminal work lives in tmux and the
    // SQLite stores use durable transactions; the service supervisor owns process recovery.
    exit(1);
  };

  const onSigterm = (): void => shutdown("SIGTERM");
  const onSigint = (): void => shutdown("SIGINT");
  const onUncaught = (error: unknown): void => fatal("uncaught exception", error);
  const onUnhandled = (reason: unknown): void => fatal("unhandled rejection", reason);

  target.once("SIGTERM", onSigterm);
  target.once("SIGINT", onSigint);
  target.once("uncaughtException", onUncaught);
  target.once("unhandledRejection", onUnhandled);

  return {
    dispose(): void {
      target.off("SIGTERM", onSigterm);
      target.off("SIGINT", onSigint);
      target.off("uncaughtException", onUncaught);
      target.off("unhandledRejection", onUnhandled);
      if (forceTimer) clearTimer(forceTimer);
      forceTimer = undefined;
    },
  };
}
