import type { ITheme } from "@xterm/xterm";
import { terminalTheme } from "../pwa/theme";

/** Convert the retained 16-color appearance catalog into xterm's named ANSI palette. */
export function xtermTheme(): ITheme {
  const theme = terminalTheme();
  const palette = theme.palette;
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorAccent: theme.cursorText,
    selectionBackground: theme.selectionBackground,
    selectionForeground: theme.selectionForeground,
    black: palette[0],
    red: palette[1],
    green: palette[2],
    yellow: palette[3],
    blue: palette[4],
    magenta: palette[5],
    cyan: palette[6],
    white: palette[7],
    brightBlack: palette[8],
    brightRed: palette[9],
    brightGreen: palette[10],
    brightYellow: palette[11],
    brightBlue: palette[12],
    brightMagenta: palette[13],
    brightCyan: palette[14],
    brightWhite: palette[15],
  };
}
