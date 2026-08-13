export interface TerminalFontDefinition {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly stack: string;
}

const fallback = 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace';
const font = (id: string, name: string, family = name): TerminalFontDefinition => ({
  id,
  name,
  family,
  stack: `"${family}", ${fallback}`,
});

/** Open, bundled fonts commonly offered by modern terminal emulators and developer tools. */
export const TERMINAL_FONTS: readonly TerminalFontDefinition[] = [
  font("jetbrains-mono", "JetBrains Mono"),
  font("fira-code", "Fira Code"),
  font("cascadia-code", "Cascadia Code"),
  font("source-code-pro", "Source Code Pro"),
  font("ibm-plex-mono", "IBM Plex Mono"),
  font("roboto-mono", "Roboto Mono"),
  font("ubuntu-mono", "Ubuntu Mono"),
  font("inconsolata", "Inconsolata"),
  font("iosevka", "Iosevka"),
  font("victor-mono", "Victor Mono"),
  font("geist-mono", "Geist Mono"),
  font("monaspace-neon", "Monaspace Neon"),
  font("commit-mono", "Commit Mono"),
  font("dejavu-mono", "DejaVu Sans Mono", "DejaVu Mono"),
  font("maple-mono", "Maple Mono"),
  font("noto-sans-mono", "Noto Sans Mono"),
  font("anonymous-pro", "Anonymous Pro"),
  font("dm-mono", "DM Mono"),
  font("space-mono", "Space Mono"),
  font("red-hat-mono", "Red Hat Mono"),
  font("azeret-mono", "Azeret Mono"),
] as const;

export const DEFAULT_TERMINAL_FONT_ID = "jetbrains-mono";
export const TERMINAL_FONT_BY_ID = new Map(TERMINAL_FONTS.map((entry) => [entry.id, entry]));
const STORAGE_KEY = "roamcode.terminal-font";

export function loadTerminalFont(): TerminalFontDefinition {
  try {
    return TERMINAL_FONT_BY_ID.get(localStorage.getItem(STORAGE_KEY) ?? "") ?? TERMINAL_FONTS[0]!;
  } catch {
    return TERMINAL_FONTS[0]!;
  }
}

export function applyTerminalFont(selected: TerminalFontDefinition): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--terminal-font", selected.stack);
  document.documentElement.dataset.terminalFont = selected.id;
}

export function setTerminalFont(id: string): TerminalFontDefinition {
  const selected = TERMINAL_FONT_BY_ID.get(id) ?? TERMINAL_FONTS[0]!;
  try {
    localStorage.setItem(STORAGE_KEY, selected.id);
  } catch {
    /* private mode: keep the in-memory selection */
  }
  applyTerminalFont(selected);
  try {
    window.dispatchEvent(new CustomEvent("rc-appearance-change", { detail: { font: selected.id } }));
  } catch {
    /* the next terminal mount reads the persisted preference */
  }
  return selected;
}
