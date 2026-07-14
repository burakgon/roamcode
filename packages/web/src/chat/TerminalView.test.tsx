import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

// Mock xterm so jsdom doesn't need a real canvas; assert we wire onData→socket and socket→term.write.
// `mockLines` feeds buffer.active (the find bar's corpus); `selects`/`scrolledTo` record the find bar's
// select/scroll navigation so tests can assert match positions without a real grid.
const writes: string[] = [];
const dataCbs: ((d: string) => void)[] = [];
let mockLines: string[] = [];
const mockWrappedRows = new Set<number>();
let mockSelection = "";
let mockSelectionRange: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
let mockMouseTrackingMode: "none" | "drag" | "any" = "none";
let lastTerminalOptions: Record<string, unknown> = {};
let customKeyHandler: ((event: KeyboardEvent) => boolean) | undefined;
const selects: { col: number; row: number; length: number }[] = [];
const scrolledTo: number[] = [];
const scrolledLines: number[] = [];
const terminalMouseEvents: { type: string; altKey: boolean; shiftKey: boolean; detail: number }[] = [];
const selectionCbs: (() => void)[] = [];
type MockLink = { uri: string; start: { col: number; row: number }; end: { col: number; row: number } };
let mockLinks: MockLink[] = [];
let mockWebLinkHandler: ((event: MouseEvent, uri: string) => void) | undefined;

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
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
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
    private recordMouse = (event: MouseEvent) => {
      terminalMouseEvents.push({
        type: event.type,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        detail: event.detail,
      });
    };
    private hoveredLink?: MockLink;
    private mouseDownLink?: MockLink;
    private updateLink = (event: MouseEvent) => {
      this.hoveredLink = mockLinkAt(event.clientX, event.clientY);
    };
    private linkMouseDown = () => {
      this.mouseDownLink = this.hoveredLink;
    };
    private linkMouseUp = (event: MouseEvent) => {
      const link = this.hoveredLink ?? mockLinkAt(event.clientX, event.clientY);
      if (link && this.mouseDownLink === link) mockWebLinkHandler?.(event, link.uri);
      this.mouseDownLink = undefined;
    };
    constructor(options: Record<string, unknown> = {}) {
      this.options = { fontSize: 13, ...options };
      lastTerminalOptions = this.options;
    }
    buffer = {
      active: {
        type: "normal",
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
      screen.className = "xterm-screen";
      const textarea = document.createElement("textarea");
      textarea.className = "xterm-helper-textarea";
      screen.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 800, bottom: 480, width: 800, height: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
      host.appendChild(screen);
      host.appendChild(textarea);
      this.host = host;
      this.textarea = textarea;
      screen.addEventListener("mousemove", this.updateLink);
      screen.addEventListener("mousedown", this.linkMouseDown);
      screen.addEventListener("mouseup", this.linkMouseUp);
      host.addEventListener("mousedown", this.recordMouse);
      host.addEventListener("mousemove", this.recordMouse);
      host.addEventListener("mouseup", this.recordMouse);
    }
    write(d: string) {
      writes.push(typeof d === "string" ? d : new TextDecoder().decode(d));
    }
    onData(cb: (d: string) => void) {
      dataCbs.push(cb);
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
      const screen = this.host?.querySelector<HTMLElement>(".xterm-screen");
      screen?.removeEventListener("mousemove", this.updateLink);
      screen?.removeEventListener("mousedown", this.linkMouseDown);
      screen?.removeEventListener("mouseup", this.linkMouseUp);
      this.host?.removeEventListener("mousedown", this.recordMouse);
      this.host?.removeEventListener("mousemove", this.recordMouse);
      this.host?.removeEventListener("mouseup", this.recordMouse);
      this.textarea?.remove();
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    activate() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, uri: string) => void) {
      mockWebLinkHandler = handler;
    }
    activate() {}
    dispose() {}
  },
}));

const sent: string[] = [];
vi.mock("../ws/terminal-socket", () => ({
  createTerminalSocket: (opts: { onData: (b: Uint8Array) => void }) => {
    setTimeout(() => opts.onData(new TextEncoder().encode("boot")), 0);
    return { sendInput: (d: string) => sent.push(d), sendResize: () => {}, reconnect: () => {}, close: () => {} };
  },
}));

import { TerminalView } from "./TerminalView";
import type { createTerminalSocket, TerminalStatus } from "../ws/terminal-socket";

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
  lastTerminalOptions = {};
  customKeyHandler = undefined;
  selects.length = 0;
  scrolledTo.length = 0;
  scrolledLines.length = 0;
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

