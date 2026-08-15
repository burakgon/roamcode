import type { GhosttyThemeDefinition } from "../appearance/ghostty-themes.generated";

export type ThemeName = string;

export const DEFAULT_THEME = "RoamCode Dark";
export const ROAMCODE_THEME: GhosttyThemeDefinition = {
  name: DEFAULT_THEME,
  background: "#0a0a0b",
  foreground: "#cdd6e4",
  cursor: "#cdd6e4",
  cursorText: "#0b0e14",
  selectionBackground: "#50617a",
  selectionForeground: "#ffffff",
  palette: [
    "#11151c",
    "#e06c75",
    "#98c379",
    "#e5c07b",
    "#61afef",
    "#c678dd",
    "#56b6c2",
    "#cdd6e4",
    "#5c6370",
    "#e06c75",
    "#98c379",
    "#e5c07b",
    "#61afef",
    "#c678dd",
    "#56b6c2",
    "#ffffff",
  ],
};
export const THEME_STORAGE_KEY = "roamcode.ghostty-theme";
export const THEME_DEFINITION_STORAGE_KEY = "roamcode.ghostty-theme-definition";
export const OLED_STORAGE_KEY = "roamcode.oled";
const LEGACY_THEME_KEY = "roamcode.theme";

type Rgb = { r: number; g: number; b: number };

function rgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function hex({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Mix toward `right` by `amount` (0 = left, 1 = right). */
function mix(left: string, right: string, amount: number): string {
  const a = rgb(left);
  const b = rgb(right);
  return hex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

function alpha(color: string, opacity: number): string {
  const value = rgb(color);
  return `rgba(${value.r}, ${value.g}, ${value.b}, ${opacity})`;
}

function relativeLuminance(color: string): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const value = rgb(color);
  return 0.2126 * linear(value.r) + 0.7152 * linear(value.g) + 0.0722 * linear(value.b);
}

function contrast(left: string, right: string): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function saturation(color: string): number {
  const value = rgb(color);
  const max = Math.max(value.r, value.g, value.b) / 255;
  const min = Math.min(value.r, value.g, value.b) / 255;
  return max === 0 ? 0 : (max - min) / max;
}

function accentFor(theme: GhosttyThemeDefinition): string {
  const candidates = [theme.cursor, ...theme.palette.slice(4, 7), ...theme.palette.slice(9, 15)];
  return candidates.reduce((best, candidate) => {
    const score = Math.min(5, contrast(theme.background, candidate)) + saturation(candidate) * 6;
    const bestScore = Math.min(5, contrast(theme.background, best)) + saturation(best) * 6;
    return score > bestScore ? candidate : best;
  }, theme.palette[4] ?? theme.foreground);
}

export function isLightTheme(theme: GhosttyThemeDefinition): boolean {
  return relativeLuminance(theme.background) > 0.42;
}

export function loadTheme(): ThemeName {
  try {
    const selected = localStorage.getItem(THEME_STORAGE_KEY);
    if (selected === DEFAULT_THEME) return DEFAULT_THEME;
    if (selected && storedThemeDefinition(selected)) return selected;
  } catch {
    /* storage is optional */
  }
  return DEFAULT_THEME;
}

function validThemeDefinition(value: unknown): value is GhosttyThemeDefinition {
  if (typeof value !== "object" || value === null) return false;
  const theme = value as Partial<GhosttyThemeDefinition>;
  const colors = [
    theme.background,
    theme.foreground,
    theme.cursor,
    theme.cursorText,
    theme.selectionBackground,
    theme.selectionForeground,
  ];
  return (
    typeof theme.name === "string" &&
    theme.name.length > 0 &&
    colors.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) &&
    Array.isArray(theme.palette) &&
    theme.palette.length >= 16 &&
    theme.palette.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))
  );
}

