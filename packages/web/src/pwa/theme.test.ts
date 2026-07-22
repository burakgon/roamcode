import { afterEach, expect, test, vi } from "vitest";
import { applyTheme, loadTheme, resolveTheme, setTheme, TERMINAL_BG, watchSystemTheme } from "./theme";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

/** A minimal MediaQueryList stub for the prefers-color-scheme query (jsdom has no matchMedia). */
function stubSystemScheme(light: boolean): { fireChange: () => void } {
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-color-scheme: light") ? light : false,
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return { fireChange: () => listeners.forEach((fn) => fn()) };
}

test("defaults to dark when nothing is stored (or storage holds junk)", () => {
  expect(loadTheme()).toBe("dark");
  localStorage.setItem("roamcode.theme", "neon");
  expect(loadTheme()).toBe("dark");
});

test("setTheme persists + applies data-theme; switching back removes it", () => {
  setTheme("oled");
  expect(loadTheme()).toBe("oled");
  expect(document.documentElement.dataset.theme).toBe("oled");
  setTheme("dark");
  expect(loadTheme()).toBe("dark");
  // dark is the :root default — the attribute must be REMOVED (not set to "dark") so the override block never matches.
  expect(document.documentElement.dataset.theme).toBeUndefined();
});

test("light persists + applies data-theme='light'; unknown stored values still fall back to dark", () => {
  setTheme("light");
  expect(loadTheme()).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  localStorage.setItem("roamcode.theme", "solarized");
  expect(loadTheme()).toBe("dark");
});

test("applyTheme mirrors the theme-color meta when present", () => {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", "#0a0a0b");
  document.head.appendChild(meta);
  applyTheme("oled");
  expect(meta.getAttribute("content")).toBe("#000000");
  applyTheme("light");
  expect(meta.getAttribute("content")).toBe("#f6f6f7");
  applyTheme("dark");
  expect(meta.getAttribute("content")).toBe("#0a0a0b");
  meta.remove();
});

test("the terminal background map covers every theme (xterm can't inherit CSS vars)", () => {
  expect(TERMINAL_BG.oled).toBe("#000000");
  expect(TERMINAL_BG.dark).toBe("#0a0a0b");
  expect(TERMINAL_BG.light).toBe("#f6f6f7");
});

test("setTheme announces rc-theme-change so an open terminal can restyle live", () => {
  let seen = "";
  const on = (e: Event): void => {
    seen = String((e as CustomEvent).detail);
  };
  window.addEventListener("rc-theme-change", on);
  setTheme("oled");
  window.removeEventListener("rc-theme-change", on);
  expect(seen).toBe("oled");
});

test("system persists, resolves per prefers-color-scheme, and falls back to dark without matchMedia", () => {
  // jsdom has no matchMedia — "system" must resolve to dark, not crash.
  setTheme("system");
  expect(loadTheme()).toBe("system");
  expect(resolveTheme("system")).toBe("dark");
  expect(document.documentElement.dataset.theme).toBeUndefined();

  stubSystemScheme(true);
  expect(resolveTheme("system")).toBe("light");
  applyTheme("system");
  expect(document.documentElement.dataset.theme).toBe("light");

  // Concrete preferences never consult the OS.
  expect(resolveTheme("oled")).toBe("oled");
});

test("watchSystemTheme re-applies + announces on an OS flip only while the preference is system", () => {
  const scheme = stubSystemScheme(true);
  let announced = 0;
  const on = (): void => {
    announced += 1;
  };
  window.addEventListener("rc-theme-change", on);
  const dispose = watchSystemTheme();

  setTheme("system"); // announces once itself
  expect(document.documentElement.dataset.theme).toBe("light");
  scheme.fireChange();
  expect(announced).toBe(2);

  setTheme("oled"); // concrete preference → OS flips are ignored
  scheme.fireChange();
  expect(announced).toBe(3);
  expect(document.documentElement.dataset.theme).toBe("oled");

  dispose();
  window.removeEventListener("rc-theme-change", on);
});