test("pipes socket output into the terminal and input back to the socket", async () => {
  render(<TerminalView session={SESSION} />);
  await new Promise((r) => setTimeout(r, 10));
  expect(writes.join("")).toContain("boot");
  dataCbs[0]!("k");
  expect(sent).toContain("k");
});

test("Ctrl and Alt lock independently, combine on special keys, and stay locked after use", () => {
  const before = sent.length;
  render(<TerminalView session={SESSION} />);
  const ctrl = screen.getByRole("button", { name: "Control (sticky)" });
  const alt = screen.getByRole("button", { name: "Alt (sticky)" });

  fireEvent.pointerDown(ctrl, { pointerId: 31 });
  fireEvent.pointerDown(alt, { pointerId: 32 });
  expect(ctrl).toHaveAttribute("aria-pressed", "true");
  expect(alt).toHaveAttribute("aria-pressed", "true");

  const backspace = new KeyboardEvent("keydown", { key: "Backspace", cancelable: true });
  expect(customKeyHandler?.(backspace)).toBe(false);
  expect(sent.slice(before)).toEqual(["\x1b\x08"]); // Ctrl+Alt+Backspace
  expect(backspace.defaultPrevented).toBe(true);
  expect(ctrl).toHaveAttribute("aria-pressed", "true");
  expect(alt).toHaveAttribute("aria-pressed", "true");

  const letter = new KeyboardEvent("keydown", { key: "b", cancelable: true });
  expect(customKeyHandler?.(letter)).toBe(false);
  expect(sent.slice(before)).toEqual(["\x1b\x08", "\x1b\x02"]);
  expect(ctrl).toHaveAttribute("aria-pressed", "true");
  expect(alt).toHaveAttribute("aria-pressed", "true");

  // Each lock has its own explicit off switch; turning Alt off leaves Ctrl in place.
  fireEvent.pointerDown(alt, { pointerId: 33 });
  expect(ctrl).toHaveAttribute("aria-pressed", "true");
  expect(alt).toHaveAttribute("aria-pressed", "false");
  dataCbs.at(-1)!("\x7f");
  dataCbs.at(-1)!("multi-character paste");
  expect(sent.slice(before)).toEqual(["\x1b\x08", "\x1b\x02", "\x08", "multi-character paste"]);
  expect(ctrl).toHaveAttribute("aria-pressed", "true");
});

test("mobile concrete Backspace owns a deterministic hold repeat and stops on keyup", () => {
  vi.stubGlobal("matchMedia", vi.fn(coarsePointerMedia));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const before = sent.length;
    const { container } = render(<TerminalView session={SESSION} />);
    const helper = container.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea")!;
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

test("Gboard beforeinput deletion falls back once, but dedupes xterm's authoritative DEL", () => {
  vi.stubGlobal("matchMedia", vi.fn(coarsePointerMedia));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const before = sent.length;
    const { container } = render(<TerminalView session={SESSION} />);
    const helper = container.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea")!;
    const deleteEvent = () =>
      new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true });

    fireEvent(helper, deleteEvent());
    act(() => void vi.advanceTimersByTime(0));
    expect(sent.slice(before)).toEqual(["\x7f"]);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Alt (sticky)" }), { pointerId: 34 });
    fireEvent(helper, deleteEvent());
    // xterm emits DEL for this token before its fallback fires → exactly one modified delete.
    act(() => dataCbs.at(-1)!("\x7f"));
    act(() => void vi.advanceTimersByTime(0));
    expect(sent.slice(before)).toEqual(["\x7f", "\x1b\x7f"]);
    expect(screen.getByRole("button", { name: "Alt (sticky)" })).toHaveAttribute("aria-pressed", "true");
  } finally {
    vi.useRealTimers();
  }
});

test("mobile non-text controls preserve a closed or already-open keyboard instead of changing it", () => {
  vi.stubGlobal("matchMedia", vi.fn(coarsePointerMedia));
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const helper = container.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea")!;
  helper.blur();
  expect(document.activeElement).not.toBe(helper);

  for (const name of ["Page up", "Page down", "Control (sticky)", "Alt (sticky)", "Smaller text"] as const) {
    const button = screen.getByRole("button", { name });
    fireEvent.pointerDown(button, { pointerId: 40 });
    fireEvent.mouseDown(button);
    expect(document.activeElement, `${name} should not open the keyboard`).not.toBe(helper);
  }

  helper.focus();
  const pageUp = screen.getByRole("button", { name: "Page up" });
  fireEvent.pointerDown(pageUp, { pointerId: 41 });
  fireEvent.mouseDown(pageUp);
  expect(document.activeElement).toBe(helper);
});