function storedThemeDefinition(name: string): GhosttyThemeDefinition | undefined {
  if (name === DEFAULT_THEME) return ROAMCODE_THEME;
  try {
    const raw = localStorage.getItem(THEME_DEFINITION_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return validThemeDefinition(parsed) && parsed.name === name ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function loadOled(): boolean {
  try {
    const selected = localStorage.getItem(OLED_STORAGE_KEY);
    if (selected !== null) return selected === "1";
    // One-time, read-through migration from the former dark/oled theme preference.
    return localStorage.getItem(LEGACY_THEME_KEY) === "oled";
  } catch {
    return false;
  }
}

export function themeDefinition(name: ThemeName = loadTheme()): GhosttyThemeDefinition {
  return storedThemeDefinition(name) ?? ROAMCODE_THEME;
}

export function terminalTheme(name: ThemeName = loadTheme(), oled = loadOled()) {
  const selected = themeDefinition(name);
  return {
    background: oled ? "#000000" : selected.background,
    foreground: selected.foreground,
    cursor: selected.cursor,
    cursorText: selected.cursorText,
    selectionBackground: selected.selectionBackground,
    selectionForeground: selected.selectionForeground,
    palette: selected.palette,
  };
}

/** Legacy export kept for external consumers while the selected theme can now be any Ghostty theme. */
export const TERMINAL_BG: Readonly<Record<string, string>> = Object.freeze({
  dark: themeDefinition(DEFAULT_THEME).background,
  oled: "#000000",
});

function appearanceVariables(theme: GhosttyThemeDefinition, oled: boolean): Record<string, string> {
  const background = oled ? "#000000" : theme.background;
  const foreground = theme.foreground;
  const accent = accentFor({ ...theme, background });
  const light = isLightTheme({ ...theme, background });
  const surface = mix(background, foreground, light ? 0.045 : 0.075);
  const surface2 = mix(background, foreground, light ? 0.08 : 0.125);
  const surface3 = mix(background, foreground, light ? 0.12 : 0.18);
  const error = theme.palette[9] ?? theme.palette[1] ?? accent;
  const warning = theme.palette[11] ?? theme.palette[3] ?? accent;
  const onAccent = contrast(accent, "#000000") >= contrast(accent, "#ffffff") ? "#000000" : "#ffffff";
  const onError = contrast(error, "#000000") >= contrast(error, "#ffffff") ? "#000000" : "#ffffff";
  return {
    "--bg": background,
    "--surface": surface,
    "--surface-2": surface2,
    "--surface-3": surface3,
    "--border": alpha(foreground, light ? 0.16 : 0.12),
    "--border-strong": alpha(foreground, light ? 0.28 : 0.2),
    "--text": foreground,
    "--text-muted": mix(foreground, background, 0.34),
    "--text-faint": mix(foreground, background, 0.48),
    "--coral": accent,
    "--coral-2": mix(accent, foreground, 0.2),
    "--coral-deep": mix(accent, background, 0.23),
    "--accent": accent,
    "--accent-2": mix(accent, foreground, 0.2),
    "--accent-soft": alpha(accent, 0.14),
    "--accent-line": alpha(accent, 0.48),
    "--on-accent": onAccent,
    "--user-bubble-bg": surface2,
    "--user-bubble-border": alpha(foreground, 0.12),
    "--user-bubble-text": foreground,
    "--iris": accent,
    "--awaiting": accent,
    "--awaiting-soft": alpha(accent, 0.14),
    "--awaiting-line": alpha(accent, 0.48),
    "--warn": warning,
    "--err": error,
    "--on-err": onError,
    "--err-soft": alpha(error, 0.12),
    "--err-line": alpha(error, 0.42),
    "--focus-ring": `2px solid ${accent}`,
    "--focus-glow": `0 0 0 3px ${alpha(accent, 0.14)}`,
    "--atmosphere": background,
    "--glass": surface,
    "--glass-strong": surface2,
    "--accent-grad": accent,
    "--code-bg": mix(background, foreground, light ? 0.025 : 0.04),
    "--code-border": alpha(foreground, 0.12),
    "--code-text": foreground,
    "--code-keyword": theme.palette[12] ?? foreground,
    "--code-string": theme.palette[10] ?? foreground,
    "--code-comment": mix(foreground, background, 0.52),
    "--code-function": theme.palette[13] ?? foreground,
    "--iris-card-bg-top": surface,
    "--iris-card-bg-bottom": surface,
    "--iris-card-border": alpha(accent, 0.38),
    "--iris-line": alpha(accent, 0.48),
    "--iris-soft": alpha(accent, 0.14),
    "--on-iris": onAccent,
    "--err-bg": alpha(error, 0.12),
    "--err-border": alpha(error, 0.42),
    "--ambient": background,
    "--ambient-center": background,
    "--tile-bg": surface2,
    "--tile-edge": alpha(foreground, 0.2),
    "--bar-glass": surface,
    "--terminal-bg": background,
  };
}

function applyThemeDefinition(selected: GhosttyThemeDefinition, oled: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [property, value] of Object.entries(appearanceVariables(selected, oled))) {
    root.style.setProperty(property, value);
  }
  const light = isLightTheme({ ...selected, background: oled ? "#000000" : selected.background });
  root.dataset.theme = oled ? "oled" : "ghostty";
  root.dataset.ghosttyTheme = selected.name;
  root.dataset.colorScheme = light ? "light" : "dark";
  root.style.colorScheme = light ? "light" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", oled ? "#000000" : selected.background);
}

/** Apply one Ghostty palette to the terminal and every token-driven application surface. */
export function applyTheme(name: ThemeName, oled = loadOled()): void {
  applyThemeDefinition(themeDefinition(name), oled);
}

function announceAppearance(detail: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent("rc-appearance-change", { detail }));
    // Backward-compatible notification for open views from the former dark/OLED implementation.
    window.dispatchEvent(new CustomEvent("rc-theme-change", { detail }));
  } catch {
    /* the next mount reads persisted appearance */
  }
}

export function setTheme(theme: ThemeName | GhosttyThemeDefinition): ThemeName {
  const selected =
    typeof theme === "string" ? themeDefinition(theme) : validThemeDefinition(theme) ? theme : ROAMCODE_THEME;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, selected.name);
    if (selected.name === DEFAULT_THEME) localStorage.removeItem(THEME_DEFINITION_STORAGE_KEY);
    else localStorage.setItem(THEME_DEFINITION_STORAGE_KEY, JSON.stringify(selected));
  } catch {
    /* private mode: keep the applied in-memory theme */
  }
  applyThemeDefinition(selected, loadOled());
  announceAppearance({ theme: selected.name, oled: loadOled() });
  return selected.name;
}

export function setOled(oled: boolean): void {
  try {
    localStorage.setItem(OLED_STORAGE_KEY, oled ? "1" : "0");
  } catch {
    /* private mode: keep the applied in-memory preference */
  }
  const selected = loadTheme();
  applyTheme(selected, oled);
  announceAppearance({ theme: selected, oled });
}
