import type { CSSProperties } from "react";
import { parseAnsi, type AnsiStyle } from "./ansi";

/** Map one parsed {@link AnsiStyle} to inline CSS. `inverse` swaps fg/bg (defaulting to the code panel's
 *  own colors); `dim` rides on opacity so it reads as faded regardless of the chosen color. */
function toCss(st: AnsiStyle): CSSProperties {
  let color = st.color;
  let background = st.background;
  if (st.inverse) {
    const fg = color ?? "var(--code-text)";
    const bg = background ?? "var(--code-bg)";
    color = bg;
    background = fg;
  }
  const decoration = [st.underline ? "underline" : "", st.strike ? "line-through" : ""].filter(Boolean).join(" ");
  return {
    color,
    background,
    fontWeight: st.bold ? 600 : undefined,
    fontStyle: st.italic ? "italic" : undefined,
    textDecoration: decoration || undefined,
    opacity: st.dim ? 0.7 : undefined,
  };
}

/**
 * Render terminal output WITH its ANSI colors/styles (instead of flattening to plain text): parse the SGR
 * codes into styled runs and emit a <span> per run. Non-color control sequences (cursor/erase/title) are
 * dropped by the parser. Meant to live inside a <pre> (the caller keeps the monospace + whitespace).
 */
export function AnsiText({ text }: { text: string }) {
  const spans = parseAnsi(text);
  return (
    <>
      {spans.map((s, i) => {
        const css = toCss(s.style);
        // A default-styled run needs no wrapping span (keeps the DOM lean for the common all-plain case).
        return Object.keys(css).some((k) => css[k as keyof CSSProperties] !== undefined) ? (
          <span key={i} style={css}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        );
      })}
    </>
  );
}
