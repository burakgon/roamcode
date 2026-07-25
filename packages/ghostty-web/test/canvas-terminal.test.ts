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
  cursor: { x: 0, y: 0, visible: false, blinking: false, style: "block", color: "#fff" },
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

function createTerminal(mouseCaptured: boolean, capturedButton: MouseButton = MouseButton.Right) {
  const encodeMouse = vi.fn((input: GhosttyMouseInput) => {
    if (!mouseCaptured || input.button !== capturedButton) return new Uint8Array();
    return new TextEncoder().encode(input.action === MouseAction.Press ? "mouse-press" : "mouse-release");
  });
  const core = {
    cols: 80,
    rows: 24,
    resize: vi.fn(),
    setDefaultCursorBlink: vi.fn(),
    snapshot: vi.fn(() => EMPTY_FRAME),
    viewportSnapshot: vi.fn(() => ({
      total: 24,
      offset: 0,
      length: 24,
      active: true,
      screen: "normal",
    })),
    bufferSnapshot: vi.fn(() => ({
      cols: 80,
      rows: 24,
      viewport: {
        total: 24,
        offset: 0,
        length: 24,
        active: true,
        screen: "normal",
      },
      lines: Array.from({ length: 24 }, () => ({
        isWrapped: false,
        text: "",
        cells: Array.from({ length: 80 }, () => ({ text: " ", width: 1 })),
      })),
    })),
    selectionSnapshot: vi.fn(() => undefined),
    selectionText: vi.fn(() => ""),
    encodeMouse,
    cancelSelection: vi.fn(),
    beginSelection: vi.fn(() => true),
    updateSelection: vi.fn(() => true),
    endSelection: vi.fn(),
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
    expect(onInput).toHaveBeenCalledWith("mouse-press");
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
    expect(onInput).toHaveBeenLastCalledWith("mouse-release");
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

describe("Ghostty primary-button arbitration", () => {
  it("gives an unmodified click to application mouse reporting immediately", () => {
    const { canvas, core, onInput, terminal } = createTerminal(true, MouseButton.Left);
    const down = new MouseEvent("mousedown", { button: 0, clientX: 24, clientY: 20, cancelable: true });
    canvas.dispatchEvent(down);

    expect(down.defaultPrevented).toBe(true);
    expect(onInput).toHaveBeenCalledWith("mouse-press");
    expect(core.cancelSelection).toHaveBeenCalledOnce();
    expect(core.beginSelection).not.toHaveBeenCalled();

    window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 24, clientY: 20, cancelable: true }));
    expect(onInput).toHaveBeenLastCalledWith("mouse-release");
    terminal.dispose();
  });

  it("uses Shift as Ghostty's mouse-reporting override and keeps drag selection in the core", () => {
    const { canvas, core, encodeMouse, terminal } = createTerminal(true, MouseButton.Left);
    canvas.dispatchEvent(
      new MouseEvent("mousedown", {
        button: 0,
        clientX: 24,
        clientY: 20,
        shiftKey: true,
        cancelable: true,
      }),
    );
    expect(encodeMouse).not.toHaveBeenCalled();
    expect(core.beginSelection).toHaveBeenCalledOnce();

    window.dispatchEvent(new MouseEvent("mousemove", { buttons: 1, clientX: 40, clientY: 20, cancelable: true }));
    expect(core.updateSelection).toHaveBeenCalledOnce();
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 40, clientY: 20, cancelable: true }));
    expect(core.endSelection).toHaveBeenCalledOnce();
    terminal.dispose();
  });
});

describe("Ghostty selection compatibility view", () => {
  it("normalizes reverse Ghostty endpoints into xterm-compatible ordered boundaries", () => {
    const { core, terminal } = createTerminal(false);
    vi.mocked(core.selectionSnapshot).mockReturnValue({
      start: { col: 5, row: 0 },
      end: { col: 2, row: 0 },
      rectangle: false,
      text: "text",
    });

    expect(terminal.getSelectionPosition()).toEqual({
      start: { x: 2, y: 0 },
      end: { x: 6, y: 0 },
    });
    terminal.dispose();
  });
});
