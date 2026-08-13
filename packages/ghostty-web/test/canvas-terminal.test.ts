// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCROLLBACK_BYTES,
  GhosttyCanvasTerminal,
  GhosttyKey,
  Mods,
  MouseAction,
  MouseButton,
} from "../src/index";
import type { GhosttyRuntime, GhosttyTerminalCore } from "../src/runtime";
import type { GhosttyFrame, GhosttyKeyInput, GhosttyMouseInput, GhosttyViewportSnapshot } from "../src/types";

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

function createTerminal(
  mouseCaptured: boolean,
  capturedButton: MouseButton = MouseButton.Right,
  terminalOptions: {
    nativeScroll?: boolean;
    focusOnPointer?: boolean | ((event: MouseEvent) => boolean);
    viewport?: GhosttyViewportSnapshot;
    onCopy?: (text: string) => void;
    onClipboardWrite?: (text: string) => void;
    scrollbackBytes?: number;
    secondaryClickSelectsWord?: boolean | ((event: MouseEvent) => boolean);
  } = {},
) {
  const viewport =
    terminalOptions.viewport ??
    ({ total: 24, offset: 0, length: 24, active: true, screen: "normal" } satisfies GhosttyViewportSnapshot);
  const encodeMouse = vi.fn((input: GhosttyMouseInput) => {
    if (!mouseCaptured || input.button !== capturedButton) return new Uint8Array();
    return new TextEncoder().encode(input.action === MouseAction.Press ? "mouse-press" : "mouse-release");
  });
  const encodeKey = vi.fn((input: GhosttyKeyInput) =>
    new TextEncoder().encode(input.key === GhosttyKey.Backspace ? "\x7f" : (input.utf8 ?? "")),
  );
  const core = {
    cols: 80,
    rows: 24,
    resize: vi.fn(),
    setDefaultCursorBlink: vi.fn(),
    snapshot: vi.fn(() => EMPTY_FRAME),
    viewportSnapshot: vi.fn(() => viewport),
    bufferSnapshot: vi.fn(() => ({
      cols: 80,
      rows: 24,
      viewport,
      lines: Array.from({ length: 24 }, () => ({
        isWrapped: false,
        text: "",
        cells: Array.from({ length: 80 }, () => ({ text: " ", width: 1 })),
      })),
    })),
    selectionSnapshot: vi.fn(() => undefined),
    selectionText: vi.fn(() => ""),
    mode: vi.fn(() => false),
    mouseTracking: vi.fn(() => mouseCaptured),
    encodeKey,
    encodeMouse,
    cancelSelection: vi.fn(),
    beginSelection: vi.fn(() => true),
    updateSelection: vi.fn(() => true),
    endSelection: vi.fn(),
    selectWordAt: vi.fn(() => true),
    selectRange: vi.fn(() => true),
    selectAll: vi.fn(() => true),
    clearSelection: vi.fn(),
    scrollViewport: vi.fn(),
    scrollToRow: vi.fn((row: number) => {
      viewport.offset = row;
    }),
    scrollToTop: vi.fn(),
    scrollToBottom: vi.fn(),
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
    onCopy: terminalOptions.onCopy,
    onClipboardWrite: terminalOptions.onClipboardWrite,
    ...(terminalOptions.scrollbackBytes !== undefined ? { scrollbackBytes: terminalOptions.scrollbackBytes } : {}),
    ...(terminalOptions.nativeScroll ? { nativeScroll: true } : {}),
    ...(terminalOptions.focusOnPointer !== undefined ? { focusOnPointer: terminalOptions.focusOnPointer } : {}),
    ...(terminalOptions.secondaryClickSelectsWord !== undefined
      ? { secondaryClickSelectsWord: terminalOptions.secondaryClickSelectsWord }
      : {}),
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
  return { canvas, core, encodeKey, encodeMouse, host, onInput, runtime, terminal };
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

it("uses Ghostty's native 50 MB scrollback default and accepts an explicit byte limit", () => {
  const first = createTerminal(false);
  expect(first.runtime.createTerminal).toHaveBeenCalledWith(
    expect.any(Number),
    expect.any(Number),
    DEFAULT_SCROLLBACK_BYTES,
    {
      onClipboardWrite: undefined,
    },
  );
  first.terminal.dispose();

  const second = createTerminal(false, MouseButton.Right, { scrollbackBytes: 2_000_000 });
  expect(second.runtime.createTerminal).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 2_000_000, {
    onClipboardWrite: undefined,
  });
  second.terminal.dispose();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Ghostty native clipboard", () => {
  it("connects application-originated clipboard writes to the canvas callback", () => {
    const onClipboardWrite = vi.fn();
    const { runtime, terminal } = createTerminal(false, MouseButton.Right, { onClipboardWrite });
    const coreOptions = vi.mocked(runtime.createTerminal).mock.calls[0]?.[3] as
      { onClipboardWrite?: (text: string) => void } | undefined;

    coreOptions?.onClipboardWrite?.("application-selected text");

    expect(onClipboardWrite).toHaveBeenCalledWith("application-selected text");
    terminal.dispose();
  });

  it("writes the current selection into the browser copy event before reporting success", () => {
    const onCopy = vi.fn();
    const { core, host, terminal } = createTerminal(false, MouseButton.Right, { onCopy });
    vi.mocked(core.selectionText).mockReturnValue("selected terminal text");
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });

    host.querySelector<HTMLTextAreaElement>(".rc-ghostty-input")!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "selected terminal text");
    expect(onCopy).toHaveBeenCalledWith("selected terminal text");
    terminal.dispose();
  });

  it("does not claim success when a copy event has no writable clipboard payload", () => {
    const onCopy = vi.fn();
    const { core, host, terminal } = createTerminal(false, MouseButton.Right, { onCopy });
    vi.mocked(core.selectionText).mockReturnValue("selected terminal text");
    const event = new Event("copy", { bubbles: true, cancelable: true });

    host.querySelector<HTMLTextAreaElement>(".rc-ghostty-input")!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onCopy).not.toHaveBeenCalled();
    terminal.dispose();
  });

  it("does not claim success when the browser rejects a clipboard payload write", () => {
    const onCopy = vi.fn();
    const { core, host, terminal } = createTerminal(false, MouseButton.Right, { onCopy });
    vi.mocked(core.selectionText).mockReturnValue("selected terminal text");
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        setData: () => {
          throw new DOMException("denied", "NotAllowedError");
        },
      },
    });

    host.querySelector<HTMLTextAreaElement>(".rc-ghostty-input")!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onCopy).not.toHaveBeenCalled();
    terminal.dispose();
  });
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

