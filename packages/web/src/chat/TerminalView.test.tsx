import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

// Mock the Ghostty canvas surface so jsdom doesn't need WebAssembly or a real canvas; assert we wire
// onData→socket and socket→term.write.
// `mockLines` feeds buffer.active (the find bar's corpus); `selects`/`scrolledTo` record the find bar's
// select/scroll navigation so tests can assert match positions without a real grid.
const writes: string[] = [];
const dataCbs: ((d: string) => void)[] = [];
let mockLines: string[] = [];
const mockWrappedRows = new Set<number>();
let mockSelection = "";
let mockSelectionRange: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
let mockMouseTrackingMode: "none" | "drag" | "any" = "none";
let mockBufferType: "normal" | "alternate" = "normal";
let lastTerminalOptions: Record<string, unknown> = {};
let customKeyHandler: ((event: KeyboardEvent) => boolean) | undefined;
const selects: { col: number; row: number; length: number }[] = [];
const scrolledTo: number[] = [];
const scrolledLines: number[] = [];
const terminalWheelCalls: { up: boolean; count: number; clientX?: number; clientY?: number }[] = [];
const terminalMouseEvents: { type: string; altKey: boolean; shiftKey: boolean; detail: number }[] = [];
const selectionCbs: (() => void)[] = [];
type MockLink = { uri: string; start: { col: number; row: number }; end: { col: number; row: number } };
let mockLinks: MockLink[] = [];
let mockWebLinkHandler: ((event: MouseEvent, uri: string) => void) | undefined;

function mockKeySequence(
  label: string,
  modifiers: { ctrl?: boolean; alt?: boolean } = {},
  applicationCursorMode = false,
): string {
  const cursor: Record<string, string> = {
    ArrowUp: applicationCursorMode ? "\x1bOA" : "\x1b[A",
    ArrowDown: applicationCursorMode ? "\x1bOB" : "\x1b[B",
    ArrowRight: applicationCursorMode ? "\x1bOC" : "\x1b[C",
    ArrowLeft: applicationCursorMode ? "\x1bOD" : "\x1b[D",
    Home: applicationCursorMode ? "\x1bOH" : "\x1b[H",
    End: applicationCursorMode ? "\x1bOF" : "\x1b[F",
  };
  const fixed: Record<string, string> = {
    Esc: "\x1b",
    Tab: "\t",
    Enter: "\r",
    Backspace: modifiers.ctrl ? "\x08" : "\x7f",
    Delete: "\x1b[3~",
    PageUp: "\x1b[5~",
    PageDown: "\x1b[6~",
  };
  let sequence = cursor[label] ?? fixed[label] ?? label;
  if (label.length === 1 && modifiers.ctrl) {
    const code = label.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) sequence = String.fromCharCode(code - 96);
  }
  return modifiers.alt ? `\x1b${sequence}` : sequence;
}

function mockLinkAt(clientX: number, clientY: number): MockLink | undefined {
  const col = Math.min(79, Math.max(0, Math.floor(clientX / 10)));
  const row = Math.min(23, Math.max(0, Math.floor(clientY / 20)));
  const index = row * 80 + col;
  return mockLinks.find((link) => {
    const start = link.start.row * 80 + link.start.col;
    const end = link.end.row * 80 + link.end.col;
    return index >= start && index < end;
  });
}
vi.mock("@roamcode.ai/ghostty-web", () => ({
  loadGhosttyRuntime: async () => ({}),
  GhosttyCanvasTerminal: class {
    cols = 80;
    rows = 24;
    modes = {
      applicationCursorKeysMode: false,
      get mouseTrackingMode() {
        return mockMouseTrackingMode;
      },
    };
    options: Record<string, unknown>;
    private host?: HTMLElement;
    private textarea?: HTMLTextAreaElement;
    private dataListener?: (data: string) => void;
    private locks = { ctrl: false, alt: false };
    private focusOnPointer = true;
    private primary?: { down: MouseEvent; moved: boolean };
    private hoveredLink?: MockLink;
    private mouseDownLink?: MockLink;
    private updateLink = (event: MouseEvent) => {
      this.hoveredLink = mockLinkAt(event.clientX, event.clientY);
      if (this.primary && event.buttons === 1) {
        if (Math.hypot(event.clientX - this.primary.down.clientX, event.clientY - this.primary.down.clientY) >= 4) {
          this.primary.moved = true;
        }
        return;
      }
      if (event.buttons === 0 && mockMouseTrackingMode === "any" && !mockSelection) {
        terminalMouseEvents.push({
          type: event.type,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          detail: event.detail,
        });
      }
    };
    private linkMouseDown = (event: MouseEvent) => {
      if (this.focusOnPointer) this.focus();
      this.updateLink(event);
      if (event.button === 2) {
        this.selectWordAtPoint(event.clientX, event.clientY);
        return;
      }
      if (event.button !== 0) return;
      this.mouseDownLink = this.hoveredLink;
      this.primary = { down: event, moved: event.detail > 1 };
      if (event.detail > 1) this.selectWordAtPoint(event.clientX, event.clientY);
    };
    private linkMouseUp = (event: MouseEvent) => {
      const link = this.hoveredLink ?? mockLinkAt(event.clientX, event.clientY);
      const primary = this.primary;
      if (primary && !primary.moved && link && this.mouseDownLink === link) {
        mockWebLinkHandler?.(event, link.uri);
      } else if (primary && !primary.moved && mockMouseTrackingMode !== "none") {
        terminalMouseEvents.push(
          { type: "mousedown", altKey: false, shiftKey: false, detail: primary.down.detail },
          { type: "mouseup", altKey: false, shiftKey: false, detail: event.detail },
        );
      }
      this.primary = undefined;
      this.mouseDownLink = undefined;
    };
    constructor(
      _runtime: unknown,
      host: HTMLElement,
      options: Record<string, unknown> & { onLink?: (uri: string, event: MouseEvent) => void } = {},
    ) {
      this.options = { fontSize: 13, ...options };
      this.focusOnPointer = options.focusOnPointer !== false;
      lastTerminalOptions = this.options;
      mockWebLinkHandler = (event, uri) => options.onLink?.(uri, event);
      this.open(host);
    }
    buffer = {
      active: {
        get type() {
          return mockBufferType;
        },
        viewportY: 0,
        baseY: 0,
        get length() {
          return mockLines.length;
        },
        getLine: (i: number) => ({
          isWrapped: mockWrappedRows.has(i),
          length: 80,
          translateToString: () => mockLines[i] ?? "",
          getCell: (col: number) => ({
            getWidth: () => 1,
            getChars: () => mockLines[i]?.[col] ?? " ",
          }),
        }),
      },
      onBufferChange: () => ({ dispose() {} }),
    };
    loadAddon() {}
    open(host: HTMLElement) {
      const screen = document.createElement("div");
      screen.className = "rc-ghostty-canvas";
      const textarea = document.createElement("textarea");
      textarea.className = "rc-ghostty-input";
      screen.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 800, bottom: 480, width: 800, height: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
      host.appendChild(screen);
      host.appendChild(textarea);
      this.host = host;
      this.textarea = textarea;
      screen.addEventListener("mousemove", this.updateLink);
      screen.addEventListener("mousedown", this.linkMouseDown);
      screen.addEventListener("mouseup", this.linkMouseUp);
    }
    write(d: string) {
      writes.push(typeof d === "string" ? d : new TextDecoder().decode(d));
    }
    onData(cb: (d: string) => void) {
      this.dataListener = cb;
      dataCbs.push((data) => {
        if (data.length !== 1) return cb(data);
        if (data === "\x7f" || data === "\x08") return cb(mockKeySequence("Backspace", this.locks));
        if (data === "\r") return cb(mockKeySequence("Enter", this.locks));
        if (data === "\x1b") return cb(mockKeySequence("Esc", this.locks));
        return cb(mockKeySequence(data, this.locks));
      });
      return { dispose() {} };
    }
    onResize() {}
    onScroll() {
      return { dispose() {} };
    }
    scrollLines(amount: number) {
      scrolledLines.push(amount);
      this.buffer.active.viewportY = Math.max(0, this.buffer.active.viewportY + amount);
    }
    scrollToBottom() {}
    scrollToLine(row: number) {
      scrolledTo.push(row);
    }
    select(col: number, row: number, length: number) {
      selects.push({ col, row, length });
      const chars: string[] = [];
      for (let offset = 0; offset < length; offset++) {
        const linear = col + offset;
        const targetRow = row + Math.floor(linear / this.cols);
        const targetCol = linear % this.cols;
        chars.push(mockLines[targetRow]?.[targetCol] ?? " ");
      }
      mockSelection = chars.join("");
      const end = col + length;
      mockSelectionRange = {
        start: { x: col, y: row },
        end: { x: end % this.cols, y: row + Math.floor(end / this.cols) },
      };
      selectionCbs.forEach((cb) => cb());
    }
    selectAll() {
      this.select(0, 0, Math.max(1, mockLines.length * this.cols));
    }
    clearSelection() {
      mockSelection = "";
      mockSelectionRange = undefined;
      selectionCbs.forEach((cb) => cb());
    }
    hasSelection() {
      return mockSelection.length > 0;
    }
    getSelection() {
      return mockSelection;
    }
    getSelectionPosition() {
      return mockSelectionRange;
    }
    onSelectionChange(cb: () => void) {
      selectionCbs.push(cb);
      return { dispose() {} };
    }
    reset() {}
    fit() {}
    setModifierLocks(locks: { ctrl?: boolean; alt?: boolean }) {
      this.locks = { ctrl: !!locks.ctrl, alt: !!locks.alt };
    }
    keySequence(label: string, locks: { ctrl?: boolean; alt?: boolean } = {}) {
      return mockKeySequence(label, locks, this.modes.applicationCursorKeysMode);
    }
    sendKey(label: string, locks: { ctrl?: boolean; alt?: boolean } = {}) {
      this.dataListener?.(this.keySequence(label, locks));
    }
    sendMouseWheel(up: boolean, count = 1, clientX?: number, clientY?: number) {
      terminalWheelCalls.push({ up, count, clientX, clientY });
      this.dataListener?.((up ? "\x1b[<64;1;1M" : "\x1b[<65;1;1M").repeat(count));
    }
    paste(text: string) {
      this.dataListener?.(`\x1b[200~${text}\x1b[201~`);
    }
    screenRect() {
      return this.host!.querySelector<HTMLElement>(".rc-ghostty-canvas")!.getBoundingClientRect();
    }
    selectionBoundaryAt(point: { col: number; row: number }, edge: "start" | "end") {
      let col = point.col;
      let row = point.row;
      if (edge === "end" && col === 0 && row > 0) {
        col = this.cols;
        row--;
      }
      const viewportRow = row - this.buffer.active.viewportY;
      if (viewportRow < 0 || viewportRow >= this.rows) return undefined;
      return {
        x: col * 10,
        y: (viewportRow + (edge === "end" ? 1 : 0)) * 20,
      };
    }
    cellAtPoint(clientX: number, clientY: number) {
      const rect = this.screenRect();
      if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom)
        return undefined;
      return {
        col: Math.min(79, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * 80))),
        row:
          this.buffer.active.viewportY +
          Math.min(23, Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * 24))),
      };
    }
    selectWordAtPoint(clientX: number, clientY: number) {
      const point = this.cellAtPoint(clientX, clientY);
      if (!point) return "";
      let firstRow = point.row;
      while (firstRow > 0 && mockWrappedRows.has(firstRow)) firstRow--;
      let lastRow = point.row;
      while (lastRow + 1 < mockLines.length && mockWrappedRows.has(lastRow + 1)) lastRow++;
      const firstIndex = (point.row - firstRow) * this.cols + point.col;
      const charAt = (index: number) => {
        if (index < 0) return " ";
        const row = firstRow + Math.floor(index / this.cols);
        if (row > lastRow) return " ";
        return mockLines[row]?.[index % this.cols] ?? " ";
      };
      const isWord = (index: number) => !/[\s()[\]{}'",`]/u.test(charAt(index));
      if (!isWord(firstIndex)) return "";
      let start = firstIndex;
      let end = firstIndex + 1;
      while (start > 0 && isWord(start - 1)) start--;
      while (isWord(end)) end++;
      this.select(start % this.cols, firstRow + Math.floor(start / this.cols), end - start);
      return this.getSelection();
    }
    activateLinkAtPoint(clientX: number, clientY: number, event?: MouseEvent) {
      const link = mockLinkAt(clientX, clientY);
      if (!link) return false;
      mockWebLinkHandler?.(event ?? new MouseEvent("click"), link.uri);
      return true;
    }
    blur() {
      this.textarea?.blur();
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      customKeyHandler = handler;
    }
    focus() {
      this.textarea?.focus();
    }
    dispose() {
      const screen = this.host?.querySelector<HTMLElement>(".rc-ghostty-canvas");
      screen?.removeEventListener("mousemove", this.updateLink);
      screen?.removeEventListener("mousedown", this.linkMouseDown);
      screen?.removeEventListener("mouseup", this.linkMouseUp);
      this.textarea?.remove();
    }
  },
}));