test("ended overlay: a legacy session without provider remains resumable as Claude", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline"))); // ticket fetch fails → legacy URL
  try {
    const h = socketHarness();
    render(<TerminalView session={SESSION} createSocket={h.createSocket} />);
    await waitFor(() => expect(h.urls).toHaveLength(1));
    expect(h.urls[0]).not.toContain("respawn=");
    act(() => h.statusCbs[0]!("ended"));
    const resume = screen.getByRole("button", { name: "Resume conversation" });
    expect(resume).toBeEnabled();
    expect(screen.getByText("Claude Code exited")).toBeInTheDocument();
    fireEvent.click(resume);
    // The restart remounted the effect → a NEW socket whose (thunked) URL carries the respawn choice.
    await waitFor(() => expect(h.urls).toHaveLength(2));
    expect(h.urls[1]).toContain("respawn=continue");
    // Once the resumed connection OPENS, the choice is consumed — see the respawnRef clear-on-open.
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
    render(<TerminalView session={SESSION} createSocket={h.createSocket} />);
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

test("a QUICK legacy Claude exit uses Claude-native title and authentication hint", () => {
  const h = socketHarness();
  render(<TerminalView session={SESSION} createSocket={h.createSocket} />);
  // "ended" lands right away (well inside the 10s boot window) → the sign-out hint shows.
  act(() => h.statusCbs[0]!("ended"));
  expect(screen.getByText("Claude Code exited")).toBeInTheDocument();
  expect(screen.getByText(/Claude Code may be signed out on the host/i)).toHaveTextContent(
    /run claude.*Settings → Claude Code account/i,
  );
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
  expect(screen.getByRole("button", { name: "Resume conversation" })).toBeInTheDocument();
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

test("enables xterm's macOS mouse-mode selection override", () => {
  render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  expect(lastTerminalOptions.macOptionClickForcesSelection).toBe(true);
  expect(lastTerminalOptions.theme).toMatchObject({ selectionInactiveBackground: "#25252b" });
});

test("plain desktop click still reaches a mouse-tracking terminal after small pointer movement", () => {
  mockMouseTrackingMode = "drag";
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;

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
  const terminalScreen = container.querySelector(".xterm-screen")!;

  fireEvent.mouseMove(terminalScreen, { buttons: 0, clientX: 45, clientY: 10 });
  terminalMouseEvents.length = 0;
  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 45, clientY: 10, detail: 1 });
  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 45, clientY: 10, detail: 1 });

  expect(open).toHaveBeenCalledOnce();
  expect(popup.opener).toBeNull();
  expect(popup.location.href).toBe("https://example.com/docs");
  expect(terminalMouseEvents).toEqual([]);
});

test("desktop opens a URL from either visual row when xterm reports one wrapped link", () => {
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
  const terminalScreen = container.querySelector(".xterm-screen")!;

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
  const terminalScreen = container.querySelector(".xterm-screen")!;

  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 45, clientY: 10, detail: 1 });
  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 45, clientY: 10, detail: 1 });

  expect(open).toHaveBeenCalledOnce();
  expect(popup.location.href).toBe("https://example.com/fresh");
});

test("dragging across a desktop link selects instead of opening it", () => {
  mockLinks = [{ uri: "https://example.com/docs", start: { col: 2, row: 0 }, end: { col: 26, row: 0 } }];
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;

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
  const terminalScreen = container.querySelector(".xterm-screen")!;

  fireEvent.mouseMove(terminalScreen, { buttons: 0, clientX: 45, clientY: 10 });
  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 45, clientY: 10, detail: 2 });
  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 45, clientY: 10, detail: 2 });

  expect(open).not.toHaveBeenCalled();
});

test("plain desktop drag becomes xterm selection without exposing Option or Shift to the user", () => {
  mockMouseTrackingMode = "drag";
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;

  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 1 });
  fireEvent.mouseMove(terminalScreen, { button: 0, buttons: 1, clientX: 80, clientY: 20 });

  const downs = terminalMouseEvents.filter((event) => event.type === "mousedown");
  expect(downs).toHaveLength(1);
  expect(downs[0]).toMatchObject({ type: "mousedown", detail: 1 });
  expect(downs[0]!.altKey || downs[0]!.shiftKey).toBe(true);

  fireEvent.mouseUp(terminalScreen, { button: 0, buttons: 0, clientX: 80, clientY: 20, detail: 1 });
  expect(terminalMouseEvents.at(-1)?.type).toBe("mouseup");
});