describe("Ghostty mobile IME composition", () => {
  it("streams each candidate update before commit and reconciles an autocorrected suffix", () => {
    const { encodeKey, host, onInput, terminal } = createTerminal(false);
    const input = host.querySelector<HTMLTextAreaElement>(".rc-ghostty-input")!;
    const composition = (type: "compositionstart" | "compositionupdate" | "compositionend", data: string) =>
      input.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));

    composition("compositionstart", "");
    composition("compositionupdate", "mer");
    expect(onInput.mock.calls.flat()).toEqual(["mer"]); // visible in the PTY before Space commits the word
    composition("compositionupdate", "mera");
    composition("compositionupdate", "merhaba");
    composition("compositionend", "merhaba");
    input.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: " " }),
    );

    expect(onInput.mock.calls.flat()).toEqual(["mer", "a", "\x7f", "haba", " "]);
    expect(encodeKey.mock.calls.every(([key]) => key.mods === 0)).toBe(true);
    expect(input.value).toBe("");
    terminal.dispose();
  });

  it("erases a canceled composition by grapheme instead of leaving provisional text in the terminal", () => {
    const { host, onInput, terminal } = createTerminal(false);
    const input = host.querySelector<HTMLTextAreaElement>(".rc-ghostty-input")!;

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "👍🏽" }));
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "" }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));

    expect(onInput.mock.calls.flat()).toEqual(["👍🏽", "\x7f"]);
    terminal.dispose();
  });

  it("keeps sticky modifiers on the commit-time path for single-key terminal shortcuts", () => {
    const { encodeKey, host, onInput, terminal } = createTerminal(false);
    const input = host.querySelector<HTMLTextAreaElement>(".rc-ghostty-input")!;
    terminal.setModifierLocks({ ctrl: true });

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "c" }));
    expect(onInput).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "c" }));

    expect(onInput.mock.calls.flat()).toEqual(["c"]);
    expect(encodeKey).toHaveBeenLastCalledWith(expect.objectContaining({ utf8: "c", mods: Mods.Control }));
    terminal.dispose();
  });

  it("does not emit a beforeinput event already owned by a capturing mobile wrapper", () => {
    const { host, onInput, terminal } = createTerminal(false);
    const input = host.querySelector<HTMLTextAreaElement>(".rc-ghostty-input")!;
    input.addEventListener("beforeinput", (event) => event.preventDefault(), true);

    input.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" }),
    );

    expect(onInput).not.toHaveBeenCalled();
    terminal.dispose();
  });
});

