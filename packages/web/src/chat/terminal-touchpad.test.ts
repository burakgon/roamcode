import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  installTerminalTouchpad,
  type TerminalTouchpadBounds,
  type TerminalTouchpadButton,
  type TerminalTouchpadPoint,
} from "./terminal-touchpad";

type ButtonCall = {
  button: TerminalTouchpadButton;
  pressed: boolean;
  point: TerminalTouchpadPoint;
  buttons: number;
  detail: number;
};

function touch(type: "touchstart" | "touchmove" | "touchend" | "touchcancel", points: [number, number][]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, "touches", {
    value: points.map(([clientX, clientY], identifier) => ({ clientX, clientY, identifier })),
  });
  Object.defineProperty(event, "changedTouches", { value: [] });
  return event;
}

function setup(bounds: () => TerminalTouchpadBounds = () => ({ left: 10, top: 20, right: 210, bottom: 120 })) {
  const element = document.createElement("div");
  document.body.append(element);
  const moves: { point: TerminalTouchpadPoint; buttons: number }[] = [];
  const buttons: ButtonCall[] = [];
  const scrolls: { deltaY: number; point: TerminalTouchpadPoint }[] = [];
  const gestures: string[] = [];
  const dispose = installTerminalTouchpad(element, {
    bounds,
    onMove: (point, activeButtons) => moves.push({ point: { ...point }, buttons: activeButtons }),
    onButton: (button, pressed, point, activeButtons, detail) =>
      buttons.push({ button, pressed, point: { ...point }, buttons: activeButtons, detail }),
    onScroll: (deltaY, point) => scrolls.push({ deltaY, point: { ...point } }),
    onGesture: (kind) => gestures.push(kind),
  });
  return { buttons, dispose, element, gestures, moves, scrolls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("starts the software pointer in the terminal center and moves it relatively", () => {
  const { dispose, element, gestures, moves } = setup();
  expect(moves).toEqual([{ point: { x: 110, y: 70 }, buttons: 0 }]);

  element.dispatchEvent(touch("touchstart", [[180, 90]]));
  vi.advanceTimersByTime(20);
  const moved = touch("touchmove", [[190, 95]]);
  element.dispatchEvent(moved);

  expect(moved.defaultPrevented).toBe(true);
  expect(moves.at(-1)?.point.x).toBeGreaterThan(120);
  expect(moves.at(-1)?.point.y).toBeGreaterThan(75);
  expect(gestures).toEqual(["move"]);
  dispose();
});

test("a stationary one-finger tap clicks the current pointer instead of the touched coordinate", () => {
  const { buttons, element, moves } = setup();
  element.dispatchEvent(touch("touchstart", [[15, 25]]));
  vi.advanceTimersByTime(80);
  element.dispatchEvent(touch("touchend", []));

  expect(buttons).toEqual([{ button: "left", pressed: true, point: { x: 110, y: 70 }, buttons: 1, detail: 1 }]);
  expect(moves).toHaveLength(1);

  vi.advanceTimersByTime(250);
  expect(buttons.at(-1)).toEqual({
    button: "left",
    pressed: false,
    point: { x: 110, y: 70 },
    buttons: 0,
    detail: 1,
  });
});

test("tap then touch-and-move keeps the left button held for desktop-style dragging", () => {
  const { buttons, element, moves } = setup();
  element.dispatchEvent(touch("touchstart", [[100, 60]]));
  vi.advanceTimersByTime(40);
  element.dispatchEvent(touch("touchend", []));
  expect(buttons.at(-1)?.pressed).toBe(true);

  vi.advanceTimersByTime(40);
  element.dispatchEvent(touch("touchstart", [[100, 60]]));
  vi.advanceTimersByTime(20);
  element.dispatchEvent(touch("touchmove", [[110, 60]]));
  expect(moves.at(-1)?.buttons).toBe(1);
  element.dispatchEvent(touch("touchend", []));

  expect(buttons.at(-1)).toMatchObject({ button: "left", pressed: false, buttons: 0 });
});

test("two fingers scroll naturally without moving the pointer and tap for secondary click", () => {
  const { buttons, element, moves, scrolls } = setup();
  element.dispatchEvent(
    touch("touchstart", [
      [80, 40],
      [120, 40],
    ]),
  );
  vi.advanceTimersByTime(20);
  element.dispatchEvent(
    touch("touchmove", [
      [80, 85],
      [120, 85],
    ]),
  );
  expect(scrolls).toEqual([{ deltaY: -45, point: { x: 110, y: 70 } }]);
  expect(moves).toHaveLength(1);
  element.dispatchEvent(touch("touchend", []));
  expect(buttons).toEqual([]);

  element.dispatchEvent(
    touch("touchstart", [
      [20, 20],
      [40, 20],
    ]),
  );
  vi.advanceTimersByTime(40);
  element.dispatchEvent(touch("touchend", []));
  expect(buttons.at(-1)).toMatchObject({ button: "right", pressed: true, buttons: 2 });
});

test("two-finger scrolling keeps its full CSS-pixel distance on high-density displays", () => {
  vi.stubGlobal("devicePixelRatio", 3);
  const { element, scrolls } = setup();
  element.dispatchEvent(
    touch("touchstart", [
      [80, 40],
      [120, 40],
    ]),
  );
  vi.advanceTimersByTime(20);
  element.dispatchEvent(
    touch("touchmove", [
      [80, 85],
      [120, 85],
    ]),
  );
  expect(scrolls).toEqual([{ deltaY: -45, point: { x: 110, y: 70 } }]);
});

test("sub-threshold two-finger jitter remains a secondary click instead of a scroll", () => {
  const { buttons, element, scrolls } = setup();
  element.dispatchEvent(
    touch("touchstart", [
      [80, 40],
      [120, 40],
    ]),
  );
  vi.advanceTimersByTime(20);
  element.dispatchEvent(
    touch("touchmove", [
      [80, 44],
      [120, 44],
    ]),
  );
  element.dispatchEvent(touch("touchend", []));

  expect(scrolls).toEqual([]);
  expect(buttons.at(-1)).toMatchObject({ button: "right", pressed: true, buttons: 2 });
});

test("clamps the software pointer into resized terminal bounds before a stationary tap", () => {
  let bounds = { left: 10, top: 20, right: 210, bottom: 120 };
  const state = setup(() => bounds);
  expect(state.moves.at(-1)?.point).toEqual({ x: 110, y: 70 });

  bounds = { left: 10, top: 20, right: 80, bottom: 60 };
  state.element.dispatchEvent(touch("touchstart", [[30, 40]]));
  state.element.dispatchEvent(touch("touchend", []));

  expect(state.moves.at(-1)?.point).toEqual({ x: 79, y: 59 });
  expect(state.buttons.at(-1)?.point).toEqual({ x: 79, y: 59 });
  state.dispose();
});

test("cancel and disposal release a pending mouse button and never manufacture a click", () => {
  const { buttons, dispose, element } = setup();
  element.dispatchEvent(touch("touchstart", [[100, 60]]));
  element.dispatchEvent(touch("touchcancel", []));
  expect(buttons).toEqual([]);

  element.dispatchEvent(touch("touchstart", [[100, 60]]));
  element.dispatchEvent(touch("touchend", []));
  expect(buttons.at(-1)?.pressed).toBe(true);
  dispose();
  expect(buttons.at(-1)?.pressed).toBe(false);
  vi.runAllTimers();
  expect(buttons).toHaveLength(2);
});
