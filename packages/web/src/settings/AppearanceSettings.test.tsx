import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.ghosttyTheme;
  delete document.documentElement.dataset.terminalFont;
});

test("offers the complete Ghostty catalog with compact previews and live selection", () => {
  render(<AppearanceSettings />);
  const catalog = screen.getByRole("listbox", { name: "Ghostty themes" });
  expect(within(catalog).getAllByRole("option").length).toBeGreaterThan(10);
  expect(screen.getByText("Catppuccin Mocha")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "All 602" }));
  // The RoamCode default is retained ahead of Ghostty's complete 602-theme snapshot.
  // Use the already-proven option selector for the bulk count: computing the full accessibility tree for
  // 603 preview cards dominates jsdom's shared full-suite worker without testing any additional behavior.
  expect(catalog.querySelectorAll('[role="option"]')).toHaveLength(603);

  fireEvent.change(screen.getByRole("searchbox", { name: "Search Ghostty themes" }), {
    target: { value: "Builtin Light" },
  });
  expect(catalog.querySelectorAll('[role="option"]')).toHaveLength(1);
  fireEvent.click(screen.getByText("Builtin Light"));
  expect(document.documentElement.dataset.ghosttyTheme).toBe("Builtin Light");
  expect(document.documentElement.dataset.colorScheme).toBe("light");
});

test("bundles twenty terminal fonts and applies the selected face without remounting settings", () => {
  render(<AppearanceSettings />);
  const font = screen.getByRole("combobox", { name: "Terminal font" });
  expect(within(font).getAllByRole("option")).toHaveLength(20);
  fireEvent.change(font, { target: { value: "fira-code" } });
  expect(document.documentElement.dataset.terminalFont).toBe("fira-code");
  expect(document.documentElement.style.getPropertyValue("--terminal-font")).toContain("Fira Code");
});
