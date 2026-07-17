import { afterEach, expect, test } from "vitest";
import { applyTheme, loadTheme, setTheme, TERMINAL_BG } from "./theme";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

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