test("double-click forces native xterm word selection while mouse tracking is active", () => {
  mockMouseTrackingMode = "drag";
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;

  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 2 });

  expect(terminalMouseEvents).toHaveLength(1);
  expect(terminalMouseEvents[0]).toMatchObject({ type: "mousedown", detail: 2 });
  expect(terminalMouseEvents[0]!.altKey || terminalMouseEvents[0]!.shiftKey).toBe(true);
});

test("mouse-tracking arbitration leaves xterm's normal no-mouse selection path untouched", () => {
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "claude" }} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;

  fireEvent.mouseDown(terminalScreen, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 1 });

  expect(terminalMouseEvents).toEqual([{ type: "mousedown", altKey: false, shiftKey: false, detail: 1 }]);
});

test("buttonless Claude hover cannot clear a finished selection", () => {
  mockMouseTrackingMode = "any";
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "claude" }} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;
  mockSelection = "keep this selected";
  mockSelectionRange = { start: { x: 0, y: 0 }, end: { x: 18, y: 0 } };

  fireEvent.mouseMove(terminalScreen, { button: 0, buttons: 0, clientX: 90, clientY: 20 });

  expect(terminalMouseEvents).toEqual([]);
  expect(mockSelection).toBe("keep this selected");
});

test("Claude hover continues reaching xterm when no selection exists", () => {
  mockMouseTrackingMode = "any";
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "claude" }} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;

  fireEvent.mouseMove(terminalScreen, { button: 0, buttons: 0, clientX: 90, clientY: 20 });

  expect(terminalMouseEvents).toEqual([{ type: "mousemove", altKey: false, shiftKey: false, detail: 0 }]);
});

test("secondary-click selects the terminal word and copies it only after the explicit Copy action", async () => {
  mockLines = ["hello /tmp/error.log world"];
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
  });
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;

  // Cell width is 10px in the mock screen. Right-click the middle of `/tmp/error.log`.
  fireEvent.mouseDown(terminalScreen, { button: 2, clientX: 95, clientY: 10 });
  fireEvent.contextMenu(terminalScreen, { button: 2, clientX: 95, clientY: 10 });

  expect(screen.getByRole("menu", { name: "Terminal clipboard menu" })).toBeInTheDocument();
  expect(mockSelection).toBe("/tmp/error.log");
  expect(selects.at(-1)).toEqual({ col: 6, row: 0, length: 14 });
  expect(written).toEqual([]); // selection alone never mutates the clipboard

  fireEvent.click(screen.getByRole("menuitem", { name: /copy/i }));
  await waitFor(() => expect(written).toEqual(["/tmp/error.log"]));
  expect(screen.queryByRole("menu", { name: "Terminal clipboard menu" })).toBeNull();
  expect(mockSelection).toBe("/tmp/error.log"); // explicit copy keeps the selection visible
});

test("secondary-click preserves an existing selection and Paste sends the clipboard directly", async () => {
  mockLines = ["selected text stays"];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: () => Promise.resolve("first line\nsecond line") },
  });
  const before = sent.length;
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;
  mockSelection = "selected text";
  mockSelectionRange = { start: { x: 0, y: 0 }, end: { x: 13, y: 0 } };
  const selectsBefore = selects.length;

  // Deliberately click outside the selected range: an imprecise context-click must not replace it.
  fireEvent.mouseDown(terminalScreen, { button: 2, clientX: 185, clientY: 10 });
  fireEvent.mouseUp(terminalScreen, { button: 2, clientX: 185, clientY: 10 }); // browser-order fallback path

  expect(screen.getByRole("menuitem", { name: /copy/i })).toBeEnabled();
  expect(selects).toHaveLength(selectsBefore);
  expect(mockSelection).toBe("selected text");
  fireEvent.click(screen.getByRole("menuitem", { name: /paste/i }));
  await waitFor(() => expect(sent.slice(before)).toEqual(["\x1b[200~first line\nsecond line\x1b[201~"]));
  expect(screen.queryByRole("dialog", { name: /type or paste text/i })).toBeNull();
  expect(screen.queryByRole("menu", { name: "Terminal clipboard menu" })).toBeNull();
});

