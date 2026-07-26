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

let measuredWidth = 8;
let measuredAscent = 11;
let measuredDescent = 3;
let contexts: CanvasRenderingContext2D[] = [];

function canvasContext(): CanvasRenderingContext2D {
  const context = {
    measureText: () =>
      ({
        width: measuredWidth,
        actualBoundingBoxAscent: measuredAscent,
        actualBoundingBoxDescent: measuredDescent,
      }) as TextMetrics,
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  contexts.push(context);
  return context;
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
    selectRange: vi.fn(() => true),
    selectAll: vi.fn(() => true),
    clearSelection: vi.fn(),
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
  measuredWidth = 8;
  measuredAscent = 11;
  measuredDescent = 3;
  contexts = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => canvasContext());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Ghostty canvas font metrics", () => {
  it("keeps fractional mono advances and vertically centers text from measured ascent/descent", () => {
    measuredWidth = 7.8125;
    const { core, terminal } = createTerminal(false);

    expect(core.resize).toHaveBeenCalledWith(80, 23, 7.8125, 16);
    const terminalContext = contexts[0];
    const frame: GhosttyFrame = {
      cols: 1,
      rows: 1,
      cells: [
        [
          {
            text: "A",
            width: 1,
            selected: false,
            bold: false,
            italic: false,
            faint: false,
            blink: false,
            inverse: false,
            invisible: false,
            strikethrough: false,
            overline: false,
            underline: false,
          },
        ],
      ],
      foreground: "#fff",
      background: "#000",
      cursor: { x: 0, y: 0, visible: false, blinking: false, style: "block", color: "#fff" },
    };
    (
      terminal as unknown as {
        draw(frame: GhosttyFrame): void;
      }
    ).draw(frame);

    // Canvas padding is 6px; centered baseline is 12px inside the 16px cell (not the old hard-coded 13px).
    expect(terminalContext.fillText).toHaveBeenCalledWith("A", 6, 18);
    terminal.dispose();
  });

  it("places selection boundaries on the exact padded fractional cell grid", () => {
    measuredWidth = 7.8125;
    const { core, terminal } = createTerminal(false);
    vi.mocked(core.viewportSnapshot).mockReturnValue({
      total: 26,
      offset: 2,
      length: 24,
      active: true,
      screen: "normal",
    });

    expect(terminal.selectionBoundaryAt({ col: 2, row: 3 }, "start")).toEqual({
      x: 21.625,
      y: 22,
    });
    expect(terminal.selectionBoundaryAt({ col: 3, row: 3 }, "end")).toEqual({
      x: 29.4375,
      y: 38,
    });
    expect(terminal.selectionBoundaryAt({ col: 0, row: 4 }, "end")).toEqual({
      x: 631,
      y: 38,
    });
    expect(terminal.selectionBoundaryAt({ col: 2, row: 1 }, "start")).toBeUndefined();
    terminal.dispose();
  });
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
  it("repaints every programmatic selection change immediately", () => {
    const { core, terminal } = createTerminal(false);
    const requestFrame = vi.mocked(requestAnimationFrame);
    requestFrame.mockClear();

    const releasePendingFrame = () => {
      (terminal as unknown as { frameRequest: number }).frameRequest = 0;
    };
    releasePendingFrame();
    terminal.select(2, 0, 4);
    expect(core.selectRange).toHaveBeenCalledWith({ col: 2, row: 0 }, { col: 5, row: 0 });
    expect(requestFrame).toHaveBeenCalledOnce();

    requestFrame.mockClear();
    releasePendingFrame();
    terminal.selectAll();
    expect(core.selectAll).toHaveBeenCalledOnce();
    expect(requestFrame).toHaveBeenCalledOnce();

    requestFrame.mockClear();
    releasePendingFrame();
    terminal.clearSelection();
    expect(core.clearSelection).toHaveBeenCalledOnce();
    expect(requestFrame).toHaveBeenCalledOnce();
    terminal.dispose();
  });

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
