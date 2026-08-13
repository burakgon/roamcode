import { afterEach, expect, test } from "vitest";
import { GHOSTTY_THEMES } from "../appearance/ghostty-themes.generated";
import {
  DEFAULT_THEME,
  OLED_STORAGE_KEY,
  THEME_DEFINITION_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyTheme,
  loadOled,
  loadTheme,
  setOled,
  setTheme,
  terminalTheme,
} from "./theme";

function theme(name: string) {
  const selected = GHOSTTY_THEMES.find((item) => item.name === name);
  if (!selected) throw new Error(`Missing generated Ghostty theme: ${name}`);
  return selected;
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.ghosttyTheme;
  delete document.documentElement.dataset.colorScheme;
});

test("ships and defaults to the complete pinned Ghostty catalog", () => {
  expect(GHOSTTY_THEMES).toHaveLength(602);
  expect(loadTheme()).toBe(DEFAULT_THEME);
  localStorage.setItem(THEME_STORAGE_KEY, "not-a-real-theme");
  expect(loadTheme()).toBe(DEFAULT_THEME);
});

test("setTheme persists one Ghostty palette and adapts app-wide tokens", () => {
  const selected = theme("Catppuccin Mocha");
  setTheme(selected);
  expect(loadTheme()).toBe("Catppuccin Mocha");
  expect(JSON.parse(localStorage.getItem(THEME_DEFINITION_STORAGE_KEY) ?? "null")).toMatchObject({
    name: "Catppuccin Mocha",
  });
  expect(document.documentElement.dataset.theme).toBe("ghostty");
  expect(document.documentElement.dataset.ghosttyTheme).toBe("Catppuccin Mocha");
  expect(document.documentElement.style.getPropertyValue("--bg")).toBe(selected.background);
  expect(document.documentElement.style.getPropertyValue("--surface-2")).toMatch(/^#/);
  expect(document.documentElement.style.getPropertyValue("--coral")).toMatch(/^#/);
});

test("OLED stays an independent true-black override for every palette", () => {
  const selected = theme("Dracula");
  setTheme(selected);
  setOled(true);
  expect(loadOled()).toBe(true);
  expect(localStorage.getItem(OLED_STORAGE_KEY)).toBe("1");
  expect(document.documentElement.dataset.theme).toBe("oled");
  expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#000000");
  expect(terminalTheme().background).toBe("#000000");
  setOled(false);
  expect(terminalTheme().background).toBe(selected.background);
});

test("applyTheme mirrors the selected Ghostty background into browser chrome", () => {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  document.head.appendChild(meta);
  const selected = theme("Catppuccin Latte");
  setTheme(selected);
  applyTheme("Catppuccin Latte", false);
  expect(meta.getAttribute("content")).toBe(selected.background);
  expect(document.documentElement.dataset.colorScheme).toBe("light");
  meta.remove();
});

test("theme changes announce both the new and backward-compatible events", () => {
  let modern = 0;
  let compatible = 0;
  const onModern = () => modern++;
  const onCompatible = () => compatible++;
  window.addEventListener("rc-appearance-change", onModern);
  window.addEventListener("rc-theme-change", onCompatible);
  setTheme(theme("TokyoNight"));
  window.removeEventListener("rc-appearance-change", onModern);
  window.removeEventListener("rc-theme-change", onCompatible);
  expect(modern).toBe(1);
  expect(compatible).toBe(1);
});