test("the two-row text-input key still opens manual compose and Send uses bracketed paste", () => {
  const before = sent.length;
  render(<TerminalView session={SESSION} />);

  fireEvent.pointerDown(screen.getByRole("button", { name: "Open text input" }), { pointerId: 21 });
  const input = screen.getByPlaceholderText("Type or paste text, then Send…");
  fireEvent.change(input, { target: { value: "typed prompt\nwith detail" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  expect(sent.slice(before)).toEqual(["\x1b[200~typed prompt\nwith detail\x1b[201~"]);
  expect(screen.queryByRole("dialog", { name: /type or paste text/i })).toBeNull();
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

test("secondary-click on whitespace leaves Copy disabled and Escape returns to the terminal", () => {
  mockLines = ["hello"];
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;

  fireEvent.mouseDown(terminalScreen, { button: 2, clientX: 255, clientY: 10 });
  fireEvent.contextMenu(terminalScreen, { button: 2, clientX: 255, clientY: 10 });

  const menu = screen.getByRole("menu", { name: "Terminal clipboard menu" });
  expect(screen.getByRole("menuitem", { name: /copy/i })).toBeDisabled();
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "Terminal clipboard menu" })).toBeNull();
});

test("secondary-click word selection follows xterm wrapped rows", () => {
  mockLines = [`${" ".repeat(78)}ab`, "cd rest"];
  mockWrappedRows.add(1);
  const { container } = render(<TerminalView session={SESSION} />);
  const terminalScreen = container.querySelector(".xterm-screen")!;

  fireEvent.mouseDown(terminalScreen, { button: 2, clientX: 15, clientY: 30 });
  fireEvent.contextMenu(terminalScreen, { button: 2, clientX: 15, clientY: 30 });

  expect(mockSelection).toBe("abcd");
  expect(selects.at(-1)).toEqual({ col: 78, row: 0, length: 4 });
});

test("Cmd/Ctrl+C copies an xterm selection, while Ctrl+C without a selection remains terminal input", async () => {
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

test("LONG-PRESS selects a word on the live terminal; movement or an early lift cancels it", () => {
  vi.useFakeTimers();
  try {
    mockLines = ["hello /tmp/error.log world"];
    const { container } = render(<TerminalView session={SESSION} />);
    const host = container.querySelector(".rc-terminal__host")!;
    // Hold still 500ms over the path → xterm keeps the REAL range and mobile handles/actions appear inline.
    fireEvent.touchStart(host, { touches: [{ clientX: 95, clientY: 10 }] });
    act(() => void vi.advanceTimersByTime(600));
    expect(mockSelection).toBe("/tmp/error.log");
    expect(screen.getByRole("menu", { name: "Mobile terminal clipboard menu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adjust selection start" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adjust selection end" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Select text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select / copy text" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
    expect(mockSelection).toBe("");
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
    mockLinks = [{ uri: "https://example.com/mobile", start: { col: 2, row: 0 }, end: { col: 28, row: 0 } }];
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = render(<TerminalView session={SESSION} />);
    const host = container.querySelector(".rc-terminal__host")!;

    fireEvent.touchStart(host, { touches: [{ clientX: 45, clientY: 10 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 145, clientY: 10 }] });
    fireEvent.touchEnd(host, { touches: [], changedTouches: [{ clientX: 145, clientY: 10 }] });
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

test("Codex two-finger scroll sends an in-place tmux history gesture", () => {
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
      { clientX: 40, clientY: 150 },
      { clientX: 90, clientY: 150 },
    ],
  });

  expect(sent.slice(before)).toEqual(["\x1b[<64;1;1M"]); // SGR wheel-up; never opens Codex Transcript
});

test("Codex mobile Page Up scrolls tmux history without opening Transcript", () => {
  const before = sent.length;
  render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);

  fireEvent.click(screen.getByRole("button", { name: "Page up" }));

  expect(sent.slice(before)).toEqual(["\x1b[<64;1;1M".repeat(4)]);
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

test("mobile handles resize and cross the live xterm range, while Paste sends the clipboard directly", async () => {
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

    const start = screen.getByRole("button", { name: "Adjust selection start" });
    fireEvent.pointerDown(start, { pointerId: 9, clientX: 60, clientY: 20 });
    fireEvent.pointerMove(start, { pointerId: 9, clientX: 5, clientY: 10 });
    fireEvent.pointerUp(start, { pointerId: 9, clientX: 5, clientY: 10 });
    expect(selects.at(-1)).toEqual({ col: 0, row: 0, length: 20 });
    expect(mockSelection).toBe("hello /tmp/error.log");

    const crossedStart = screen.getByRole("button", { name: "Adjust selection start" });
    fireEvent.pointerDown(crossedStart, { pointerId: 10, clientX: 0, clientY: 20 });
    fireEvent.pointerMove(crossedStart, { pointerId: 10, clientX: 255, clientY: 10 });
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
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));

    fireEvent.touchStart(host, { touches: [{ clientX: 25, clientY: 10 }] });
    act(() => void vi.advanceTimersByTime(600));
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
