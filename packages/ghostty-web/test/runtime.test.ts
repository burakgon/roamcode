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
