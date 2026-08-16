import { afterEach, expect, test, vi } from "vitest";
import { fitTerminalPreservingViewport, TerminalResizeCoordinator } from "./terminal-resize";

function resizeFixture() {
  let proposed = { cols: 80, rows: 24 };
  const target = {
    cols: 80,
    rows: 24,
    proposeDimensions: () => proposed,
    fitPreservingViewport: vi.fn(() => {
      target.cols = proposed.cols;
      target.rows = proposed.rows;
    }),
  };
  const sent: Array<[number, number]> = [];
  const frames: FrameRequestCallback[] = [];
  const coordinator = new TerminalResizeCoordinator(target, (cols, rows) => sent.push([cols, rows]), {
    requestFrame: (callback) => (frames.push(callback), frames.length),
    cancelFrame: vi.fn(),
  });
  return {
    target,
    sent,
    frames,
    coordinator,
    setProposed: (cols: number, rows: number) => void (proposed = { cols, rows }),
  };
}

afterEach(() => vi.useRealTimers());

test("coalesces unchanged requests without fitting or sending", () => {
  vi.useFakeTimers();
  const { coordinator, target, frames, sent } = resizeFixture();
  coordinator.request();
  coordinator.request();
  expect(frames).toHaveLength(1);
  frames.shift()!(0);
  vi.advanceTimersByTime(80);
  expect(target.fitPreservingViewport).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
});

test("sends only the final dimensions after an 80 ms burst", () => {
  vi.useFakeTimers();
  const { coordinator, frames, sent, setProposed } = resizeFixture();
  coordinator.connectionOpened();
  expect(sent).toEqual([[80, 24]]);
  setProposed(90, 28);
  coordinator.request();
  frames.shift()!(0);
  vi.advanceTimersByTime(40);
  setProposed(100, 30);
  coordinator.request();
  frames.shift()!(16);
  vi.advanceTimersByTime(79);
  expect(sent).toEqual([[80, 24]]);
  vi.advanceTimersByTime(1);
  expect(sent).toEqual([
    [80, 24],
    [100, 30],
  ]);
});

test("forces one current-size send on every physical connection", () => {
  const { coordinator, sent } = resizeFixture();
  coordinator.connectionOpened();
  coordinator.connectionOpened();
  expect(sent).toEqual([
    [80, 24],
    [80, 24],
  ]);
});

test("restores a deliberately scrolled normal buffer after fit but leaves bottom and alternate buffers alone", () => {
  const active: { type: "normal" | "alternate"; viewportY: number; baseY: number } = {
    type: "normal",
    viewportY: 40,
    baseY: 100,
  };
  const scrollToLine = vi.fn();
  fitTerminalPreservingViewport({
    active,
    fit: () => Object.assign(active, { viewportY: 120, baseY: 120 }),
    scrollToLine,
  });
  expect(scrollToLine).toHaveBeenCalledWith(40);

  scrollToLine.mockClear();
  Object.assign(active, { viewportY: 120, baseY: 120 });
  fitTerminalPreservingViewport({ active, fit: () => {}, scrollToLine });
  expect(scrollToLine).not.toHaveBeenCalled();

  active.type = "alternate";
  active.viewportY = 5;
  active.baseY = 10;
  fitTerminalPreservingViewport({
    active,
    fit: () => Object.assign(active, { viewportY: 10 }),
    scrollToLine,
  });
  expect(scrollToLine).not.toHaveBeenCalled();
});
