/**
 * Strip ANSI escape sequences (color/cursor/title codes) that terminal tools emit. Rendered literally in
 * a <pre>, a sequence like ESC[31m shows as garbage (`[31m`); many CLIs (eslint, jest, ripgrep, git)
 * colorize by default, so a Bash tool result is full of them. We strip the codes for display while leaving
 * the actual text, newlines and tabs intact. The raw bytes are still preserved in the result's `raw` panel.
 *
 * The pattern (from the well-known `ansi-regex` package: CSI + OSC + common single-char escapes) is built
 * with `String.fromCharCode` so the control bytes live in a runtime string, never as control characters in
 * the source — the regex literal stays clean and no-control-regex has nothing to flag.
 */
const ESC = String.fromCharCode(0x1b); // ESC — start of a 7-bit escape sequence
const CSI8 = String.fromCharCode(0x9b); // 8-bit CSI
const BEL = String.fromCharCode(0x07); // BEL — terminates an OSC sequence
// Two alternatives, OSC first: (1) an OSC string (ESC ] … BEL) such as a window-title set — its payload
// can contain spaces, so match everything up to the terminating BEL; (2) a CSI / single-char escape
// (color, cursor, erase) — an optional intermediate, optional numeric params, then a final byte.
const ANSI_RE = new RegExp(
  `${ESC}\\][^${BEL}]*${BEL}` + `|[${ESC}${CSI8}][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]`,
  "g",
);

/** True when `s` contains at least one ANSI escape sequence (so callers can skip work when there's none). */
export function hasAnsi(s: string): boolean {
  ANSI_RE.lastIndex = 0;
  return ANSI_RE.test(s);
}

/** Remove every ANSI escape sequence from `s`, leaving the visible text (and newlines/tabs) untouched. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// ---------------------------------------------------------------------------
// ANSI → styled spans (so colorized tool output RENDERS in color, like the terminal, instead of being
// flattened to plain text). We parse SGR (Select Graphic Rendition) sequences into a style and emit a run
// of text per style change; every OTHER escape (cursor moves, erase, OSC titles) is consumed and dropped.
// ---------------------------------------------------------------------------

/** The visual style accumulated from SGR codes for a run of text. All fields optional/defaulting to off. */
export interface AnsiStyle {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Swap foreground/background (SGR 7) — applied at render time. */
  inverse?: boolean;
}

/** A run of text sharing one style. */
export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

// A dark-theme-friendly 16-color palette (One Dark-ish) that reads well on the code panel (#0e0e10).
// Index 0–7 = standard (black,red,green,yellow,blue,magenta,cyan,white); 8–15 = bright variants.
const PALETTE = [
  "#5c6370",
  "#e06c75",
  "#98c379",
  "#d19a66",
  "#61afef",
  "#c678dd",
  "#56b6c2",
  "#abb2bf",
  "#7f848e",
  "#ef9aa0",
  "#b5e0a0",
  "#e5c07b",
  "#8fc3ff",
  "#d7a3e6",
  "#80cfda",
  "#e6e6ec",
];

/** Resolve an xterm-256 color index to a CSS color (0–15 palette, 16–231 6×6×6 cube, 232–255 grayscale). */
function xterm256(n: number): string {
  if (n < 16) return PALETTE[n] ?? "#abb2bf";
  if (n < 232) {
    const i = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(i / 36))}, ${level(Math.floor((i % 36) / 6))}, ${level(i % 6)})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v}, ${v}, ${v})`;
}

/** Fold one SGR parameter list (e.g. "1;38;5;196") into the running style. Returns a NEW style object. */
function applySgr(prev: AnsiStyle, paramStr: string): AnsiStyle {
  const codes = (paramStr === "" ? "0" : paramStr).split(";").map((p) => (p === "" ? 0 : parseInt(p, 10)));
  let s: AnsiStyle = { ...prev };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 7) s.inverse = true;
    else if (c === 9) s.strike = true;
    else if (c === 22) {
      delete s.bold;
      delete s.dim;
    } else if (c === 23) delete s.italic;
    else if (c === 24) delete s.underline;
    else if (c === 27) delete s.inverse;
    else if (c === 29) delete s.strike;
    else if (c >= 30 && c <= 37) s.color = PALETTE[c - 30];
    else if (c === 39) delete s.color;
    else if (c >= 40 && c <= 47) s.background = PALETTE[c - 40];
    else if (c === 49) delete s.background;
    else if (c >= 90 && c <= 97) s.color = PALETTE[c - 90 + 8];
    else if (c >= 100 && c <= 107) s.background = PALETTE[c - 100 + 8];
    else if (c === 38 || c === 48) {
      // Extended color: `38;5;<n>` (256-color) or `38;2;<r>;<g>;<b>` (truecolor). Consume the extra args.
      const mode = codes[i + 1];
      let col: string | undefined;
      if (mode === 5 && codes[i + 2] !== undefined) {
        col = xterm256(codes[i + 2]!);
        i += 2;
      } else if (mode === 2) {
        col = `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})`;
        i += 4;
      }
      if (col) {
        if (c === 38) s.color = col;
        else s.background = col;
      }
    }
    // any other SGR code (e.g. 5 blink, 8 hidden) is ignored — its run still renders with the prior style.
  }
  return s;
}

// SGR first (captures its params); then any other CSI sequence (cursor/erase — dropped); then an OSC string.
function sequenceRe(): RegExp {
  return new RegExp(`${ESC}\\[([0-9;]*)m|${ESC}\\[[0-9;?]*[@-~]|${ESC}\\][^${BEL}]*${BEL}`, "g");
}

/**
 * Parse `input` into styled runs: SGR color/style codes become the run's {@link AnsiStyle}, all other
 * escape sequences are dropped. Adjacent text with the same active style is emitted as separate runs at
 * each code boundary (fine for rendering). Plain text with no codes yields a single default-styled run.
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const re = sequenceRe();
  const push = (text: string) => {
    if (text.length > 0) spans.push({ text, style: { ...style } });
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    push(input.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) style = applySgr(style, m[1]); // an SGR sequence updates the style
    // every other matched sequence is a non-styling control code → consumed, emits nothing
  }
  push(input.slice(last));
  return spans;
}
