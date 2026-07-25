import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { createTerminalSocket } from "../ws/terminal-socket";

const ghosttyMock = vi.hoisted(() => ({
  options: undefined as
    | {
        onContextMenu(request: { clientX: number; clientY: number; selection: string }): void;
      }
    | undefined,
}));

vi.mock("@roamcode.ai/ghostty-web", () => ({
  GHOSTTY_UPSTREAM: { commit: "1234567890abcdef" },
  loadGhosttyRuntime: async () => ({}),
  GhosttyCanvasTerminal: class {
    cols = 80;
    rows = 24;

    constructor(
      _runtime: unknown,
      _host: HTMLElement,
      options: {
        onContextMenu(request: { clientX: number; clientY: number; selection: string }): void;
      },
    ) {
      ghosttyMock.options = options;
    }

    setReadOnly() {}
    reset() {}
    fit() {}
    focus() {}
    write() {}
    dispose() {}
    paste() {}
    selectAll() {
      return "all terminal text";
    }
  },
}));

import { GhosttyTerminalView } from "./GhosttyTerminalView";

const SESSION = {
  id: "ghostty-test",
  cwd: "/work/project",
  mode: "terminal" as const,
  status: "running" as const,
  createdAt: 0,
  lastActivityAt: 0,
  dangerouslySkip: false,
};

const createSocket = ((options: { onStatus?: (status: "open") => void }) => {
  queueMicrotask(() => options.onStatus?.("open"));
  return {
    sendInput() {},
    sendResize() {},
    reconnect() {},
    close() {},
  };
}) as unknown as typeof createTerminalSocket;

let originalWidth: PropertyDescriptor | undefined;
let originalHeight: PropertyDescriptor | undefined;

beforeAll(() => {
  originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 500 });
});

afterAll(() => {
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalWidth);
  else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalHeight);
  else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

test("keeps the Ghostty context menu open through the originating pointer release", async () => {
  render(<GhosttyTerminalView session={SESSION} createSocket={createSocket} />);
  await waitFor(() => expect(ghosttyMock.options).toBeDefined());

  act(() => {
    ghosttyMock.options?.onContextMenu({ clientX: 120, clientY: 90, selection: "selected text" });
  });
  const menu = screen.getByRole("menu", { name: "Terminal context menu" });
  expect(menu).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "Copy" })).toBeEnabled();

  fireEvent.pointerDown(menu);
  fireEvent.mouseUp(window, { button: 2 });
  expect(menu).toBeVisible();

  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu", { name: "Terminal context menu" })).not.toBeInTheDocument();
});