describe("Ghostty native scroll surface", () => {
  it("maps browser overflow rows into the normal Ghostty viewport and leaves wheel momentum native", () => {
    const viewport: GhosttyViewportSnapshot = {
      total: 84,
      offset: 60,
      length: 24,
      active: true,
      screen: "normal",
    };
    const { canvas, core, encodeMouse, host, terminal } = createTerminal(false, MouseButton.Right, {
      nativeScroll: true,
      viewport,
    });

    expect(host.classList.contains("rc-ghostty-native-scroll")).toBe(true);
    expect(host.querySelector<HTMLElement>(".rc-ghostty-scroll-spacer")?.style.height).toBe("1344px");
    expect(host.scrollTop).toBe(960);
    expect(canvas.style.top).toBe("960px");

    host.scrollTop = 800;
    host.dispatchEvent(new Event("scroll"));
    expect(core.scrollToRow).toHaveBeenCalledWith(50);
    expect(canvas.style.top).toBe("800px");

    terminal.scrollByPixels(-45);
    expect(host.scrollTop).toBe(755);
    expect(core.scrollViewport).not.toHaveBeenCalled();

    const wheel = new WheelEvent("wheel", { deltaY: -72, cancelable: true });
    canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(encodeMouse).not.toHaveBeenCalled();
    expect(core.scrollViewport).not.toHaveBeenCalled();

    terminal.dispose();
    expect(host.classList.contains("rc-ghostty-native-scroll")).toBe(false);
    expect(host.querySelector(".rc-ghostty-scroll-spacer")).toBeNull();
  });

  it("encodes alternate-screen wheel input at the real pointer cell instead of the top-left sidebar", () => {
    const viewport: GhosttyViewportSnapshot = {
      total: 24,
      offset: 0,
      length: 24,
      active: true,
      screen: "alternate",
    };
    const { encodeMouse, host, onInput, terminal } = createTerminal(true, MouseButton.WheelUp, {
      nativeScroll: true,
      viewport,
    });

    // Browser focus/pan may create a phantom overflow offset before Ghostty renders again. The scroll event
    // itself must snap an app-owned alternate screen back to the origin.
    host.scrollTop = 15;
    host.scrollLeft = 3;
    host.dispatchEvent(new Event("scroll"));
    expect(host.scrollTop).toBe(0);
    expect(host.scrollLeft).toBe(0);

    terminal.sendMouseWheel(true, 1, 130, 90);

    expect(host.classList.contains("rc-ghostty-alt-screen")).toBe(true);
    expect(host.querySelector<HTMLElement>(".rc-ghostty-scroll-spacer")?.style.height).toBe("0px");
    expect(encodeMouse).toHaveBeenCalledWith(expect.objectContaining({ x: 124, y: 84 }));
    expect(onInput).toHaveBeenCalledWith("mouse-press");
    terminal.dispose();
  });

  it("accumulates mobile touchpad pixels into terminal rows for a mouse-aware alternate screen", () => {
    const viewport: GhosttyViewportSnapshot = {
      total: 24,
      offset: 0,
      length: 24,
      active: true,
      screen: "alternate",
    };
    const { encodeMouse, onInput, terminal } = createTerminal(true, MouseButton.WheelUp, {
      nativeScroll: true,
      viewport,
    });

    terminal.scrollByPixels(-15, 130, 90);
    expect(onInput).not.toHaveBeenCalled();
    terminal.scrollByPixels(-30, 130, 90);

    expect(encodeMouse).toHaveBeenCalledTimes(2);
    expect(encodeMouse).toHaveBeenLastCalledWith(expect.objectContaining({ x: 124, y: 84 }));
    expect(onInput.mock.calls.flat()).toEqual(["mouse-press", "mouse-press"]);
    terminal.dispose();
  });

  it("turns high-resolution Mac trackpad deltas into rows instead of one wheel report per browser event", () => {
    const viewport: GhosttyViewportSnapshot = {
      total: 24,
      offset: 0,
      length: 24,
      active: true,
      screen: "alternate",
    };
    const { canvas, encodeMouse, onInput, terminal } = createTerminal(true, MouseButton.WheelUp, {
      nativeScroll: true,
      viewport,
    });

    for (const deltaY of [-5, -5]) {
      const wheel = new WheelEvent("wheel", { deltaY, cancelable: true });
      canvas.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
    }
    expect(encodeMouse).not.toHaveBeenCalled();

    const completingWheel = new WheelEvent("wheel", { deltaY: -6, cancelable: true, clientX: 130, clientY: 90 });
    canvas.dispatchEvent(completingWheel);
    expect(completingWheel.defaultPrevented).toBe(true);
    expect(encodeMouse).toHaveBeenCalledOnce();
    expect(encodeMouse).toHaveBeenCalledWith(expect.objectContaining({ x: 124, y: 84 }));
    expect(onInput).toHaveBeenCalledOnce();

    const lineWheel = new WheelEvent("wheel", {
      deltaY: -1,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      cancelable: true,
    });
    canvas.dispatchEvent(lineWheel);
    expect(encodeMouse).toHaveBeenCalledTimes(2);
    terminal.dispose();
  });

  it("accumulates pixel wheel input into exact viewport rows when an alternate screen does not capture the mouse", () => {
    const viewport: GhosttyViewportSnapshot = {
      total: 24,
      offset: 0,
      length: 24,
      active: true,
      screen: "alternate",
    };
    const { canvas, core, terminal } = createTerminal(false, MouseButton.WheelUp, {
      nativeScroll: true,
      viewport,
    });

    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 7, cancelable: true }));
    expect(core.scrollViewport).not.toHaveBeenCalled();
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 9, cancelable: true }));
    expect(core.scrollViewport).toHaveBeenCalledWith(1);
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

  it("keeps a virtual-touchpad secondary click native without selecting a word when the app declines it", () => {
    const shouldSelect = vi.fn(() => false);
    const { canvas, core, onInput, terminal } = createTerminal(false, MouseButton.Right, {
      secondaryClickSelectsWord: shouldSelect,
    });

    const down = new MouseEvent("mousedown", { button: 2, clientX: 30, clientY: 20, cancelable: true });
    canvas.dispatchEvent(down);

    expect(shouldSelect).toHaveBeenCalledWith(down);
    expect(down.defaultPrevented).toBe(true);
    expect(core.selectWordAt).not.toHaveBeenCalled();
    expect(core.cancelSelection).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
    terminal.dispose();
  });
});

describe("Ghostty primary-button arbitration", () => {
  it("can keep terminal pointer gestures from focusing the hidden input", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const { canvas, core, host, terminal } = createTerminal(false, MouseButton.Left, { focusOnPointer: false });

    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 24, clientY: 20, cancelable: true }));

    expect(document.activeElement).toBe(outside);
    expect(host.querySelector(".rc-ghostty-input")).not.toBe(document.activeElement);
    expect(core.beginSelection).toHaveBeenCalledOnce();
    terminal.dispose();
  });

  it("can decide focus from the originating mouse event", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const focusOnPointer = vi.fn((event: MouseEvent) => event.detail === 2);
    const { canvas, host, terminal } = createTerminal(false, MouseButton.Left, { focusOnPointer });

    canvas.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, clientX: 24, clientY: 20, detail: 1, cancelable: true }),
    );
    expect(document.activeElement).toBe(outside);

    canvas.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, clientX: 24, clientY: 20, detail: 2, cancelable: true }),
    );
    expect(host.querySelector(".rc-ghostty-input")).toBe(document.activeElement);
    expect(focusOnPointer).toHaveBeenCalledTimes(2);
    terminal.dispose();
  });

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
