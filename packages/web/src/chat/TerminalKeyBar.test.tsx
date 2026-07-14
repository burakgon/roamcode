import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TerminalKeyBar } from "./TerminalKeyBar";

// The keybar's whole job is delivering a keypress reliably on touch. These tests pin the two failure modes
// the user hit: (1) simple keys must fire on POINTERDOWN, not the iOS-flaky synthesized click, and (2) a
// thrown setPointerCapture must never swallow a repeat key's press.

function renderBar(over: Partial<Parameters<typeof TerminalKeyBar>[0]> = {}) {
  const props = {
    ctrlLocked: false,
    onToggleCtrl: vi.fn(),
    altLocked: false,
    onToggleAlt: vi.fn(),
    onKey: vi.fn(),
    onCompose: vi.fn(),
    ...over,
  };
  render(<TerminalKeyBar {...props} />);
  return props;
}

let nowSpy: ReturnType<typeof vi.spyOn>;
let clock = 1_000_000;
beforeEach(() => {
  clock = 1_000_000;
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  nowSpy.mockRestore();
  vi.restoreAllMocks();
});

test("simple keys fire on POINTERDOWN (not the iOS-flaky click) — Esc, Alt, and Ctrl", () => {
  const p = renderBar();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Escape" }), { pointerId: 1 });
  expect(p.onKey).toHaveBeenCalledWith("Esc");
  fireEvent.pointerDown(screen.getByRole("button", { name: "Alt (sticky)" }), { pointerId: 1 });
  expect(p.onToggleAlt).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Control (sticky)" }), { pointerId: 1 });
  expect(p.onToggleCtrl).toHaveBeenCalledTimes(1);
});

test("a repeat key still fires its press even when setPointerCapture THROWS (the dead-left-arrow bug)", () => {
  // iOS throws NotFoundError from setPointerCapture for some touch pointerIds; the action must have already
  // run. Force the throw and assert ArrowLeft still reached onKey.
  const orig = HTMLElement.prototype.setPointerCapture;
  HTMLElement.prototype.setPointerCapture = () => {
    throw new Error("NotFoundError");
  };
  try {
    const p = renderBar();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Arrow left" }), { pointerId: 1 });
    expect(p.onKey).toHaveBeenCalledWith("ArrowLeft");
  } finally {
    HTMLElement.prototype.setPointerCapture = orig;
  }
});

test("the click fallback fires for VoiceOver/keyboard (no preceding pointer) but is deduped after a tap", () => {
  const p = renderBar();
  const esc = screen.getByRole("button", { name: "Escape" });
  // VoiceOver / hardware-keyboard activation = a lone synthesized click, no pointer → must fire.
  fireEvent.click(esc);
  expect(p.onKey).toHaveBeenCalledTimes(1);
  // A real touch = pointerdown THEN a synthesized click ~300ms later → must fire exactly once, not twice.
  (p.onKey as ReturnType<typeof vi.fn>).mockClear();
  fireEvent.pointerDown(esc, { pointerId: 1 });
  clock += 300; // the browser's synthesized click lands a moment later
  fireEvent.click(esc);
  expect(p.onKey).toHaveBeenCalledTimes(1);
});

test("removes Select, keeps both key rows at six stable columns, and spans text input across both rows", () => {
  const p = renderBar();
  const toolbar = screen.getByRole("toolbar", { name: "Terminal keys" });
  const rows = toolbar.querySelectorAll(".rc-termkeys__row");
  expect(screen.queryByRole("button", { name: "Select text" })).toBeNull();
  expect(Array.from(rows, (row) => row.querySelectorAll("button").length)).toEqual([6, 6]);

  const compose = screen.getByRole("button", { name: "Open text input" });
  expect(compose).toHaveClass("rc-tk__key--compose");
  fireEvent.pointerDown(compose, { pointerId: 4 });
  expect(p.onCompose).toHaveBeenCalledTimes(1);
});

test("Ctrl and Alt expose independent locked states", () => {
  renderBar({ ctrlLocked: true, altLocked: true });
  expect(screen.getByRole("button", { name: "Control (sticky)" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Alt (sticky)" })).toHaveAttribute("aria-pressed", "true");
});

test("arrows repeat quickly, paging repeats deliberately, and release or window blur stops them", () => {
  vi.useFakeTimers();
  try {
    const p = renderBar();
    const left = screen.getByRole("button", { name: "Arrow left" });
    fireEvent.pointerDown(left, { pointerId: 8 });
    expect(p.onKey).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(379);
    expect(p.onKey).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(71);
    expect(p.onKey).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(left, { pointerId: 8 });
    vi.advanceTimersByTime(500);
    expect(p.onKey).toHaveBeenCalledTimes(2);

    (p.onKey as ReturnType<typeof vi.fn>).mockClear();
    const pageUp = screen.getByRole("button", { name: "Page up" });
    fireEvent.pointerDown(pageUp, { pointerId: 9 });
    vi.advanceTimersByTime(479);
    expect(p.onKey).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(261);
    expect(p.onKey).toHaveBeenCalledTimes(2);
    fireEvent(window, new Event("blur"));
    vi.advanceTimersByTime(800);
    expect(p.onKey).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
