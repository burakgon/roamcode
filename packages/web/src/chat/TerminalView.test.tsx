import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

// Mock xterm so jsdom doesn't need a real canvas; assert we wire onData→socket and socket→term.write.
// `mockLines` feeds buffer.active (the find bar's corpus); `selects`/`scrolledTo` record the find bar's
// select/scroll navigation so tests can assert match positions without a real grid.
const writes: string[] = [];
const dataCbs: ((d: string) => void)[] = [];
let mockLines: string[] = [];
const selects: { col: number; row: number; length: number }[] = [];
const scrolledTo: number[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { applicationCursorKeysMode: false };
    options = { fontSize: 13 };
    buffer = {
      active: {
        type: "normal",
        viewportY: 0,
        baseY: 0,
        get length() {
          return mockLines.length;
        },
        getLine: (i: number) => ({ translateToString: () => mockLines[i] ?? "" }),
      },
      onBufferChange: () => ({ dispose() {} }),
    };
    loadAddon() {}
    open() {}
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
    scrollLines() {}
    scrollToBottom() {}
    scrollToLine(row: number) {
      scrolledTo.push(row);
    }
    select(col: number, row: number, length: number) {
      selects.push({ col, row, length });
    }
    clearSelection() {}
    reset() {}
    blur() {}
    attachCustomKeyEventHandler() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
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
  selects.length = 0;
  scrolledTo.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

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

test("LONG-PRESS on the terminal opens the Select overlay; moving the finger cancels it", async () => {
  vi.useFakeTimers();
  try {
    const { container } = render(<TerminalView session={SESSION} />);
    const host = container.querySelector(".rc-terminal__host")!;
    // Hold still 500ms → the copy/select overlay opens without hunting the key bar's Select button.
    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 80 }] });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.getByRole("dialog", { name: "Select text" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // A finger that MOVES (scrolling / driving the TUI) must never trigger it.
    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 80 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 50, clientY: 140 }] });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.queryByRole("dialog", { name: "Select text" })).toBeNull();
    // Lifting early cancels too.
    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 80 }] });
    fireEvent.touchEnd(host, { touches: [] });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.queryByRole("dialog", { name: "Select text" })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("Codex two-finger scroll opens its native transcript and pages older content", () => {
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

  expect(sent.slice(before)).toEqual(["\x14", "\x1b[5~"]); // Ctrl+T, then PageUp
});

test("Codex mouse wheel uses the same transcript pager and does not reopen it for every notch", () => {
  const before = sent.length;
  const { container } = render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);
  const host = container.querySelector(".rc-terminal__host")!;

  fireEvent.wheel(host, { deltaY: -100, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
  fireEvent.wheel(host, { deltaY: -100, deltaMode: WheelEvent.DOM_DELTA_PIXEL });

  expect(sent.slice(before)).toEqual(["\x14", "\x1b[5~", "\x1b[5~"]);
});

test("Codex mobile Page Up key opens the transcript pager too", () => {
  const before = sent.length;
  render(<TerminalView session={{ ...SESSION, provider: "codex" }} />);

  fireEvent.click(screen.getByRole("button", { name: "Page up" }));

  expect(sent.slice(before)).toEqual(["\x14", "\x1b[5~"]);
});

test("the overlay's one-tap 'Copy selection' appears with a native selection and copies it", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
  });
  const getSel = vi.spyOn(window, "getSelection");
  try {
    render(<TerminalView session={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: "Select / copy text" }));
    // No selection yet → no Copy button (the hint explains it appears on select).
    expect(screen.queryByRole("button", { name: "Copy selection" })).toBeNull();
    // A native selection lands → selectionchange → the coral one-tap Copy shows.
    getSel.mockReturnValue({ toString: () => "hata: ENOENT" } as unknown as Selection);
    fireEvent(document, new Event("selectionchange"));
    const copyBtn = await screen.findByRole("button", { name: "Copy selection" });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(written).toContain("hata: ENOENT"));
  } finally {
    getSel.mockRestore();
  }
});