const sent: string[] = [];
vi.mock("../ws/terminal-socket", () => ({
  createTerminalSocket: (opts: { onData: (b: Uint8Array) => void }) => {
    setTimeout(() => opts.onData(new TextEncoder().encode("boot")), 0);
    return { sendInput: (d: string) => sent.push(d), sendResize: () => {}, reconnect: () => {}, close: () => {} };
  },
}));

import { canResumeConversation, GhosttyProductTerminalView } from "./TerminalView";
import type { ApiClientOptions } from "../api/client";
import type { TerminalViewProps } from "./terminal-view-types";
import type { createTerminalSocket, TerminalStatus } from "../ws/terminal-socket";

function TerminalView(props: TerminalViewProps) {
  return <GhosttyProductTerminalView {...props} runtime={{} as never} />;
}

// The view fits-then-connects on requestAnimationFrame and bails while the host has no height. jsdom reports
// clientHeight 0 and schedules rAF on a ~16ms timer, so make rAF synchronous and give the host a real height
// to drive the fit→connect path deterministically inside the effect.
let origRAF: typeof requestAnimationFrame;
beforeAll(() => {
  origRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as never;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
});
afterAll(() => {
  globalThis.requestAnimationFrame = origRAF;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});
beforeEach(() => {
  mockLines = [];
  mockWrappedRows.clear();
  mockSelection = "";
  mockSelectionRange = undefined;
  mockMouseTrackingMode = "none";
  mockBufferType = "normal";
  lastTerminalOptions = {};
  customKeyHandler = undefined;
  selects.length = 0;
  scrolledTo.length = 0;
  scrolledLines.length = 0;
  terminalWheelCalls.length = 0;
  terminalMouseEvents.length = 0;
  selectionCbs.length = 0;
  mockLinks = [];
  mockWebLinkHandler = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function coarsePointerMedia(query: string): MediaQueryList {
  return {
    matches: query.includes("pointer: coarse") && !query.includes("pointer: fine"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };
}

const SESSION = {
  id: "s1",
  cwd: "/work/proj",
  mode: "terminal" as const,
  status: "running" as const,
  createdAt: 0,
  lastActivityAt: 0,
  dangerouslySkip: false,
};

/** An injectable socket factory that records the URL each (re)connect evaluates and exposes the status
 *  callback, so tests can drive ended/open transitions and assert the respawn query. The URL thunk is
 *  ASYNC now (a single-use WS ticket is fetched per attempt), so the harness records the RESOLVED url —
 *  assertions await via waitFor. Fetch is stubbed to fail → the thunk falls back to the legacy ?token=
 *  URL, which still carries the respawn query under test. */
function socketHarness() {
  const urls: string[] = [];
  const statusCbs: ((s: TerminalStatus) => void)[] = [];
  const createSocket = ((opts: {
    url: string | (() => string | Promise<string>);
    onStatus?: (s: TerminalStatus) => void;
  }) => {
    const u = typeof opts.url === "function" ? opts.url() : opts.url;
    void Promise.resolve(u).then((s) => urls.push(s));
    if (opts.onStatus) statusCbs.push(opts.onStatus);
    return { sendInput: () => {}, sendResize: () => {}, reconnect: () => {}, close: () => {} };
  }) as unknown as typeof createTerminalSocket;
  return { urls, statusCbs, createSocket };
}

test("adapter resume capability follows the manifest contract instead of a built-in name", () => {
  expect(
    canResumeConversation({
      ...SESSION,
      provider: "review-agent",
      resumeIdentity: "required",
      identityState: "exact",
      providerSessionId: "review-42",
    }),
  ).toBe(true);
  expect(
    canResumeConversation({
      ...SESSION,
      provider: "review-agent",
      resumeIdentity: "required",
      identityState: "ambiguous",
    }),
  ).toBe(false);
  expect(canResumeConversation({ ...SESSION, provider: "batch-agent", resumeIdentity: "unsupported" })).toBe(false);
  expect(canResumeConversation({ ...SESSION, provider: "optional-agent", resumeIdentity: "optional" })).toBe(true);
});

test("pipes socket output into the terminal and input back to the socket", async () => {
  render(<TerminalView session={SESSION} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(writes.join("")).toContain("boot");
  dataCbs[0]!("k");
  expect(sent).toContain("k");
});

test("Ctrl stays locked across special keys until explicitly turned off", () => {
  const before = sent.length;
  render(<TerminalView session={SESSION} />);
  const ctrl = screen.getByRole("button", { name: "Control (sticky)" });

  fireEvent.pointerDown(ctrl, { pointerId: 31 });
  fireEvent.pointerUp(ctrl, { pointerId: 31 });
  expect(ctrl).toHaveAttribute("aria-pressed", "true");

  dataCbs.at(-1)!("\x7f");
  expect(sent.slice(before)).toEqual(["\x08"]); // Ctrl+Backspace
  expect(ctrl).toHaveAttribute("aria-pressed", "true");

  dataCbs.at(-1)!("b");
  expect(sent.slice(before)).toEqual(["\x08", "\x02"]);
  expect(ctrl).toHaveAttribute("aria-pressed", "true");

  fireEvent.pointerDown(ctrl, { pointerId: 33 });
  fireEvent.pointerUp(ctrl, { pointerId: 33 });
  expect(ctrl).toHaveAttribute("aria-pressed", "false");
  dataCbs.at(-1)!("\x7f");
  dataCbs.at(-1)!("multi-character paste");
  expect(sent.slice(before)).toEqual(["\x08", "\x02", "\x7f", "multi-character paste"]);
});

test("mobile concrete Backspace owns a deterministic hold repeat and stops on keyup", () => {
  vi.stubGlobal("matchMedia", vi.fn(coarsePointerMedia));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const before = sent.length;
    const { container } = render(<TerminalView session={SESSION} />);
    const helper = container.querySelector<HTMLTextAreaElement>("textarea.rc-ghostty-input")!;
    helper.focus();
    const down = new KeyboardEvent("keydown", { key: "Backspace", repeat: false, cancelable: true });
    expect(customKeyHandler?.(down)).toBe(false);
    expect(sent.slice(before)).toEqual(["\x7f"]);

    act(() => void vi.advanceTimersByTime(379));
    expect(sent.slice(before)).toEqual(["\x7f"]);
    act(() => void vi.advanceTimersByTime(71));
    expect(sent.slice(before)).toEqual(["\x7f", "\x7f"]);

    // Native repeated keydowns are swallowed; RoamCode's one timer remains authoritative.
    const nativeRepeat = new KeyboardEvent("keydown", { key: "Backspace", repeat: true, cancelable: true });
    expect(customKeyHandler?.(nativeRepeat)).toBe(false);
    expect(sent.slice(before)).toEqual(["\x7f", "\x7f"]);

    const up = new KeyboardEvent("keyup", { key: "Backspace", cancelable: true });
    expect(customKeyHandler?.(up)).toBe(false);
    act(() => void vi.advanceTimersByTime(500));
    expect(sent.slice(before)).toEqual(["\x7f", "\x7f"]);

    // If the browser loses the keyup while dismissing the soft keyboard, helper blur is a second hard stop.
    expect(customKeyHandler?.(down)).toBe(false);
    expect(sent.slice(before)).toEqual(["\x7f", "\x7f", "\x7f"]);
    helper.blur();
    act(() => void vi.advanceTimersByTime(500));
    expect(sent.slice(before)).toEqual(["\x7f", "\x7f", "\x7f"]);
  } finally {
    vi.useRealTimers();
  }
});

test("mobile Backspace switches to native beforeinput repeats without deleting twice", () => {
  vi.stubGlobal("matchMedia", vi.fn(coarsePointerMedia));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const before = sent.length;
    const { container } = render(<TerminalView session={SESSION} />);
    const helper = container.querySelector<HTMLTextAreaElement>("textarea.rc-ghostty-input")!;
    helper.focus();

    const down = new KeyboardEvent("keydown", { key: "Backspace", repeat: false, cancelable: true });
    expect(customKeyHandler?.(down)).toBe(false);
    expect(sent.slice(before)).toEqual(["\x7f"]);

    // Phone IMEs may synthesize keyup immediately even while the finger remains on the soft-keyboard key.
    const earlyUp = new KeyboardEvent("keyup", { key: "Backspace", cancelable: true });
    expect(customKeyHandler?.(earlyUp)).toBe(false);
    act(() => void vi.advanceTimersByTime(50));

    const firstNative = new InputEvent("beforeinput", {
      inputType: "deleteContentBackward",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(helper, firstNative);
    expect(firstNative.defaultPrevented).toBe(true);
    expect(helper.value).not.toBe("");
    expect(sent.slice(before)).toEqual(["\x7f"]); // keydown already owned the first physical delete

    // The native event cancels the synthetic hold timer, so a short tap can never run away.
    act(() => void vi.advanceTimersByTime(500));
    expect(sent.slice(before)).toEqual(["\x7f"]);

    // While the OS still sees the finger held, each repeated beforeinput owns exactly one delete.
    const heldNative = new InputEvent("beforeinput", {
      inputType: "deleteContentBackward",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(helper, heldNative);
    expect(heldNative.defaultPrevented).toBe(true);
    expect(sent.slice(before)).toEqual(["\x7f", "\x7f"]);

    act(() => void vi.advanceTimersByTime(701));
    expect(helper.value).toBe("");
    expect(sent.slice(before)).toEqual(["\x7f", "\x7f"]);
  } finally {
    vi.useRealTimers();
  }
});

test("mobile Backspace still owns repeat when an IME marks the key event as composing keyCode 229", () => {
  vi.stubGlobal("matchMedia", vi.fn(coarsePointerMedia));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const before = sent.length;
    render(<TerminalView session={SESSION} />);
    const down = new KeyboardEvent("keydown", {
      key: "Backspace",
      repeat: false,
      cancelable: true,
      isComposing: true,
    });
    Object.defineProperty(down, "keyCode", { value: 229 });

    expect(customKeyHandler?.(down)).toBe(false);
    expect(sent.slice(before)).toEqual(["\x7f"]);
    // Ghostty's streamed composition then mirrors the same deletion. The concrete key path already sent it.
    act(() => dataCbs.at(-1)!("\x7f"));
    expect(sent.slice(before)).toEqual(["\x7f"]);
    act(() => void vi.advanceTimersByTime(450));
    expect(sent.slice(before)).toEqual(["\x7f", "\x7f"]);

    const up = new KeyboardEvent("keyup", { key: "Backspace", cancelable: true, isComposing: true });
    Object.defineProperty(up, "keyCode", { value: 229 });
    expect(customKeyHandler?.(up)).toBe(false);
    act(() => void vi.advanceTimersByTime(500));
    expect(sent.slice(before)).toEqual(["\x7f", "\x7f"]);

    // Some IMEs hide the initial keydown and first expose Backspace as an already-repeating event.
    const lateRepeat = new KeyboardEvent("keydown", {
      key: "Backspace",
      repeat: true,
      cancelable: true,
      isComposing: true,
    });
    Object.defineProperty(lateRepeat, "keyCode", { value: 229 });
    expect(customKeyHandler?.(lateRepeat)).toBe(false);
    expect(sent.slice(before)).toEqual(["\x7f", "\x7f", "\x7f"]);
    expect(customKeyHandler?.(up)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("Gboard beforeinput repeats over an empty helper and dedupes Ghostty when composition text exists", () => {
  vi.stubGlobal("matchMedia", vi.fn(coarsePointerMedia));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const before = sent.length;
    const { container } = render(<TerminalView session={SESSION} />);
    const helper = container.querySelector<HTMLTextAreaElement>("textarea.rc-ghostty-input")!;
    const deleteEvent = () =>
      new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true });

    const first = deleteEvent();
    fireEvent(helper, first);
    expect(first.defaultPrevented).toBe(true);
    expect(sent.slice(before)).toEqual(["\x7f"]);

    const ctrl = screen.getByRole("button", { name: "Control (sticky)" });
    fireEvent.pointerDown(ctrl, { pointerId: 34 });
    fireEvent.pointerUp(ctrl, { pointerId: 34 });
    const repeated = deleteEvent();
    fireEvent(helper, repeated);
    expect(repeated.defaultPrevented).toBe(true);
    expect(sent.slice(before)).toEqual(["\x7f", "\x08"]);

    helper.value = "composition";
    fireEvent(helper, deleteEvent());
    // Ghostty emits DEL for this token before its fallback fires → exactly one modified delete.
    act(() => dataCbs.at(-1)!("\x7f"));
    act(() => void vi.advanceTimersByTime(0));
    expect(sent.slice(before)).toEqual(["\x7f", "\x08", "\x08"]);
    expect(ctrl).toHaveAttribute("aria-pressed", "true");
  } finally {
    vi.useRealTimers();
  }
});

test("terminal focus stays explicit while the real chat field accepts direct focus", () => {
  vi.stubGlobal("matchMedia", vi.fn(coarsePointerMedia));
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const helper = container.querySelector<HTMLTextAreaElement>("textarea.rc-ghostty-input")!;
  const terminalScreen = container.querySelector<HTMLElement>(".rc-ghostty-canvas")!;
  expect(lastTerminalOptions.focusOnPointer).toBe(false);
  helper.blur();
  expect(document.activeElement).not.toBe(helper);

  fireEvent.mouseDown(terminalScreen, { button: 0, clientX: 20, clientY: 20 });
  expect(document.activeElement, "terminal touch compatibility events must not focus input").not.toBe(helper);

  for (const name of ["Escape", "Control (sticky)", "Smaller text"] as const) {
    const button = screen.getByRole("button", { name });
    fireEvent.pointerDown(button, { pointerId: 40 });
    fireEvent.mouseDown(button);
    expect(document.activeElement, `${name} should not open the keyboard`).not.toBe(helper);
    fireEvent.pointerUp(button, { pointerId: 40 });
  }

  const chat = screen.getByRole("button", { name: "Chat input" });
  fireEvent.pointerDown(chat, { pointerId: 41 });
  fireEvent.pointerUp(chat, { pointerId: 41 });
  const message = screen.getByRole("textbox", { name: "Chat message" });
  expect(document.activeElement, "opening Chat should not raise the keyboard").not.toBe(message);
  const chatMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  message.dispatchEvent(chatMouseDown);
  expect(chatMouseDown.defaultPrevented, "the chat field must retain native tap-to-focus behavior").toBe(false);
  message.focus();
  expect(document.activeElement).toBe(message);

  const keyboard = screen.getByRole("button", { name: "Show keyboard" });
  message.blur();
  fireEvent.pointerDown(keyboard, { pointerId: 42 });
  fireEvent.pointerUp(keyboard, { pointerId: 42 });
  expect(document.activeElement).toBe(message);

  fireEvent.click(screen.getByRole("button", { name: "Close chat input" }));
  expect(document.activeElement).not.toBe(helper);
  fireEvent.pointerDown(keyboard, { pointerId: 43 });
  fireEvent.pointerUp(keyboard, { pointerId: 43 });
  expect(document.activeElement).toBe(helper);
});

test("ended overlay: a providerless session is a neutral shell and restarts without resume", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline"))); // ticket fetch fails → legacy URL
  try {
    const h = socketHarness();
    render(<TerminalView session={SESSION} createSocket={h.createSocket} />);
    await waitFor(() => expect(h.urls).toHaveLength(1));
    expect(h.urls[0]).not.toContain("respawn=");
    act(() => h.statusCbs[0]!("ended"));
    expect(screen.queryByRole("button", { name: "Resume conversation" })).not.toBeInTheDocument();
    expect(screen.getByText("Shell exited")).toBeInTheDocument();
    expect(screen.queryByText(/Claude|signed out/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
    await waitFor(() => expect(h.urls).toHaveLength(2));
    expect(h.urls[1]).not.toContain("respawn=continue");
    act(() => h.statusCbs[1]!("open"));
  } finally {
    vi.unstubAllGlobals();
  }
});

test("ended overlay: an exact Codex identity resumes that conversation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  try {
    const h = socketHarness();
    render(
      <TerminalView
        session={{
          ...SESSION,
          provider: "codex",
          identityState: "exact",
          providerSessionId: "thread-exact-123",
        }}
        createSocket={h.createSocket}
      />,
    );
    await waitFor(() => expect(h.urls).toHaveLength(1));
    act(() => h.statusCbs[0]!("ended"));
    const resume = screen.getByRole("button", { name: "Resume conversation" });
    expect(resume).toBeEnabled();
    expect(screen.getByText("Codex exited")).toBeInTheDocument();
    fireEvent.click(resume);
    await waitFor(() => expect(h.urls).toHaveLength(2));
    expect(h.urls[1]).toContain("respawn=continue");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("ended overlay: an unsupported legacy runtime keeps its own identity and copy", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  try {
    const h = socketHarness();
    render(
      <TerminalView
        session={{
          ...SESSION,
          provider: "review-agent",
          resumeIdentity: "required",
          identityState: "exact",
          providerSessionId: "review-42",
        }}
        createSocket={h.createSocket}
      />,
    );
    await waitFor(() => expect(h.urls).toHaveLength(1));
    act(() => h.statusCbs[0]!("ended"));
    expect(screen.getByText("Review Agent exited")).toBeInTheDocument();
    expect(screen.queryByText("Claude Code exited")).not.toBeInTheDocument();
    expect(screen.getByText(/asks Review Agent to continue this adapter session/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Resume conversation" })).toBeEnabled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("ended overlay: an ambiguous Codex identity disables resume but Start fresh still reconnects", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  try {
    const h = socketHarness();
    render(
      <TerminalView
        session={{ ...SESSION, provider: "codex", identityState: "ambiguous" }}
        createSocket={h.createSocket}
      />,
    );
    await waitFor(() => expect(h.urls).toHaveLength(1));
    act(() => h.statusCbs[0]!("ended"));
    expect(screen.getByRole("button", { name: "Resume conversation" })).toBeDisabled();
    expect(screen.getByText(/exact Codex conversation.*unavailable/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    await waitFor(() => expect(h.urls).toHaveLength(2));
    expect(h.urls[1]).not.toContain("respawn=continue");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("ended overlay: a pending Codex identity keeps Resume visible but disabled", () => {
  const h = socketHarness();
  render(
    <TerminalView
      session={{ ...SESSION, provider: "codex", identityState: "pending" }}
      createSocket={h.createSocket}
    />,
  );
  act(() => h.statusCbs[0]!("ended"));
  expect(screen.getByRole("button", { name: "Resume conversation" })).toBeDisabled();
  expect(screen.getByText(/exact Codex conversation.*unavailable/i)).toBeVisible();
});

test.each([
  ["missing", undefined],
  ["empty", ""],
  ["oversized", "x".repeat(2_049)],
  ["control-bearing", "thread\nid"],
])("ended overlay: an exact Codex identity with a %s id cannot resume", (_label, providerSessionId) => {
  const h = socketHarness();
  render(
    <TerminalView
      session={{ ...SESSION, provider: "codex", identityState: "exact", providerSessionId }}
      createSocket={h.createSocket}
    />,
  );
  act(() => h.statusCbs[0]!("ended"));
  expect(screen.getByRole("button", { name: "Resume conversation" })).toBeDisabled();
  expect(screen.getByText(/exact Codex conversation.*unavailable/i)).toBeVisible();
});

test.each(["--last", "  -thread"])(
  "ended overlay: an argv-like Codex id %j cannot resume but Start fresh remains available",
  async (providerSessionId) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    try {
      const h = socketHarness();
      render(
        <TerminalView
          session={{ ...SESSION, provider: "codex", identityState: "exact", providerSessionId }}
          createSocket={h.createSocket}
        />,
      );
      await waitFor(() => expect(h.urls).toHaveLength(1));
      act(() => h.statusCbs[0]!("ended"));
      const resume = screen.getByRole("button", { name: "Resume conversation" });
      expect(resume).toBeDisabled();
      fireEvent.click(resume);
      await act(async () => Promise.resolve());
      expect(h.urls).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
      await waitFor(() => expect(h.urls).toHaveLength(2));
      expect(h.urls[1]).not.toContain("respawn=continue");
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

test("ended overlay: 'Start fresh' reconnects WITHOUT a respawn=continue query", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  try {
    const h = socketHarness();
    render(
      <TerminalView
        session={{
          ...SESSION,
          launch: { kind: "managed", provider: "claude" },
          provider: "claude",
        }}
        createSocket={h.createSocket}
      />,
    );
    act(() => h.statusCbs[0]!("ended"));
    // Both choices + the explanatory hint are on the overlay.
    expect(screen.getByText(/resume reopens the last Claude Code conversation in this folder/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    await waitFor(() => expect(h.urls).toHaveLength(2));
    expect(h.urls[1]).not.toContain("respawn=continue");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a QUICK neutral shell exit never invents a Claude authentication problem", () => {
  const h = socketHarness();
  render(<TerminalView session={SESSION} createSocket={h.createSocket} />);
  act(() => h.statusCbs[0]!("ended"));
  expect(screen.getByText("Shell exited")).toBeInTheDocument();
  expect(screen.getByText("The shell closed before the terminal was ready.")).toBeVisible();
  expect(screen.queryByText(/Claude|signed out|account/i)).not.toBeInTheDocument();
});

test("a QUICK Codex exit uses Codex-native title and authentication hint", () => {
  const h = socketHarness();
  render(
    <TerminalView
      session={{
        ...SESSION,
        provider: "codex",
        identityState: "exact",
        providerSessionId: "thread-exact-123",
      }}
      createSocket={h.createSocket}
    />,
  );
  act(() => h.statusCbs[0]!("ended"));
  expect(screen.getByText("Codex exited")).toBeInTheDocument();
  expect(screen.getByText(/Codex may be signed out on the host/i)).toHaveTextContent(
    /run codex.*Settings → Codex account/i,
  );
});

test("a SLOW exit (>= 10s after spawn) shows the plain ended overlay without the signed-out hint", () => {
  // Freeze the clock, mount (stamps the spawn moment), then jump past the boot window before "ended".
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const h = socketHarness();
  render(<TerminalView session={SESSION} createSocket={h.createSocket} />);
  nowSpy.mockReturnValue(1_000_000 + 11_000);
  act(() => h.statusCbs[0]!("ended"));
  expect(screen.getByRole("button", { name: "Restart terminal" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Resume conversation" })).not.toBeInTheDocument();
  expect(screen.queryByText(/may be signed out on the host/i)).not.toBeInTheDocument();
});

test("find bar: searches the buffer case-insensitively, shows the count, and steps through matches", () => {
  mockLines = ["hello world", "nothing here", "say HELLO again"];
  const h = socketHarness();
  render(<TerminalView session={SESSION} createSocket={h.createSocket} />);
  // The bar is hidden until the tools-group search toggle opens it.
  expect(screen.queryByLabelText("Find in terminal")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Search the terminal" }));
  const input = screen.getByLabelText("Find in terminal");
  fireEvent.change(input, { target: { value: "hello" } });
  // Two case-insensitive hits; the FIRST is selected + scrolled into view immediately.
  expect(screen.getByText("1/2")).toBeInTheDocument();
  expect(selects.at(-1)).toEqual({ col: 0, row: 0, length: 5 });
  expect(scrolledTo.at(-1)).toBe(0);
  // Next (button) → the second hit; Enter in the input steps too (wrap-around back to the first).
  fireEvent.click(screen.getByRole("button", { name: "Next match" }));
  expect(screen.getByText("2/2")).toBeInTheDocument();
  expect(selects.at(-1)).toEqual({ col: 4, row: 2, length: 5 });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByText("1/2")).toBeInTheDocument();
  expect(selects.at(-1)).toEqual({ col: 0, row: 0, length: 5 });
  // Shift+Enter steps backwards (wraps to the last).
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(screen.getByText("2/2")).toBeInTheDocument();
  // A miss reads 0/0 (quiet, not an error); Escape closes the bar.
  fireEvent.change(input, { target: { value: "zebra" } });
  expect(screen.getByText("0/0")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByLabelText("Find in terminal")).not.toBeInTheDocument();
});

test("passes the complete saved terminal theme to Ghostty", () => {
  render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  expect(lastTerminalOptions.theme).toMatchObject({
    background: "#0a0a0b",
    foreground: "#cdd6e4",
    cursor: "#cdd6e4",
    selectionBackground: "#50617a",
    selectionForeground: "#ffffff",
  });
  expect((lastTerminalOptions.theme as { palette?: string[] }).palette).toHaveLength(16);
});

test("plain desktop click still reaches a mouse-tracking terminal after small pointer movement", () => {
  mockMouseTrackingMode = "drag";
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 1 });
  fireEvent.mouseMove(terminalScreen, { button: 0, buttons: 1, clientX: 22, clientY: 22 });
  expect(terminalMouseEvents).toEqual([]); // held until click vs drag is known
  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 22, clientY: 22, detail: 1 });

  expect(terminalMouseEvents).toEqual([
    { type: "mousedown", altKey: false, shiftKey: false, detail: 1 },
    { type: "mouseup", altKey: false, shiftKey: false, detail: 1 },
  ]);
});

test("desktop click opens a link without sending the click to a mouse-tracking provider", () => {
  mockMouseTrackingMode = "drag";
  mockLinks = [{ uri: "https://example.com/docs", start: { col: 2, row: 0 }, end: { col: 26, row: 0 } }];
  const popup = { opener: {}, location: { href: "about:blank" } } as unknown as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseMove(terminalScreen, { buttons: 0, clientX: 45, clientY: 10 });
  terminalMouseEvents.length = 0;
  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 45, clientY: 10, detail: 1 });
  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 45, clientY: 10, detail: 1 });

  expect(open).toHaveBeenCalledOnce();
  expect(popup.opener).toBeNull();
  expect(popup.location.href).toBe("https://example.com/docs");
  expect(terminalMouseEvents).toEqual([]);
});

test("desktop opens a URL from either visual row when Ghostty reports one wrapped link", () => {
  mockLinks = [
    {
      uri: "https://example.com/a/very/long/wrapped/path",
      start: { col: 72, row: 0 },
      end: { col: 38, row: 1 },
    },
  ];
  const popup = { opener: {}, location: { href: "about:blank" } } as unknown as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseMove(terminalScreen, { buttons: 0, clientX: 75, clientY: 30 });
  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 75, clientY: 30, detail: 1 });
  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 75, clientY: 30, detail: 1 });

  expect(open).toHaveBeenCalledOnce();
  expect(popup.location.href).toBe("https://example.com/a/very/long/wrapped/path");
});

test("desktop resolves a newly appeared link on the first click without requiring prior pointer movement", () => {
  mockLinks = [{ uri: "https://example.com/fresh", start: { col: 2, row: 0 }, end: { col: 26, row: 0 } }];
  const popup = { opener: {}, location: { href: "about:blank" } } as unknown as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 45, clientY: 10, detail: 1 });
  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 45, clientY: 10, detail: 1 });

  expect(open).toHaveBeenCalledOnce();
  expect(popup.location.href).toBe("https://example.com/fresh");
});

test("dragging across a desktop link selects instead of opening it", () => {
  mockLinks = [{ uri: "https://example.com/docs", start: { col: 2, row: 0 }, end: { col: 26, row: 0 } }];
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseMove(terminalScreen, { buttons: 0, clientX: 45, clientY: 10 });
  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 45, clientY: 10, detail: 1 });
  fireEvent.mouseMove(terminalScreen, { button: 0, buttons: 1, clientX: 145, clientY: 10 });
  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 145, clientY: 10, detail: 1 });

  expect(open).not.toHaveBeenCalled();
});

test("double-clicking a desktop link remains word selection and does not open it", () => {
  mockLinks = [{ uri: "https://example.com/docs", start: { col: 2, row: 0 }, end: { col: 26, row: 0 } }];
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseMove(terminalScreen, { buttons: 0, clientX: 45, clientY: 10 });
  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 45, clientY: 10, detail: 2 });
  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 45, clientY: 10, detail: 2 });

  expect(open).not.toHaveBeenCalled();
});

