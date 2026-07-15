import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  installProcessLifecycle,
  safeProcessErrorSummary,
  type ProcessLifecycleTarget,
} from "../src/process-lifecycle.js";

class FakeProcess extends EventEmitter {
  readonly exit = vi.fn<(code: number) => void>();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("process lifecycle", () => {
  test("fatal errors exit non-zero immediately instead of keeping a potentially wedged process alive", () => {
    const target = new FakeProcess();
    const close = vi.fn();
    const messages: string[] = [];
    const lifecycle = installProcessLifecycle({
      target: target as unknown as ProcessLifecycleTarget,
      close,
      log: (message) => messages.push(message),
    });

    target.emit("uncaughtException", new Error("broken invariant"));

    expect(close).not.toHaveBeenCalled();
    expect(target.exit).toHaveBeenCalledWith(1);
    expect(messages.join("\n")).toMatch(/supervisor can restart a clean process/);
    lifecycle.dispose();
  });

  test("intentional termination closes once and exits cleanly", async () => {
    const target = new FakeProcess();
    const close = vi.fn(async () => undefined);
    const lifecycle = installProcessLifecycle({
      target: target as unknown as ProcessLifecycleTarget,
      close,
      log: () => undefined,
    });

    target.emit("SIGTERM");
    target.emit("SIGINT");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(close).toHaveBeenCalledTimes(1);
    expect(target.exit).toHaveBeenCalledWith(0);
    lifecycle.dispose();
  });

  test("a stuck graceful close is bounded so the service supervisor can recover", async () => {
    vi.useFakeTimers();
    const target = new FakeProcess();
    const lifecycle = installProcessLifecycle({
      target: target as unknown as ProcessLifecycleTarget,
      close: () => new Promise(() => undefined),
      log: () => undefined,
      shutdownTimeoutMs: 25,
    });

    target.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(25);

    expect(target.exit).toHaveBeenCalledWith(1);
    lifecycle.dispose();
  });

  test("fatal summaries redact credentials and normalize the home directory", () => {
    const summary = safeProcessErrorSummary(
      new Error(
        "Bearer top-secret https://host.test/?token=abc123&pair=rcp_abcdefghijklmnopqrstuvwxyz123456 /private/home/me/file",
      ),
      "/private/home/me",
    );
    expect(summary).toContain("Bearer [redacted]");
    expect(summary).toContain("token=[redacted]");
    expect(summary).toContain("pair=[redacted]");
    expect(summary).toContain("~/file");
    expect(summary).not.toContain("top-secret");
    expect(summary).not.toContain("abc123");
  });
});
