import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  GhosttyKey,
  instantiateGhostty,
  KeyAction,
  loadGhosttyRuntime,
  Mods,
  MouseAction,
  MouseButton,
  resetGhosttyRuntimeForTests,
} from "../src/index";

async function runtime() {
  const wasm = await readFile(new URL("../src/ghostty-vt.wasm", import.meta.url));
  return instantiateGhostty(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
}

describe("official Ghostty VT WASM bridge", () => {
  it("parses ANSI state, styling, Unicode and wide cells through the official render API", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal(12, 3, 100);
    terminal.write(new TextEncoder().encode("\u001b[31mred\u001b[0m 世界"));

    const frame = terminal.snapshot();
    expect(frame.cols).toBe(12);
    expect(frame.rows).toBe(3);
    expect(
      frame.cells[0]
        ?.slice(0, 3)
        .map((cell) => cell.text)
        .join(""),
    ).toBe("red");
    expect(frame.cells[0]?.[0]?.foreground).toBe("rgb(204, 102, 102)");
    expect(frame.cells[0]?.some((cell) => cell.text === "世" && cell.width === 2)).toBe(true);
    expect(frame.cells[0]?.some((cell) => cell.width === 0)).toBe(true);
    terminal.dispose();
  });

  it("uses Ghostty's key encoder rather than a browser-side escape-sequence table", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal();
    const ctrlC = terminal.encodeKey({
      action: KeyAction.Press,
      key: GhosttyKey.C,
      mods: Mods.Control,
      utf8: "c",
      unshiftedCodepoint: "c".codePointAt(0),
    });
    const arrow = terminal.encodeKey({
      action: KeyAction.Press,
      key: GhosttyKey.ArrowUp,
      mods: 0,
    });

    expect([...ctrlC]).toEqual([3]);
    expect(new TextDecoder().decode(arrow)).toBe("\u001b[A");
    terminal.dispose();
  });

  it("resizes and resets through the official terminal API", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal(8, 2);
    terminal.write(new TextEncoder().encode("before"));
    terminal.resize(20, 4, 8, 16);
    expect(terminal.snapshot()).toMatchObject({ cols: 20, rows: 4 });
    terminal.reset();
    expect(
      terminal
        .snapshot()
        .cells.flat()
        .every((cell) => cell.text === " "),
    ).toBe(true);
    terminal.dispose();
  });

  it("uses Ghostty's official cursor blink state", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal();
    terminal.setDefaultCursorBlink(true);
    expect(terminal.snapshot().cursor).toMatchObject({ visible: true, blinking: true });
    terminal.write(new TextEncoder().encode("\u001b[2 q"));
    expect(terminal.snapshot().cursor.blinking).toBe(false);
    terminal.dispose();
  });

  it("exposes scrollback, wrapped lines and OSC 8 hyperlinks from Ghostty's grid", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal(8, 2, 10);
    terminal.write(
      new TextEncoder().encode("first\r\n\u001b]8;;https://example.com/docs\u0007linked\u001b]8;;\u0007\r\nthird"),
    );

    const viewport = terminal.viewportSnapshot();
    const buffer = terminal.bufferSnapshot();
    expect(viewport).toMatchObject({ total: 3, offset: 1, length: 2, screen: "normal" });
    expect(buffer.lines.map((line) => line.text)).toEqual(["first", "linked", "third"]);
    expect(buffer.lines[1]?.cells[0]?.hyperlink).toBe("https://example.com/docs");
    expect(buffer.lines[1]?.isWrapped).toBe(false);
    terminal.scrollToTop();
    expect(terminal.viewportSnapshot().offset).toBe(0);
    terminal.scrollToBottom();
    expect(terminal.viewportSnapshot().offset).toBe(1);
    terminal.dispose();
  });

  it("retains long normal-screen history with Ghostty's native byte-sized scrollback default", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal(24, 4);
    const lines = Array.from({ length: 2_500 }, (_, index) => `history ${index}\r\n`).join("");
    terminal.write(new TextEncoder().encode(lines));

    const viewport = terminal.viewportSnapshot();
    expect(viewport.total).toBeGreaterThan(2_400);
    expect(viewport.offset + viewport.length).toBe(viewport.total);
    terminal.scrollToTop();
    expect(terminal.viewportSnapshot().offset).toBe(0);
    terminal.dispose();
  });

  it("keeps programmatic ranges and select-all in Ghostty's selection model", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal(12, 2, 10);
    terminal.write(new TextEncoder().encode("hello world"));

    expect(terminal.selectRange({ col: 0, row: 0 }, { col: 4, row: 0 })).toBe(true);
    expect(terminal.selectionSnapshot()).toMatchObject({
      start: { col: 0, row: 0 },
      end: { col: 4, row: 0 },
      rectangle: false,
      text: "hello",
    });
    expect(terminal.selectAll()).toBe(true);
    expect(terminal.selectionText()).toContain("hello world");
    terminal.dispose();
  });

  it("sets terminal colors through Ghostty rather than repainting parsed ANSI externally", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal(4, 1);
    terminal.setTheme({
      foreground: "#112233",
      background: "#445566",
      cursor: "#778899",
      palette: ["#abcdef"],
    });
    terminal.write(new TextEncoder().encode("\u001b[30mX"));
    const frame = terminal.snapshot();
    expect(frame).toMatchObject({
      foreground: "rgb(17, 34, 51)",
      background: "rgb(68, 85, 102)",
      cursor: { color: "rgb(119, 136, 153)" },
    });
    expect(frame.cells[0]?.[0]?.foreground).toBe("rgb(171, 205, 239)");
    terminal.dispose();
  });

  it("lets terminal modes drive Ghostty's mouse encoder", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal();
    terminal.write(new TextEncoder().encode("\u001b[?1000h\u001b[?1006h"));
    const encoded = terminal.encodeMouse({
      action: MouseAction.Press,
      button: MouseButton.Left,
      mods: 0,
      x: 8,
      y: 16,
      anyButtonPressed: true,
      screenWidth: 640,
      screenHeight: 384,
      cellWidth: 8,
      cellHeight: 16,
    });
    expect(new TextDecoder().decode(encoded)).toBe("\u001b[<0;2;2M");
    terminal.dispose();
  });

  it("lets Ghostty decide whether pasted text needs bracketed-paste framing", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal();
    expect(new TextDecoder().decode(terminal.encodePaste("hello"))).toBe("hello");
    terminal.write(new TextEncoder().encode("\u001b[?2004h"));
    expect(new TextDecoder().decode(terminal.encodePaste("hello"))).toBe("\u001b[200~hello\u001b[201~");
    terminal.dispose();
  });

  it("surfaces application clipboard writes from mouse-aware alternate-screen terminals", async () => {
    const ghostty = await runtime();
    const clipboardWrites: string[] = [];
    const terminal = ghostty.createTerminal(80, 24, 1000, {
      onClipboardWrite: (text) => clipboardWrites.push(text),
    });

    terminal.write(
      new TextEncoder().encode("\u001b[?1049h\u001b[?1003h\u001b]52;c;SGVsbG8gZnJvbSBIZXJkciDwn5GL\u0007"),
    );

    expect(clipboardWrites).toEqual(["Hello from Herdr 👋"]);
    terminal.dispose();
  });

  it("routes application clipboard writes only to their owning terminal", async () => {
    const ghostty = await runtime();
    const firstWrites: string[] = [];
    const secondWrites: string[] = [];
    const first = ghostty.createTerminal(80, 24, 1000, {
      onClipboardWrite: (text) => firstWrites.push(text),
    });
    const second = ghostty.createTerminal(80, 24, 1000, {
      onClipboardWrite: (text) => secondWrites.push(text),
    });

    first.write(new TextEncoder().encode("\u001b]52;c;Zmlyc3Q=\u001b\\"));
    second.write(new TextEncoder().encode("\u001b]52;c;c2Vjb25k\u0007"));

    expect(firstWrites).toEqual(["first"]);
    expect(secondWrites).toEqual(["second"]);
    first.dispose();
    second.dispose();
  });

  it("keeps drag and right-click word selections in Ghostty's terminal-owned selection state", async () => {
    const ghostty = await runtime();
    const terminal = ghostty.createTerminal(20, 3, 100);
    terminal.write(new TextEncoder().encode("hello world"));
    const point = (column: number, timeMs?: number) => ({
      column,
      row: 0,
      x: column * 8 + 4,
      y: 8,
      cellWidth: 8,
      paddingLeft: 0,
      screenHeight: 48,
      timeMs,
    });

    expect(terminal.beginSelection(point(1, 1))).toBe(true);
    expect(terminal.updateSelection(point(4))).toBe(true);
    terminal.endSelection(point(4));
    expect(terminal.selectionText()).toBe("ell");
    expect(
      terminal
        .snapshot()
        .cells[0]?.slice(1, 4)
        .every((cell) => cell.selected),
    ).toBe(true);

    terminal.write(new TextEncoder().encode("\r\nnext"));
    expect(terminal.selectionText()).toBe("ell");

    terminal.clearSelection();
    expect(terminal.selectWordAt(point(7))).toBe(true);
    expect(terminal.selectionText()).toBe("world");
    terminal.dispose();
  });

  it("clears a failed lazy load so the explicit Retry action can fetch again", async () => {
    const wasm = await readFile(new URL("../src/ghostty-vt.wasm", import.meta.url));
    const bytes = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => bytes });
    vi.stubGlobal("fetch", fetchMock);
    resetGhosttyRuntimeForTests();
    try {
      await expect(loadGhosttyRuntime("/ghostty.wasm")).rejects.toThrow("offline");
      await expect(loadGhosttyRuntime("/ghostty.wasm")).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      resetGhosttyRuntimeForTests();
      vi.unstubAllGlobals();
    }
  });
});