test("plain desktop drag stays inside Ghostty selection without synthetic modifier events", () => {
  mockMouseTrackingMode = "drag";
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 1 });
  fireEvent.mouseMove(terminalScreen, { button: 0, buttons: 1, clientX: 80, clientY: 20 });

  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 80, clientY: 20, detail: 1 });
  expect(terminalMouseEvents).toEqual([]);
});

test("double-click stays in Ghostty word selection while mouse tracking is active", () => {
  mockMouseTrackingMode = "drag";
  mockLines = ["  word"];
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 20, clientY: 10, detail: 2 });

  expect(terminalMouseEvents).toEqual([]);
  expect(mockSelection).toBe("word");
});

test("normal-buffer selection does not manufacture provider mouse input", () => {
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "claude" }} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 1 });

  expect(terminalMouseEvents).toEqual([]);
});

test("buttonless Claude hover cannot clear a finished selection", () => {
  mockMouseTrackingMode = "any";
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "claude" }} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;
  mockSelection = "keep this selected";
  mockSelectionRange = { start: { x: 0, y: 0 }, end: { x: 18, y: 0 } };

  fireEvent.mouseMove(terminalScreen, { button: 0, buttons: 0, clientX: 90, clientY: 20 });

  expect(terminalMouseEvents).toEqual([]);
  expect(mockSelection).toBe("keep this selected");
});

