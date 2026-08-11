import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TerminalKeyBar } from "./TerminalKeyBar";

// The keybar must preserve normal button semantics without trusting iOS's occasionally-missing synthesized
// click: pointerdown only arms a key, pointerup inside completes it, and cancellation never emits.

function renderBar(over: Partial<Parameters<typeof TerminalKeyBar>[0]> = {}) {
  const props = {
    ctrlLocked: false,
    onToggleCtrl: vi.fn(),
    onKey: vi.fn(),
    onOpenFiles: vi.fn(),
    filesCount: 0,
    chatOpen: false,
    onToggleChat: vi.fn(),
    onOpenKeyboard: vi.fn(),
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

test("simple keys wait for a completed press — Esc and Ctrl", () => {
  const p = renderBar();
  const escape = screen.getByRole("button", { name: "Escape" });
  fireEvent.pointerDown(escape, { pointerId: 1 });
  expect(p.onKey).not.toHaveBeenCalled();
  fireEvent.pointerUp(escape, { pointerId: 1 });
  expect(p.onKey).toHaveBeenCalledWith("Esc");

  const control = screen.getByRole("button", { name: "Control (sticky)" });
  fireEvent.pointerDown(control, { pointerId: 2 });
  expect(p.onToggleCtrl).not.toHaveBeenCalled();
  fireEvent.pointerUp(control, { pointerId: 2 });
  expect(p.onToggleCtrl).toHaveBeenCalledTimes(1);
});

test("a repeat key still completes when setPointerCapture throws", () => {
  // iOS throws NotFoundError from setPointerCapture for some touch pointerIds. The same-button pointerup must
  // still complete the press without falling back to unsafe touch-down activation.
  const orig = HTMLElement.prototype.setPointerCapture;
  HTMLElement.prototype.setPointerCapture = () => {
    throw new Error("NotFoundError");
  };
  try {
    const p = renderBar();
    const left = screen.getByRole("button", { name: "Arrow left" });
    fireEvent.pointerDown(left, { pointerId: 1 });
    expect(p.onKey).not.toHaveBeenCalled();
    fireEvent.pointerUp(left, { pointerId: 1 });
    expect(p.onKey).toHaveBeenCalledWith("ArrowLeft");
  } finally {
    HTMLElement.prototype.setPointerCapture = orig;
  }
});

test("sliding away or canceling an armed key emits nothing", () => {
  const p = renderBar();
  const esc = screen.getByRole("button", { name: "Escape" });
  vi.spyOn(esc, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 44,
    width: 100,
    height: 44,
    toJSON: () => ({}),
  });

  fireEvent.pointerDown(esc, { pointerId: 4, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(esc, { pointerId: 4, clientX: 130, clientY: 20 });
  fireEvent.pointerUp(esc, { pointerId: 4, clientX: 20, clientY: 20 });
  clock += 100;
  fireEvent.click(esc);
  expect(p.onKey).not.toHaveBeenCalled();

  clock += 800;
  fireEvent.pointerDown(esc, { pointerId: 5, clientX: 20, clientY: 20 });
  fireEvent.pointerCancel(esc, { pointerId: 5, clientX: 20, clientY: 20 });
  expect(p.onKey).not.toHaveBeenCalled();
});

test("the click fallback fires for VoiceOver/keyboard but is deduped after pointerup", () => {
  const p = renderBar();
  const esc = screen.getByRole("button", { name: "Escape" });
  // VoiceOver / hardware-keyboard activation = a lone synthesized click, no pointer → must fire.
  fireEvent.click(esc);
  expect(p.onKey).toHaveBeenCalledTimes(1);
  // A real touch completes on pointerup; its synthesized click ~300ms later must not fire twice.
  (p.onKey as ReturnType<typeof vi.fn>).mockClear();
  fireEvent.pointerDown(esc, { pointerId: 1 });
  expect(p.onKey).not.toHaveBeenCalled();
  fireEvent.pointerUp(esc, { pointerId: 1 });
  clock += 300; // the browser's synthesized click lands a moment later
  fireEvent.click(esc);
  expect(p.onKey).toHaveBeenCalledTimes(1);
});

test("keeps one compact row and groups the arrows like a physical laptop keyboard", () => {
  const p = renderBar();
  const toolbar = screen.getByRole("toolbar", { name: "Terminal keys" });
  expect(screen.queryByRole("button", { name: "Select text" })).toBeNull();
  expect(toolbar.querySelectorAll(".rc-termkeys__row")).toHaveLength(0);
  expect(toolbar.querySelectorAll("button")).toHaveLength(10);
  for (const removed of ["Page up", "Page down", "Home", "End", "Alt (sticky)"]) {
    expect(screen.queryByRole("button", { name: removed })).toBeNull();
  }

  const arrowGroup = screen.getByRole("group", { name: "Arrow keys" });
  expect(Array.from(arrowGroup.querySelectorAll("button"), (button) => button.getAttribute("aria-label"))).toEqual([
    "Arrow left",
    "Arrow up",
    "Arrow down",
    "Arrow right",
  ]);
  expect(screen.getByRole("button", { name: "Arrow left" })).toHaveClass("rc-tk__key--arrow-left");
  expect(screen.getByRole("button", { name: "Arrow up" })).toHaveClass("rc-tk__key--arrow-up");
  expect(screen.getByRole("button", { name: "Arrow down" })).toHaveClass("rc-tk__key--arrow-down");
  expect(screen.getByRole("button", { name: "Arrow right" })).toHaveClass("rc-tk__key--arrow-right");

  const files = screen.getByRole("button", { name: "Files" });
  const chat = screen.getByRole("button", { name: "Chat input" });
  const keyboard = screen.getByRole("button", { name: "Show keyboard" });
  expect(files).toHaveClass("rc-tk__key--utility");
  expect(chat).toHaveClass("rc-tk__key--utility");
  expect(keyboard).toHaveClass("rc-tk__key--keyboard");
  fireEvent.pointerDown(files, { pointerId: 3 });
  expect(p.onOpenFiles).not.toHaveBeenCalled();
  fireEvent.pointerUp(files, { pointerId: 3 });
  expect(p.onOpenFiles).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(chat, { pointerId: 4 });
  expect(p.onToggleChat).not.toHaveBeenCalled();
  fireEvent.pointerUp(chat, { pointerId: 4 });
  expect(p.onToggleChat).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(keyboard, { pointerId: 5 });
  expect(p.onOpenKeyboard).not.toHaveBeenCalled();
  fireEvent.pointerUp(keyboard, { pointerId: 5 });
  expect(p.onOpenKeyboard).toHaveBeenCalledTimes(1);
});

test("toolbar safe-area padding cannot pan the app shell", () => {
  renderBar();
  const toolbar = screen.getByRole("toolbar", { name: "Terminal keys" });
  const move = new Event("touchmove", { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(move, "touches", { value: [{ clientX: 20, clientY: 80 }] });

  fireEvent(toolbar, move);

  expect(move.defaultPrevented).toBe(true);
});

test("announces new received files on the Files utility key", () => {
  renderBar({ filesCount: 3 });
  expect(screen.getByRole("button", { name: "Files, 3 new" })).toBeInTheDocument();
  expect(screen.getByText("3")).toHaveAttribute("aria-hidden");
});

test("Ctrl and Chat expose their active states", () => {
  renderBar({ ctrlLocked: true, chatOpen: true });
  expect(screen.getByRole("button", { name: "Control (sticky)" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Chat input" })).toHaveAttribute("aria-pressed", "true");
});

test("arrows repeat quickly and release or window blur stops them", () => {
  vi.useFakeTimers();
  try {
    const p = renderBar();
    const left = screen.getByRole("button", { name: "Arrow left" });
    fireEvent.pointerDown(left, { pointerId: 8 });
    expect(p.onKey).not.toHaveBeenCalled();
    vi.advanceTimersByTime(379);
    expect(p.onKey).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(p.onKey).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(70);
    expect(p.onKey).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(left, { pointerId: 8 });
    vi.advanceTimersByTime(500);
    expect(p.onKey).toHaveBeenCalledTimes(2);

    fireEvent.pointerDown(left, { pointerId: 10 });
    vi.advanceTimersByTime(380);
    expect(p.onKey).toHaveBeenCalledTimes(3);
    fireEvent(window, new Event("blur"));
    vi.advanceTimersByTime(800);
    expect(p.onKey).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
