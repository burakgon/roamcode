import { expect, test, vi } from "vitest";
import { TERMINAL_WRITE_CHUNK_BYTES } from "../chat/terminal-output";
import { ScreenshotTerminalPerformanceHarness } from "./terminal-performance-harness";

test("bounds delivered output to four unparsed terminal chunks", async () => {
  const receipts: Array<() => void> = [];
  const delivered: Uint8Array[] = [];
  const harness = new ScreenshotTerminalPerformanceHarness((bytes, parsed) => {
    delivered.push(bytes);
    receipts.push(parsed);
  });

  const output = harness.push("x".repeat(300_000));

  expect(delivered.map((frame) => frame.byteLength)).toEqual([
    TERMINAL_WRITE_CHUNK_BYTES,
    TERMINAL_WRITE_CHUNK_BYTES,
    TERMINAL_WRITE_CHUNK_BYTES,
    TERMINAL_WRITE_CHUNK_BYTES,
  ]);
  expect(harness.snapshot().maxUnparsedBytes).toBe(4 * TERMINAL_WRITE_CHUNK_BYTES);

  receipts.shift()!();
  expect(delivered.at(-1)?.byteLength).toBe(37_856);

  while (receipts.length > 0) receipts.shift()!();
  await output;
  expect(harness.snapshot()).toMatchObject({
    sentBytes: 300_000,
    parsedBytes: 300_000,
    unparsedBytes: 0,
  });
});

test("places an input echo after delivered bytes but before synthetic output the paused PTY has not emitted", async () => {
  const receipts: Array<() => void> = [];
  const delivered: Uint8Array[] = [];
  const harness = new ScreenshotTerminalPerformanceHarness((bytes, parsed) => {
    delivered.push(bytes);
    receipts.push(parsed);
  });

  const dense = harness.push("d".repeat(600_000));
  harness.armEcho("RC_ECHO_1", performance.now());
  harness.sendInput("x");

  expect(delivered).toHaveLength(4);
  receipts.shift()!();
  expect(new TextDecoder().decode(delivered[4])).toContain("RC_ECHO_1");

  while (receipts.length > 0) receipts.shift()!();
  await dense;
  const stats = harness.snapshot();
  expect(stats.parsedFrameIds).toEqual(stats.deliveredFrameIds);
  expect(stats.maxUnparsedBytes).toBeLessThanOrEqual(4 * TERMINAL_WRITE_CHUNK_BYTES);
});

test("records visible echo only after its parse receipt and two animation frames", async () => {
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  const receipts: Array<() => void> = [];
  const now = vi.spyOn(performance, "now");
  let clock = 25;
  now.mockImplementation(() => clock);
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }) as typeof requestAnimationFrame;

  try {
    const harness = new ScreenshotTerminalPerformanceHarness((_bytes, parsed) => receipts.push(parsed));
    harness.armEcho("RC_ECHO_2", 10);
    harness.sendInput("y");

    expect(harness.snapshot().inputSendMs.RC_ECHO_2).toBe(15);
    expect(harness.snapshot().visibleEchoMs.RC_ECHO_2).toBeUndefined();

    receipts.shift()!();
    expect(frames).toHaveLength(1);
    clock = 40;
    frames.shift()!(clock);
    expect(harness.snapshot().visibleEchoMs.RC_ECHO_2).toBeUndefined();
    expect(frames).toHaveLength(1);

    clock = 55;
    frames.shift()!(clock);
    expect(harness.snapshot().visibleEchoMs.RC_ECHO_2).toBe(45);
  } finally {
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    now.mockRestore();
  }
});

test("refuses an in-flight reset and closes retained producers without later delivery", async () => {
  const receipts: Array<() => void> = [];
  const delivered: Uint8Array[] = [];
  const harness = new ScreenshotTerminalPerformanceHarness((bytes, parsed) => {
    delivered.push(bytes);
    receipts.push(parsed);
  });
  const output = harness.push("z".repeat(600_000));

  expect(() => harness.resetMetrics()).toThrow(
    new Error("cannot reset terminal performance metrics while output is in flight"),
  );
  harness.close();
  await output;

  const deliveredAtClose = delivered.length;
  for (const receipt of receipts) receipt();
  await harness.push("ignored");
  expect(delivered).toHaveLength(deliveredAtClose);
  expect(harness.snapshot().unparsedBytes).toBe(0);
});

test("records resize frames and clears settled metrics in place", async () => {
  const harness = new ScreenshotTerminalPerformanceHarness((_bytes, parsed) => parsed());
  await harness.push("ready");
  harness.recordResize(120, 40);
  expect(harness.snapshot().resizeFrames).toEqual([[120, 40]]);

  harness.resetMetrics();
  expect(harness.snapshot()).toMatchObject({
    sentBytes: 0,
    parsedBytes: 0,
    unparsedBytes: 0,
    maxUnparsedBytes: 0,
    resizeFrames: [],
    deliveredFrameIds: [],
    parsedFrameIds: [],
  });
});