test("Claude hover continues reaching Ghostty when no selection exists", () => {
  mockMouseTrackingMode = "any";
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "claude" }} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseMove(terminalScreen, { button: 0, buttons: 0, clientX: 90, clientY: 20 });

  expect(terminalMouseEvents).toEqual([{ type: "mousemove", altKey: false, shiftKey: false, detail: 0 }]);
});

test("secondary-click selects through Ghostty and leaves the native context menu untouched", () => {
  mockLines = ["hello /tmp/error.log world"];
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  // Cell width is 10px in the mock screen. Right-click the middle of `/tmp/error.log`.
  fireEvent.mouseDown(terminalScreen, { button: 2, clientX: 95, clientY: 10 });
  const contextMenu = new MouseEvent("contextmenu", {
    button: 2,
    clientX: 95,
    clientY: 10,
    bubbles: true,
    cancelable: true,
  });
  terminalScreen.dispatchEvent(contextMenu);

  expect(contextMenu.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu", { name: "Terminal clipboard menu" })).toBeNull();
  expect(mockSelection).toBe("/tmp/error.log");
  expect(selects.at(-1)).toEqual({ col: 6, row: 0, length: 14 });
});

test("secondary-click never mounts a RoamCode clipboard popup", () => {
  mockLines = ["selected text stays"];
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;
  mockSelection = "selected text";
  mockSelectionRange = { start: { x: 0, y: 0 }, end: { x: 13, y: 0 } };

  fireEvent.mouseDown(terminalScreen, { button: 2, clientX: 185, clientY: 10 });
  fireEvent.contextMenu(terminalScreen, { button: 2, clientX: 185, clientY: 10 });
  expect(screen.queryByRole("menu", { name: "Terminal clipboard menu" })).toBeNull();
});

test("Chat opens above the key bar, accepts a direct field tap, and Send uses bracketed paste", () => {
  const before = sent.length;
  render(<TerminalView session={SESSION} />);

  const chat = screen.getByRole("button", { name: "Chat input" });
  fireEvent.pointerDown(chat, { pointerId: 21 });
  fireEvent.pointerUp(chat, { pointerId: 21 });
  const composer = screen.getByRole("region", { name: "Chat input composer" });
  const toolbar = screen.getByRole("toolbar", { name: "Terminal keys" });
  expect(composer.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "Chat message" });
  expect(document.activeElement).not.toBe(input);

  const chatMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  input.dispatchEvent(chatMouseDown);
  expect(chatMouseDown.defaultPrevented).toBe(false);
  input.focus();
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "typed prompt\nwith detail" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  expect(sent.slice(before)).toEqual(["\x1b[200~typed prompt\nwith detail\x1b[201~"]);
  expect(screen.queryByRole("region", { name: "Chat input composer" })).toBeNull();
});

