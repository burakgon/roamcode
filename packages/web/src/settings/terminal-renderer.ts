export type TerminalRenderer = "xterm" | "ghostty";

export const TERMINAL_RENDERER_STORAGE_KEY = "roamcode.terminal-renderer";

export function loadTerminalRenderer(): TerminalRenderer {
  try {
    return localStorage.getItem(TERMINAL_RENDERER_STORAGE_KEY) === "ghostty" ? "ghostty" : "xterm";
  } catch {
    return "xterm";
  }
}

export function saveTerminalRenderer(renderer: TerminalRenderer): void {
  try {
    localStorage.setItem(TERMINAL_RENDERER_STORAGE_KEY, renderer);
  } catch {
    /* Storage can be unavailable in private/locked-down browser contexts. */
  }
}

/** Renderer selection is captured once after legacy-storage migration and before React starts. */
export let BOOT_TERMINAL_RENDERER: TerminalRenderer = "xterm";

export function captureBootTerminalRenderer(): TerminalRenderer {
  BOOT_TERMINAL_RENDERER = loadTerminalRenderer();
  return BOOT_TERMINAL_RENDERER;
}

export function useXtermAndReload(): void {
  saveTerminalRenderer("xterm");
  window.location.reload();
}
