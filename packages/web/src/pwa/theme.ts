/**
 * Theme preference: the default near-black "dark", "oled" (TRUE #000 black — on an OLED panel those pixels
 * are simply off, so the app burns less battery and blacks read bottomless), "light" (a paper-white
 * palette for bright-daylight use), or "system" (follow the OS prefers-color-scheme, light ↔ dark). A
 * CLIENT-side preference (same localStorage convention as session names): applied by setting `data-theme`
 * on <html>, which tokens.css uses to override the surface palette. Applied at boot (main.tsx, before
 * first paint) and instantly from Settings.
 */

/** A concrete palette (what tokens.css / xterm can actually render). */
export type ThemeName = "dark" | "oled" | "light";

/** What the user PICKED in Settings — a concrete theme, or "system" (resolved per prefers-color-scheme). */
export type ThemePreference = ThemeName | "system";

const KEY = "roamcode.theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** The terminal (xterm) background for each theme — xterm paints its own canvas/DOM background, so it can't
 *  inherit the CSS token; TerminalView reads this at mount + on the rc-theme-change event. */
export const TERMINAL_BG: Record<ThemeName, string> = {
  dark: "#0a0a0b",
  oled: "#000000",
  light: "#f6f6f7",
};

/** The browser-chrome color (status bar / title bar) per theme — mirrored into <meta name="theme-color">. */
const THEME_COLOR: Record<ThemeName, string> = {
  dark: "#0a0a0b",
  oled: "#000000",
  light: "#f6f6f7",
};

export function loadTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "oled" || stored === "light" || stored === "system" ? stored : "dark";
  } catch {
    return "dark";
  }
}

/** The concrete palette for a preference: "system" follows the OS scheme (light ↔ dark). Falls back to
 *  dark where matchMedia is unavailable (jsdom / SSR) — same guard idiom as AppLayout's useIsDesktop. */
export function resolveTheme(preference: ThemePreference): ThemeName {
  if (preference !== "system") return preference;
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(LIGHT_QUERY).matches
    ? "light"
    : "dark";
}

/** Apply the theme to the document: the data-theme attribute (tokens.css keys off it) + the theme-color meta.
 *  Safe anywhere (no-ops without a document). */
export function applyTheme(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  const theme = resolveTheme(preference);
  // dark is the :root default — the attribute is REMOVED (not set to "dark") so no override block matches.
  if (theme === "dark") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[theme]);
}

/** Persist + apply + announce (rc-theme-change) so live views (the open terminal) can restyle immediately. */
export function setTheme(preference: ThemePreference): void {
  try {
    localStorage.setItem(KEY, preference);
  } catch {
    /* private mode — the preference just won't persist */
  }
  applyTheme(preference);
  try {
    window.dispatchEvent(new CustomEvent("rc-theme-change", { detail: preference }));
  } catch {
    /* CustomEvent unavailable — live views will pick the theme up on next mount */
  }
}

/** While the preference is "system", re-apply + announce when the OS scheme flips, so the app (and an open
 *  terminal, via rc-theme-change) follows a daylight/night switch live. Call once at boot; returns a
 *  disposer. No-op where matchMedia is unavailable. */
export function watchSystemTheme(): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(LIGHT_QUERY);
  const onChange = (): void => {
    if (loadTheme() !== "system") return;
    applyTheme("system");
    try {
      window.dispatchEvent(new CustomEvent("rc-theme-change", { detail: "system" }));
    } catch {
      /* live views will pick the theme up on next mount */
    }
  };
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