test("an unsent compose draft survives host switching without crossing host boundaries", () => {
  const connectionA = { hostId: "host_a", baseUrl: "https://a.example", getToken: () => "token-a" };
  const connectionB = { hostId: "host_b", baseUrl: "https://b.example", getToken: () => "token-b" };
  const first = render(<TerminalView session={SESSION} connection={connectionA} />);
  let compose = screen.getByRole("button", { name: "Chat input" });
  fireEvent.pointerDown(compose, { pointerId: 22 });
  fireEvent.pointerUp(compose, { pointerId: 22 });
  fireEvent.change(screen.getByRole("textbox", { name: "Chat message" }), {
    target: { value: "host A draft" },
  });
  first.unmount();

  const second = render(<TerminalView session={SESSION} connection={connectionB} />);
  compose = screen.getByRole("button", { name: "Chat input" });
  fireEvent.pointerDown(compose, { pointerId: 23 });
  fireEvent.pointerUp(compose, { pointerId: 23 });
  expect(screen.getByRole("textbox", { name: "Chat message" })).toHaveValue("");
  second.unmount();

  render(<TerminalView session={SESSION} connection={connectionA} />);
  compose = screen.getByRole("button", { name: "Chat input" });
  fireEvent.pointerDown(compose, { pointerId: 24 });
  fireEvent.pointerUp(compose, { pointerId: 24 });
  expect(screen.getByRole("textbox", { name: "Chat message" })).toHaveValue("host A draft");
});

