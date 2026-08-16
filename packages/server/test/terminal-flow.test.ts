import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TERMINAL_FLOW_LIMITS, TerminalFlowWindow } from "../src/terminal-flow.js";

function flowRecorder() {
  const binary: Buffer[] = [];
  const text: string[] = [];
  const pressure: boolean[] = [];
  const closed: string[] = [];
  const flow = new TerminalFlowWindow({
    sendBinary: (frame) => binary.push(Buffer.from(frame)),
    sendText: (frame) => text.push(frame),
    onPressure: (value) => pressure.push(value),
    onClose: (reason) => closed.push(reason),
  });
  return { flow, binary, text, pressure, closed };
}

describe("TerminalFlowWindow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("sends at most 256 KiB in 64 KiB frames until cumulative parse progress", () => {
    const { flow, binary, pressure } = flowRecorder();
    flow.setViewing(true);
    flow.enqueueData(Buffer.alloc(TERMINAL_FLOW_LIMITS.highWatermarkBytes + 17, 0x61));

    expect(binary.map((frame) => frame.byteLength)).toEqual([65536, 65536, 65536, 65536]);
    expect(flow.unacknowledgedBytes).toBe(262144);
    expect(flow.pendingBytes).toBe(17);
    expect(pressure).toEqual([true]);

    expect(flow.acknowledge(65536)).toBe("advanced");
    expect(binary.at(-1)?.byteLength).toBe(17);
    expect(flow.sentBytes).toBe(262161);
  });

  test("keeps replay end behind all replay bytes retained by the window", () => {
    const { flow, binary, text } = flowRecorder();
    flow.enqueueControl('{"t":"terminal-replay","phase":"begin"}');
    flow.enqueueData(Buffer.alloc(262145, 0x62));
    flow.enqueueControl('{"t":"terminal-replay","phase":"end"}');

    expect(text).toEqual(['{"t":"terminal-replay","phase":"begin"}']);
    flow.acknowledge(65536);
    expect(Buffer.concat(binary).byteLength).toBe(262145);
    expect(text.at(-1)).toBe('{"t":"terminal-replay","phase":"end"}');
  });

  test("splits encoded UTF-8 bytes without changing their byte order", () => {
    const { flow, binary } = flowRecorder();
    const source = Buffer.from("🙂漢字".repeat(40_000), "utf8");
    flow.enqueueData(source);
    while (flow.pendingBytes > 0) flow.acknowledge(flow.sentBytes);
    expect(Buffer.concat(binary)).toEqual(source);
    expect(binary.every((frame) => frame.byteLength <= 65_536)).toBe(true);
  });

  test("validates cumulative ACKs without oscillating pressure", () => {
    const { flow, pressure, closed } = flowRecorder();
    flow.setViewing(true);
    flow.enqueueData(Buffer.alloc(300_000));

    expect(flow.acknowledge(Number.NaN)).toBe("invalid");
    expect(flow.acknowledge(-1)).toBe("invalid");
    expect(flow.acknowledge(1.5)).toBe("invalid");
    expect(flow.acknowledge(Number.MAX_SAFE_INTEGER + 1)).toBe("invalid");
    expect(flow.acknowledge(262145)).toBe("invalid");
    expect(flow.acknowledge(0)).toBe("ignored");
    expect(flow.acknowledge(100_000)).toBe("advanced");
    expect(flow.acknowledge(99_999)).toBe("ignored");
    expect(flow.acknowledge(100_000)).toBe("ignored");
    expect(pressure).toEqual([true]);
    expect(closed).toEqual([]);

    flow.acknowledge(flow.sentBytes - 65_537);
    expect(pressure).toEqual([true]);
    flow.acknowledge(flow.sentBytes - 65_536);
    expect(pressure).toEqual([true, false]);
  });

  test("closes a foreground stall after five seconds and releases pressure first", () => {
    const { flow, pressure, closed } = flowRecorder();
    flow.setViewing(true);
    flow.enqueueData(Buffer.alloc(300_000));
    vi.advanceTimersByTime(4_999);
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(pressure.at(-1)).toBe(false);
    expect(closed).toEqual(["stalled"]);
  });

  test("ACK progress rearms the five-second pressure deadline", () => {
    const { flow, closed } = flowRecorder();
    flow.setViewing(true);
    flow.enqueueData(Buffer.alloc(600_000));
    vi.advanceTimersByTime(4_000);
    flow.acknowledge(65_536);
    vi.advanceTimersByTime(4_999);
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(closed).toEqual(["stalled"]);
  });

  test("background overflow skips output and requests one replay only on foreground return", () => {
    const { flow, pressure, closed } = flowRecorder();
    flow.setViewing(false);
    flow.enqueueData(Buffer.alloc(300_000));
    expect(flow.needsReplay).toBe(true);
    expect(flow.pendingBytes).toBe(0);
    expect(pressure).toEqual([]);
    flow.enqueueData(Buffer.alloc(10));
    expect(flow.sentBytes).toBe(262144);
    expect(closed).toEqual([]);
    flow.setViewing(true);
    flow.setViewing(true);
    expect(closed).toEqual(["replay-required"]);
  });

  test("a healthy background subscriber can ACK without pausing or entering replay recovery", () => {
    const { flow, pressure, closed } = flowRecorder();
    flow.setViewing(false);
    flow.enqueueData(Buffer.alloc(200_000));
    expect(flow.needsReplay).toBe(false);
    expect(flow.acknowledge(200_000)).toBe("advanced");
    expect(pressure).toEqual([]);
    expect(closed).toEqual([]);
  });

  test("rejects a foreground queue above 16 MiB without allocating the rejected tail", () => {
    const { flow, closed } = flowRecorder();
    flow.setViewing(true);
    flow.enqueueData(Buffer.alloc(TERMINAL_FLOW_LIMITS.maxPendingBytes + TERMINAL_FLOW_LIMITS.highWatermarkBytes + 1));
    expect(closed).toEqual(["overflow"]);
    expect(flow.pendingBytes).toBe(0);
  });

  test("turns a socket send exception into one transport close", () => {
    const closed: string[] = [];
    const flow = new TerminalFlowWindow({
      sendBinary: () => {
        throw new Error("socket gone");
      },
      sendText: () => {},
      onPressure: () => {},
      onClose: (reason) => closed.push(reason),
    });
    flow.enqueueData("lost");
    flow.enqueueData("ignored after close");
    expect(closed).toEqual(["transport"]);
  });
});
