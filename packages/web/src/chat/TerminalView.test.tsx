import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Mock xterm so jsdom doesn't need a real canvas; assert we wire onData→socket and socket→term.write.
const writes: string[] = [];
const dataCbs: ((d: string) => void)[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { applicationCursorKeysMode: false };
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
    attachCustomKeyEventHandler() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} activate() {} dispose() {} } }));

const sent: string[] = [];
vi.mock("../ws/terminal-socket", () => ({
  createTerminalSocket: (opts: { onData: (b: Uint8Array) => void }) => {
    setTimeout(() => opts.onData(new TextEncoder().encode("boot")), 0);
    return { sendInput: (d: string) => sent.push(d), sendResize: () => {}, close: () => {} };
  },
}));

import { TerminalView } from "./TerminalView";

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

const SESSION = {
  id: "s1",
  cwd: "/work/proj",
  mode: "terminal" as const,
  status: "running" as const,
  createdAt: 0,
  lastActivityAt: 0,
  dangerouslySkip: false,
};

test("pipes socket output into the terminal and input back to the socket", async () => {
  render(<TerminalView session={SESSION} />);
  await new Promise((r) => setTimeout(r, 10));
  expect(writes.join("")).toContain("boot");
  dataCbs[0]!("k");
  expect(sent).toContain("k");
});