test("a completed file upload inserts its path as bracketed prompt text without submitting Enter", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [], policy: { maxUploadBytes: 25 * 1024 * 1024 } }),
    }),
  );
  class SuccessfulUpload {
    status = 201;
    responseText = JSON.stringify({
      path: "/data/terminal-shared/s1/file-id/notes.txt",
      file: {
        id: "file-id",
        direction: "sent",
        storage: "managed",
        name: "notes.txt",
        path: "/data/terminal-shared/s1/file-id/notes.txt",
        mimeType: "text/plain",
        size: 5,
        kind: "text",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
        available: true,
      },
    });
    upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    open() {}
    setRequestHeader() {}
    send() {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 5 });
      queueMicrotask(() => this.onload?.());
    }
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", SuccessfulUpload);
  const before = sent.length;
  const view = render(<TerminalView session={SESSION} />);

  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  const input = view.container.querySelector<HTMLInputElement>('.rc-tf input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] } });

  await waitFor(() => expect(screen.getByText("notes.txt")).toBeInTheDocument());
  expect(sent.slice(before)).toEqual([
    '\x1b[200~Attached file: "/data/terminal-shared/s1/file-id/notes.txt" \x1b[201~',
  ]);
  expect(sent.at(-1)).not.toMatch(/[\r\n]$/);
});

test("a remote Node file upload uses the injected transport and exposes real progress", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [], policy: { maxUploadBytes: 25 * 1024 * 1024 } }),
    }),
  );
  const xhr = vi.fn();
  vi.stubGlobal("XMLHttpRequest", xhr);
  let reportProgress!: (fraction: number) => void;
  let finishUpload!: (response: Response) => void;
  const abort = vi.fn();
  const uploadRequest = vi.fn<NonNullable<ApiClientOptions["uploadRequest"]>>((...args) => {
    const onProgress = args[2];
    reportProgress = onProgress;
    return {
      abort,
      promise: new Promise<Response>((resolve) => {
        finishUpload = resolve;
      }),
    };
  });
  const connection: ApiClientOptions & { hostId: string } = {
    hostId: "remote-node",
    baseUrl: "https://node.example",
    getToken: () => "device-token",
    uploadRequest,
  };
  const before = sent.length;
  const view = render(<TerminalView session={SESSION} connection={connection} />);

  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  const input = view.container.querySelector<HTMLInputElement>('.rc-tf input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(["hello"], "remote.txt", { type: "text/plain" })] } });

  await waitFor(() => expect(uploadRequest).toHaveBeenCalledTimes(1));
  const [endpoint, init, , contentBytes] = uploadRequest.mock.calls[0]!;
  expect(endpoint).toBe("https://node.example/sessions/s1/upload");
  expect(init).toMatchObject({
    method: "POST",
    headers: { authorization: "Bearer device-token" },
    body: expect.any(FormData),
  });
  expect(contentBytes).toBe(5);
  expect(xhr).not.toHaveBeenCalled();

  act(() => reportProgress(0.5));
  expect(screen.getByRole("progressbar", { name: "Uploading remote.txt" })).toHaveAttribute("aria-valuenow", "50");

  await act(async () => {
    finishUpload(
      new Response(
        JSON.stringify({
          path: "/data/terminal-shared/s1/remote-file/remote.txt",
          file: {
            id: "remote-file",
            direction: "sent",
            storage: "managed",
            name: "remote.txt",
            path: "/data/terminal-shared/s1/remote-file/remote.txt",
            mimeType: "text/plain",
            size: 5,
            kind: "text",
            createdAt: 1,
            updatedAt: 1,
            available: true,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(sent.slice(before)).toEqual([
      '\x1b[200~Attached file: "/data/terminal-shared/s1/remote-file/remote.txt" \x1b[201~',
    ]),
  );
  expect(abort).not.toHaveBeenCalled();
});

test("cancelling a remote Node upload aborts the transfer and removes its pending row", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [], policy: { maxUploadBytes: 25 * 1024 * 1024 } }),
    }),
  );
  let rejectUpload!: (reason: unknown) => void;
  const abort = vi.fn(() => rejectUpload(new DOMException("Upload cancelled", "AbortError")));
  const connection: ApiClientOptions & { hostId: string } = {
    hostId: "remote-node",
    baseUrl: "https://node.example",
    getToken: () => "device-token",
    uploadRequest: () => ({
      abort,
      promise: new Promise<Response>((_resolve, reject) => {
        rejectUpload = reject;
      }),
    }),
  };
  const view = render(<TerminalView session={SESSION} connection={connection} />);

  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  const input = view.container.querySelector<HTMLInputElement>('.rc-tf input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(["stop"], "cancel.txt", { type: "text/plain" })] } });
  await waitFor(() => expect(screen.getByText("cancel.txt")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(abort).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByText("cancel.txt")).toBeNull());
});

test("a transient file-history failure retries automatically without surfacing an error", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("server restarting"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ files: [], policy: { maxUploadBytes: 25 * 1024 * 1024 } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const close = vi.fn();
    const inertSocket = (() => ({
      sendInput: () => {},
      sendResize: () => {},
      reconnect: () => {},
      close: () => {},
    })) as unknown as typeof createTerminalSocket;
    const view = render(<TerminalView session={SESSION} onClose={close} createSocket={inertSocket} />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(350);
    });
    fireEvent.click(screen.getByRole("button", { name: "Files" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("No received files yet")).toBeInTheDocument();
    expect(screen.queryByText("File history unavailable")).toBeNull();
    expect(screen.getByRole("group", { name: "Terminal" })).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});

test("a repeatedly stalled file-history request times out inside Files without closing the terminal", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const close = vi.fn();
    const inertSocket = (() => ({
      sendInput: () => {},
      sendResize: () => {},
      reconnect: () => {},
      close: () => {},
    })) as unknown as typeof createTerminalSocket;
    const view = render(<TerminalView session={SESSION} onClose={close} createSocket={inertSocket} />);

    expect(screen.getByRole("group", { name: "Terminal" })).toBeInTheDocument();
    await act(async () => void (await vi.advanceTimersByTimeAsync(7_500)));
    fireEvent.click(screen.getByRole("button", { name: "Files" }));

    expect(screen.getByText("File history unavailable")).toBeInTheDocument();
    expect(screen.getByText(/terminal is still connected/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Terminal" })).toBeInTheDocument();
    expect(view.container.querySelector(".rc-term-uploaderr")).toBeNull();
    expect(close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});

test("replayed attachment controls do not inflate the unread badge after durable history loads", async () => {
  const historyFile = {
    id: "received-1",
    direction: "received",
    storage: "workspace",
    name: "history.png",
    path: "/work/history.png",
    mimeType: "image/png",
    size: 10,
    kind: "image",
    isImage: true,
    createdAt: 100,
    updatedAt: 100,
    expiresAt: 10_000,
    available: true,
  };
  window.localStorage.removeItem(`rc-files-seen:${SESSION.id}`);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [historyFile], policy: { maxUploadBytes: 25 * 1024 * 1024 } }),
    }),
  );
  let control: ((json: string) => void) | undefined;
  const createSocket = ((opts: { onControl?: (json: string) => void }) => {
    control = opts.onControl;
    return { sendInput: () => {}, sendResize: () => {}, reconnect: () => {}, close: () => {} };
  }) as unknown as typeof createTerminalSocket;
  render(<TerminalView session={SESSION} createSocket={createSocket} />);

  await waitFor(() => expect(control).toBeDefined());
  await waitFor(() => expect(screen.getByRole("button", { name: "Files, 1 new" })).toBeInTheDocument());
  act(() => control?.(JSON.stringify({ t: "attach", ...historyFile })));
  expect(screen.getByRole("button", { name: "Files, 1 new" })).toBeInTheDocument();

  act(() =>
    control?.(
      JSON.stringify({
        t: "attach",
        ...historyFile,
        id: "received-2",
        name: "new.png",
        path: "/work/new.png",
        createdAt: 2000,
      }),
    ),
  );
  expect(screen.getByRole("button", { name: "Files, 2 new" })).toBeInTheDocument();
  window.localStorage.removeItem(`rc-files-seen:${SESSION.id}`);
});

test("secondary-click on whitespace still leaves the platform menu native", () => {
  mockLines = ["hello"];
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseDown(terminalScreen, { button: 2, clientX: 255, clientY: 10 });
  const contextMenu = new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
  terminalScreen.dispatchEvent(contextMenu);
  expect(contextMenu.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu", { name: "Terminal clipboard menu" })).toBeNull();
});

test("secondary-click word selection follows Ghostty wrapped rows without product chrome", () => {
  mockLines = [`${" ".repeat(78)}ab`, "cd rest"];
  mockWrappedRows.add(1);
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".rc-ghostty-canvas")!;

  fireEvent.mouseDown(terminalScreen, { button: 2, clientX: 15, clientY: 30 });
  fireEvent.contextMenu(terminalScreen, { button: 2, clientX: 15, clientY: 30 });

  expect(mockSelection).toBe("abcd");
  expect(selects.at(-1)).toEqual({ col: 78, row: 0, length: 4 });
  expect(screen.queryByRole("menu", { name: "Terminal clipboard menu" })).toBeNull();
});

