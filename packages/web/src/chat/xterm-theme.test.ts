import { beforeEach, expect, test } from "vitest";
import { ROAMCODE_THEME, setTheme } from "../pwa/theme";
import { xtermTheme } from "./xterm-theme";

beforeEach(() => {
  localStorage.clear();
  setTheme(ROAMCODE_THEME);
});

test("maps all sixteen retained palette colors to xterm's named ANSI theme", () => {
  expect(xtermTheme()).toMatchObject({
    background: ROAMCODE_THEME.background,
    foreground: ROAMCODE_THEME.foreground,
    cursor: ROAMCODE_THEME.cursor,
    cursorAccent: ROAMCODE_THEME.cursorText,
    black: ROAMCODE_THEME.palette[0],
    red: ROAMCODE_THEME.palette[1],
    green: ROAMCODE_THEME.palette[2],
    yellow: ROAMCODE_THEME.palette[3],
    blue: ROAMCODE_THEME.palette[4],
    magenta: ROAMCODE_THEME.palette[5],
    cyan: ROAMCODE_THEME.palette[6],
    white: ROAMCODE_THEME.palette[7],
    brightBlack: ROAMCODE_THEME.palette[8],
    brightRed: ROAMCODE_THEME.palette[9],
    brightGreen: ROAMCODE_THEME.palette[10],
    brightYellow: ROAMCODE_THEME.palette[11],
    brightBlue: ROAMCODE_THEME.palette[12],
    brightMagenta: ROAMCODE_THEME.palette[13],
    brightCyan: ROAMCODE_THEME.palette[14],
    brightWhite: ROAMCODE_THEME.palette[15],
  });
});
