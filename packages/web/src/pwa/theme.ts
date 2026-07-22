/**
 * Theme preference: the default near-black "dark", "oled" (TRUE #000 black — on an OLED panel those pixels
 * are simply off, so the app burns less battery and blacks read bottomless), or "light" (paper surfaces for
 * bright-daylight use). A CLIENT-side preference (same localStorage convention as session names): applied by
 * setting `data-theme` on <html>, which tokens.css uses to override the surface palette. Applied at boot
 * (main.tsx, before first paint) and instantly from Settings.
 */

export type ThemeName = "dark" | "oled" | "light";

const KEY = "roamcode.theme";

/** The terminal (xterm) background for each theme — xterm paints its own canvas/DOM background, so it can't
 *  inherit the CSS token; TerminalView reads this at mount + on the rc-theme-change event. */
export const TERMINAL_BG: Record<ThemeName, string> = {
  dark: "#0a0a0b",
  oled: "#000000",
  light: "#f7f6f3",
};

/** The browser-chrome color (status bar / title bar) per theme — mirrored into <meta name="theme-color">. */
const THEME_COLOR: Record<ThemeName, string> = {
  dark: "#0a0a0b",
  oled: "#000000",
  light: "#f7f6f3",
};

export function loadTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "oled" || stored === "light" ? stored : "dark";
  } catch {
    return "dark";
  }
}

/** Apply the theme to the document: the data-theme attribute (tokens.css keys off it) + the theme-color meta.
 *  Safe anywhere (no-ops without a document). */
export function applyTheme(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  if (theme === "dark") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[theme]);
}

/** Persist + apply + announce (rc-theme-change) so live views (the open terminal) can restyle immediately. */
export function setTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode — the preference just won't persist */
  }
  applyTheme(theme);
  try {
    window.dispatchEvent(new CustomEvent("rc-theme-change", { detail: theme }));
  } catch {
    /* CustomEvent unavailable — live views will pick the theme up on next mount */
  }
}