test("Cmd/Ctrl+C copies a Ghostty selection, while Ctrl+C without a selection remains terminal input", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
  });
  render(<TerminalView session={SESSION} />);
  mockSelection = "explicit selection";
  mockSelectionRange = { start: { x: 0, y: 0 }, end: { x: 18, y: 0 } };

  const copyEvent = new KeyboardEvent("keydown", { key: "c", metaKey: true, cancelable: true });
  expect(customKeyHandler?.(copyEvent)).toBe(false);
  await waitFor(() => expect(written).toEqual(["explicit selection"]));

  mockSelection = "";
  mockSelectionRange = undefined;
  const interruptEvent = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, cancelable: true });
  expect(customKeyHandler?.(interruptEvent)).toBe(true);
});

test("LONG-PRESS acquires a word, extends under the held finger, and opens actions only after release", () => {
  vi.useFakeTimers();
  try {
    mockLines = ["hello /tmp/error.log world"];
    const { container } = render(<TerminalView session={SESSION} />);
    const host = container.querySelector(".rc-terminal__host")!;
    const helper = container.querySelector<HTMLTextAreaElement>(".rc-ghostty-input")!;
    helper.focus();
    // Hold over the path → Ghostty acquires the real word range but does not put a menu under the active finger.
    fireEvent.touchStart(host, { touches: [{ clientX: 95, clientY: 10 }] });
    act(() => void vi.advanceTimersByTime(600));
    expect(mockSelection).toBe("/tmp/error.log");
    expect(screen.queryByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeNull();
    const startHandle = screen.getByRole("button", { name: "Adjust selection start" });
    const endHandle = screen.getByRole("button", { name: "Adjust selection end" });
    expect(startHandle).toHaveStyle({ top: "0px" });
    expect(endHandle).toHaveStyle({ top: "20px" });
    expect(document.activeElement).toBe(helper);

    // Without lifting, continue to the end of "world": the initial word stays the anchor and the live range grows.
    fireEvent.touchMove(host, { touches: [{ clientX: 255, clientY: 10 }] });
    expect(selects.at(-1)).toEqual({ col: 6, row: 0, length: 20 });
    expect(mockSelection).toBe("/tmp/error.log world");
    expect(screen.queryByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeNull();

    fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 255, clientY: 10 }] });
    expect(screen.getByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Select all" })).toBeInTheDocument();
    expect(document.activeElement).toBe(helper);
    fireEvent.click(screen.getByRole("menuitem", { name: "Select all" }));
    expect(selects.at(-1)).toEqual({ col: 0, row: 0, length: 80 });
    expect(screen.getByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Select text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select / copy text" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
    expect(mockSelection).toBe("");
    // Normal finger jitter stays eligible and acquires the cell currently under the finger.
    fireEvent.touchStart(host, { touches: [{ clientX: 95, clientY: 10 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 103, clientY: 14 }] });
    act(() => void vi.advanceTimersByTime(600));
    expect(mockSelection).toBe("/tmp/error.log");
    expect(screen.queryByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeNull();
    fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 103, clientY: 14 }] });
    fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
    // A finger that MOVES (scrolling / driving the TUI) must never trigger it.
    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 80 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 50, clientY: 140 }] });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.queryByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeNull();
    // Lifting early cancels too.
    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 80 }] });
    fireEvent.touchEnd(host, { touches: [] });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.queryByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("a clean mobile tap opens a link once without leaking a terminal mouse click", () => {
  mockLinks = [{ uri: "https://example.com/mobile", start: { col: 2, row: 0 }, end: { col: 28, row: 0 } }];
  const popup = { opener: {}, location: { href: "about:blank" } } as unknown as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  const { container } = render(<TerminalView session={SESSION} />);
  const host = container.querySelector(".rc-terminal__host")!;

  fireEvent.touchStart(host, { touches: [{ clientX: 45, clientY: 10 }] });
  fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 45, clientY: 10 }] });

  expect(open).toHaveBeenCalledOnce();
  expect(popup.location.href).toBe("https://example.com/mobile");
  expect(terminalMouseEvents).toEqual([]);
});

test("mobile movement and long-press selection never open a link", () => {
  vi.useFakeTimers();
  try {
    mockLines = ["  https://example.com/mobile rest"];
    mockLinks = [{ uri: "https://example.com/mobile", start: { col: 2, row: 0 }, end: { col: 28, row: 4 } }];
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = render(<TerminalView session={SESSION} />);
    const host = container.querySelector(".rc-terminal__host")!;

    fireEvent.touchStart(host, { touches: [{ clientX: 45, clientY: 10 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 45, clientY: 70 }] });
    fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 45, clientY: 70 }] });
    expect(open).not.toHaveBeenCalled();

    fireEvent.touchStart(host, { touches: [{ clientX: 45, clientY: 10 }] });
    act(() => void vi.advanceTimersByTime(600));
    fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 45, clientY: 10 }] });
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test("a cancelled mobile touch never opens a link", () => {
  mockLinks = [{ uri: "https://example.com/mobile", start: { col: 2, row: 0 }, end: { col: 28, row: 0 } }];
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { container } = render(<TerminalView session={SESSION} />);
  const host = container.querySelector(".rc-terminal__host")!;

  fireEvent.touchStart(host, { touches: [{ clientX: 45, clientY: 10 }] });
  fireEvent.touchCancel(host, { touches: [], changedTouches: [{ clientX: 45, clientY: 10 }] });

  expect(open).not.toHaveBeenCalled();
});

test("one-finger normal-buffer movement stays on the native terminal scroller", () => {
  const { container } = render(<TerminalView session={SESSION} />);
  const host = container.querySelector(".rc-terminal__host")!;
  fireEvent.touchStart(host, { touches: [{ clientX: 45, clientY: 10 }] });

  const move = new Event("touchmove", { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(move, "touches", {
    value: [{ clientX: 45, clientY: 80 }],
  });
  host.dispatchEvent(move);

  expect(move.defaultPrevented).toBe(false);
  expect(lastTerminalOptions.nativeScroll).toBe(true);
  expect(scrolledLines).toEqual([]);
});

test("one-finger native scroll keeps taps and horizontal drags out of terminal input", () => {
  const before = sent.length;
  mockLinks = [{ uri: "https://example.com/mobile", start: { col: 2, row: 0 }, end: { col: 28, row: 0 } }];
  const popup = { opener: {}, location: { href: "about:blank" } } as unknown as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  const { container } = render(<TerminalView session={SESSION} />);
  const host = container.querySelector(".rc-terminal__host")!;

  fireEvent.touchStart(host, { touches: [{ clientX: 45, clientY: 10 }] });
  fireEvent.touchMove(host, { touches: [{ clientX: 47, clientY: 18 }] });
  fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 47, clientY: 18 }] });
  expect(open).toHaveBeenCalledOnce();
  expect(scrolledLines).toEqual([]);

  fireEvent.touchStart(host, { touches: [{ clientX: 45, clientY: 100 }] });
  fireEvent.touchMove(host, { touches: [{ clientX: 105, clientY: 110 }] });
  fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 105, clientY: 110 }] });
  expect(open).toHaveBeenCalledOnce();
  expect(scrolledLines).toEqual([]);

  fireEvent.touchStart(host, { touches: [{ clientX: 45, clientY: 100 }] });
  fireEvent.touchMove(host, { touches: [{ clientX: 45, clientY: 150 }] });
  fireEvent.touchMove(host, { touches: [{ clientX: 45, clientY: 100 }] });
  fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 45, clientY: 100 }] });
  expect(scrolledLines).toEqual([]);
  expect(sent.slice(before)).toEqual([]);
});

test("alternate-screen mouse apps receive scroll at the touched pane instead of cell 1,1", () => {
  mockBufferType = "alternate";
  mockMouseTrackingMode = "any";
  const before = sent.length;
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const host = container.querySelector(".rc-terminal__host")!;

  fireEvent.touchStart(host, { touches: [{ clientX: 40, clientY: 100 }] });
  fireEvent.touchMove(host, { touches: [{ clientX: 40, clientY: 150 }] });

  expect(sent.slice(before)).toEqual(["\x1b[<64;1;1M"]);
  expect(terminalWheelCalls).toEqual([{ up: true, count: 1, clientX: 40, clientY: 150 }]);
});

test("Codex's normal buffer uses browser-native scrollback without entering tmux copy mode", () => {
  const before = sent.length;
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const host = container.querySelector(".rc-terminal__host")!;

  fireEvent.touchStart(host, { touches: [{ clientX: 40, clientY: 100 }] });
  fireEvent.touchMove(host, { touches: [{ clientX: 40, clientY: 150 }] });

  expect(sent.slice(before)).toEqual([]);
  expect(terminalWheelCalls).toEqual([]);
});

