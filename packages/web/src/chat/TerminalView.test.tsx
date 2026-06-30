import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";

// Mock xterm so jsdom doesn't need a real canvas; assert we wire onData→socket and socket→term.write.
const writes: string[] = [];
const dataCbs: ((d: string) => void)[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
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

test("pipes socket output into the terminal and input back to the socket", async () => {
  render(<TerminalView sessionId="s1" />);
  await new Promise((r) => setTimeout(r, 10));
  expect(writes.join("")).toContain("boot");
  dataCbs[0]!("k");
  expect(sent).toContain("k");
});
