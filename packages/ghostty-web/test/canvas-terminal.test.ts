// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhosttyCanvasTerminal, MouseAction, MouseButton } from "../src/index";
import type { GhosttyRuntime, GhosttyTerminalCore } from "../src/runtime";
import type { GhosttyFrame, GhosttyMouseInput } from "../src/types";

const EMPTY_FRAME: GhosttyFrame = {
  cols: 80,
  rows: 0,
  cells: [],
  foreground: "#fff",
  background: "#000",
  cursor: { x: 0, y: 0, visible: false, style: "block", color: "#fff" },
};

function canvasContext(): CanvasRenderingContext2D {
  return {
    measureText: () =>
      ({
        width: 8,
        actualBoundingBoxAscent: 11,
        actualBoundingBoxDescent: 3,
      }) as TextMetrics,
    setTransform: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function createTerminal(mouseCaptured: boolean) {
  const encodeMouse = vi.fn((input: GhosttyMouseInput) => {
    if (!mouseCaptured || input.button !== MouseButton.Right) return new Uint8Array();
    return new TextEncoder().encode(input.action === MouseAction.Press ? "right-press" : "right-release");
  });
  const core = {
    cols: 80,
    rows: 24,
    resize: vi.fn(),
    snapshot: vi.fn(() => EMPTY_FRAME),
    encodeMouse,
    cancelSelection: vi.fn(),
    selectWordAt: vi.fn(() => true),
    dispose: vi.fn(),
  } as unknown as GhosttyTerminalCore;
  const runtime = {
    createTerminal: vi.fn(() => core),
  } as unknown as GhosttyRuntime;
  const onInput = vi.fn();
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: 640 },
    clientHeight: { configurable: true, value: 384 },
  });
  document.body.append(host);
  const terminal = new GhosttyCanvasTerminal(runtime, host, {
    onInput,
    onResize: vi.fn(),
  });
  const canvas = host.querySelector<HTMLCanvasElement>(".rc-ghostty-canvas");
  if (!canvas) throw new Error("Ghostty canvas was not mounted");
  canvas.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 640,
      bottom: 384,
      width: 640,
      height: 384,
      toJSON: () => ({}),
    }) as DOMRect;
  return { canvas, core, encodeMouse, host, onInput, terminal };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => canvasContext());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Ghostty right-click arbitration", () => {
  it("sends right-click to the terminal and suppresses the platform menu when mouse reporting captures it", () => {
    const { canvas, core, encodeMouse, onInput, terminal } = createTerminal(true);

    const down = new MouseEvent("mousedown", { button: 2, clientX: 24, clientY: 20, cancelable: true });
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(onInput).toHaveBeenCalledWith("right-press");
    expect(core.cancelSelection).toHaveBeenCalledOnce();
    expect(core.selectWordAt).not.toHaveBeenCalled();

    const contextMenu = new MouseEvent("contextmenu", {
      button: 2,
      clientX: 24,
      clientY: 20,
      cancelable: true,
    });
    canvas.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);

    window.dispatchEvent(new MouseEvent("mouseup", { button: 2, clientX: 24, clientY: 20, cancelable: true }));
    expect(encodeMouse).toHaveBeenLastCalledWith(expect.objectContaining({ action: MouseAction.Release }));
    expect(onInput).toHaveBeenLastCalledWith("right-release");
    terminal.dispose();
  });

  it("uses Ghostty word selection and leaves the platform menu untouched when mouse reporting declines it", () => {
    const { canvas, core, onInput, terminal } = createTerminal(false);

    const down = new MouseEvent("mousedown", { button: 2, clientX: 30, clientY: 20, cancelable: true });
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    expect(core.selectWordAt).toHaveBeenCalledOnce();
    expect(core.cancelSelection).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();

    const contextMenu = new MouseEvent("contextmenu", {
      button: 2,
      clientX: 30,
      clientY: 20,
      cancelable: true,
    });
    canvas.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    terminal.dispose();
  });
});