test("one-finger scroll pages an alternate-screen provider", () => {
  mockBufferType = "alternate";
  const before = sent.length;
  const { container } = render(<TerminalView session={SESSION} />);
  const host = container.querySelector(".rc-terminal__host")!;

  fireEvent.touchStart(host, { touches: [{ clientX: 40, clientY: 100 }] });
  fireEvent.touchMove(host, { touches: [{ clientX: 40, clientY: 150 }] });

  expect(sent.slice(before)).toEqual(["\x1b[5~"]);
  expect(scrolledLines).toEqual([]);
});

test("multi-touch does not drive terminal scrollback", () => {
  const before = sent.length;
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const host = container.querySelector(".rc-terminal__host")!;

  fireEvent.touchStart(host, {
    touches: [
      { clientX: 40, clientY: 100 },
      { clientX: 90, clientY: 100 },
    ],
  });
  fireEvent.touchMove(host, {
    touches: [
      { clientX: 40, clientY: 160 },
      { clientX: 90, clientY: 160 },
    ],
  });

  expect(sent.slice(before)).toEqual([]);
  expect(scrolledLines).toEqual([]);
});

test("the touch-device hint teaches one-finger scroll without resetting learned storage", () => {
  vi.stubGlobal("matchMedia", vi.fn(coarsePointerMedia));
  vi.useFakeTimers();
  try {
    localStorage.removeItem("rc-scroll-hint-learned");
    localStorage.removeItem("rc-scroll-hint-shows");
    const first = render(<TerminalView session={SESSION} />);
    act(() => void vi.advanceTimersByTime(750));
    expect(screen.getByRole("button", { name: /scroll the terminal with one finger/i })).toHaveTextContent(
      "Scroll with one finger",
    );
    expect(localStorage.getItem("rc-scroll-hint-shows")).toBe("1");
    first.unmount();

    localStorage.setItem("rc-scroll-hint-learned", "1");
    render(<TerminalView session={SESSION} />);
    act(() => void vi.advanceTimersByTime(750));
    expect(screen.queryByRole("button", { name: /scroll the terminal with one finger/i })).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test("mobile key bar omits paging, edge, and Alt controls", () => {
  render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);

  for (const removed of ["Page up", "Page down", "Home", "End", "Alt (sticky)"]) {
    expect(screen.queryByRole("button", { name: removed })).toBeNull();
  }
  expect(screen.getByRole("button", { name: "Chat input" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show keyboard" })).toBeInTheDocument();
});

test("mobile Copy closes only the menu; tapping the retained range reopens it and Done clears it", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
  });
  vi.useFakeTimers();
  try {
    mockLines = ["hello /tmp/error.log world"];
    const { container } = render(<TerminalView session={SESSION} />);
    const host = container.querySelector(".rc-terminal__host")!;
    fireEvent.touchStart(host, { touches: [{ clientX: 95, clientY: 10 }] });
    act(() => void vi.advanceTimersByTime(600));
    fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 95, clientY: 10 }] });

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    await act(async () => Promise.resolve());
    expect(written).toEqual(["/tmp/error.log"]);
    expect(screen.queryByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeNull();
    expect(screen.getByRole("button", { name: "Adjust selection start" })).toBeInTheDocument();

    const guard = container.querySelector(".rc-term-touch-selection__guard")!;
    fireEvent.pointerDown(guard, { pointerId: 7, clientX: 95, clientY: 10 });
    fireEvent.pointerUp(guard, { pointerId: 7, clientX: 95, clientY: 10 });
    expect(screen.getByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
    expect(mockSelection).toBe("");
    expect(container.querySelector(".rc-term-touch-selection__guard")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("mobile handles resize and cross the live Ghostty range, while Paste sends the clipboard directly", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: () => Promise.resolve("clipboard prompt") },
  });
  const before = sent.length;
  vi.useFakeTimers();
  try {
    mockLines = ["hello /tmp/error.log world"];
    const { container } = render(<TerminalView session={SESSION} />);
    const host = container.querySelector(".rc-terminal__host")!;
    fireEvent.touchStart(host, { touches: [{ clientX: 95, clientY: 10 }] });
    act(() => void vi.advanceTimersByTime(600));
    fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 95, clientY: 10 }] });

    const cancelledEnd = screen.getByRole("button", { name: "Adjust selection end" });
    fireEvent.pointerDown(cancelledEnd, { pointerId: 8, clientX: 200, clientY: 20 });
    fireEvent.pointerCancel(cancelledEnd, { pointerId: 8, clientX: 0, clientY: 0 });
    expect(screen.queryByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeNull();
    expect(screen.getByRole("button", { name: "Adjust selection end" })).toBeInTheDocument();
    const retainedGuard = container.querySelector(".rc-term-touch-selection__guard")!;
    fireEvent.pointerDown(retainedGuard, { pointerId: 81, clientX: 95, clientY: 10 });
    fireEvent.pointerUp(retainedGuard, { pointerId: 81, clientX: 95, clientY: 10 });
    expect(screen.getByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeInTheDocument();

    const start = screen.getByRole("button", { name: "Adjust selection start" });
    fireEvent.pointerDown(start, { pointerId: 9, clientX: 60, clientY: 20 });
    fireEvent.pointerMove(start, { pointerId: 9, clientX: 5, clientY: 10 });
    fireEvent.pointerUp(start, { pointerId: 9, clientX: 5, clientY: 10 });
    expect(selects.at(-1)).toEqual({ col: 0, row: 0, length: 20 });
    expect(mockSelection).toBe("hello /tmp/error.log");

    const crossedStart = screen.getByRole("button", { name: "Adjust selection start" });
    fireEvent.pointerDown(crossedStart, { pointerId: 10, clientX: 0, clientY: 20 });
    fireEvent.pointerMove(crossedStart, { pointerId: 10, clientX: 255, clientY: 10 });
    expect(container.querySelector('[data-handle-slot="start"]')).toBe(crossedStart);
    expect(crossedStart).toHaveAccessibleName("Adjust selection end");
    expect(crossedStart).toHaveStyle({ left: "260px" });
    fireEvent.pointerUp(crossedStart, { pointerId: 10, clientX: 255, clientY: 10 });
    expect(selects.at(-1)).toEqual({ col: 20, row: 0, length: 6 });
    expect(mockSelection).toBe(" world");

    fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));
    await act(async () => Promise.resolve());
    expect(sent.slice(before)).toEqual(["\x1b[200~clipboard prompt\x1b[201~"]);
    expect(screen.queryByRole("dialog", { name: /type or paste text/i })).toBeNull();
    expect(container.querySelector(".rc-term-touch-selection__guard")).toBeNull();
    expect(mockSelection).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

test("mobile selection disables whitespace-only Copy, reports clipboard failure, and an outside tap clears", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error("denied")) },
  });
  vi.useFakeTimers();
  try {
    mockLines = ["word     another"];
    const { container } = render(<TerminalView session={SESSION} />);
    const host = container.querySelector(".rc-terminal__host")!;

    // Column 6 is whitespace: keep an adjustable one-cell anchor, but never offer to copy meaningless blanks.
    fireEvent.touchStart(host, { touches: [{ clientX: 65, clientY: 10 }] });
    act(() => void vi.advanceTimersByTime(600));
    fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 65, clientY: 10 }] });
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));

    fireEvent.touchStart(host, { touches: [{ clientX: 25, clientY: 10 }] });
    act(() => void vi.advanceTimersByTime(600));
    fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 25, clientY: 10 }] });
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    await act(async () => Promise.resolve());
    expect(screen.getByRole("status")).toHaveTextContent("Copy failed — try again");

    fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));
    await act(async () => Promise.resolve());
    expect(screen.getByRole("status")).toHaveTextContent("Paste failed — allow clipboard access");
    expect(screen.queryByRole("dialog", { name: /type or paste text/i })).toBeNull();

    const guard = container.querySelector(".rc-term-touch-selection__guard")!;
    fireEvent.pointerDown(guard, { pointerId: 12, clientX: 300, clientY: 10 });
    fireEvent.pointerUp(guard, { pointerId: 12, clientX: 300, clientY: 10 });
    expect(container.querySelector(".rc-term-touch-selection__guard")).toBeNull();
    expect(mockSelection).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

test("dragging a mobile handle at the edge auto-scrolls normal scrollback and stops on release", () => {
  vi.useFakeTimers();
  try {
    mockLines = Array.from({ length: 50 }, (_, i) => `line-${i} content`);
    const { container } = render(<TerminalView session={SESSION} />);
    const host = container.querySelector(".rc-terminal__host")!;
    fireEvent.touchStart(host, { touches: [{ clientX: 25, clientY: 10 }] });
    act(() => void vi.advanceTimersByTime(600));
    fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 25, clientY: 10 }] });

    const end = screen.getByRole("button", { name: "Adjust selection end" });
    fireEvent.pointerDown(end, { pointerId: 13, clientX: 60, clientY: 20 });
    fireEvent.pointerMove(end, { pointerId: 13, clientX: 60, clientY: 479 });
    act(() => void vi.advanceTimersByTime(210));
    expect(scrolledLines.length).toBeGreaterThanOrEqual(2);
    expect(scrolledLines.every((amount) => amount === 1)).toBe(true);

    fireEvent.pointerUp(end, { pointerId: 13, clientX: 60, clientY: 479 });
    const stoppedAt = scrolledLines.length;
    act(() => void vi.advanceTimersByTime(210));
    expect(scrolledLines).toHaveLength(stoppedAt);
  } finally {
    vi.useRealTimers();
  }
});
