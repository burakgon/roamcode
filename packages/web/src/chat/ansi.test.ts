import { describe, expect, it } from "vitest";
import { hasAnsi, parseAnsi, stripAnsi } from "./ansi";

// Build escape sequences from char codes so the test source carries no raw control characters.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe("stripAnsi", () => {
  it("removes SGR color codes, keeping the visible text", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi(`a${ESC}[1;32mb${ESC}[0mc`)).toBe("abc");
  });

  it("leaves plain text (and newlines/tabs) untouched", () => {
    expect(stripAnsi("line1\nline2\tcol")).toBe("line1\nline2\tcol");
    expect(stripAnsi("no codes here")).toBe("no codes here");
  });

  it("removes an OSC (window-title) sequence terminated by BEL", () => {
    expect(stripAnsi(`${ESC}]0;my title${BEL}visible`)).toBe("visible");
  });

  it("strips a realistic colorized lint line", () => {
    const line = `${ESC}[2K${ESC}[1m${ESC}[31merror${ESC}[39m${ESC}[22m  Missing semicolon`;
    expect(stripAnsi(line)).toBe("error  Missing semicolon");
  });

  it("hasAnsi detects presence without mutating", () => {
    expect(hasAnsi(`${ESC}[31mx`)).toBe(true);
    expect(hasAnsi("plain")).toBe(false);
    // Stateful global regex must not get stuck across calls.
    expect(hasAnsi(`${ESC}[31mx`)).toBe(true);
  });
});

describe("parseAnsi", () => {
  it("returns one default-styled run for plain text", () => {
    expect(parseAnsi("hello world")).toEqual([{ text: "hello world", style: {} }]);
  });

  it("splits a colored run from surrounding text and resets on SGR 0", () => {
    expect(parseAnsi(`a${ESC}[31mred${ESC}[0mb`)).toEqual([
      { text: "a", style: {} },
      { text: "red", style: { color: "#e06c75" } },
      { text: "b", style: {} },
    ]);
  });

  it("accumulates bold + color and clears bold with 22 (color persists)", () => {
    expect(parseAnsi(`${ESC}[1;32mA${ESC}[22mB`)).toEqual([
      { text: "A", style: { bold: true, color: "#98c379" } },
      { text: "B", style: { color: "#98c379" } },
    ]);
  });

  it("parses bright fg (90-97) and background (40-47)", () => {
    expect(parseAnsi(`${ESC}[91mx`)[0]).toEqual({ text: "x", style: { color: "#ef9aa0" } });
    expect(parseAnsi(`${ESC}[42my`)[0]).toEqual({ text: "y", style: { background: "#98c379" } });
  });

  it("parses 256-color and truecolor", () => {
    expect(parseAnsi(`${ESC}[38;5;196mX`)[0]!.style.color).toBe("rgb(255, 0, 0)");
    expect(parseAnsi(`${ESC}[38;2;10;20;30mY`)[0]!.style.color).toBe("rgb(10, 20, 30)");
  });

  it("drops non-SGR control sequences (erase line / OSC) but keeps the text + styling", () => {
    // ESC[2K (erase line) and an OSC title are consumed; the colored "error" still renders.
    const line = `${ESC}[2K${ESC}[1m${ESC}[31merror${ESC}[0m ok`;
    expect(parseAnsi(line)).toEqual([
      { text: "error", style: { bold: true, color: "#e06c75" } },
      { text: " ok", style: {} },
    ]);
  });

  it("handles a bare reset (ESC[m) and underline", () => {
    expect(parseAnsi(`${ESC}[4mU${ESC}[mP`)).toEqual([
      { text: "U", style: { underline: true } },
      { text: "P", style: {} },
    ]);
  });

  it("empty input yields no runs", () => {
    expect(parseAnsi("")).toEqual([]);
  });
});
