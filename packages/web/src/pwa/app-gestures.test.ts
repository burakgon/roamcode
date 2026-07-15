import { afterEach, expect, test } from "vitest";
import { installAppGestureGuards } from "./app-gestures";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

test("prevents browser pinch gestures while leaving ordinary wheel input alone", () => {
  dispose = installAppGestureGuards(document);

  const webkitPinch = new Event("gesturestart", { bubbles: true, cancelable: true });
  document.dispatchEvent(webkitPinch);
  expect(webkitPinch.defaultPrevented).toBe(true);

  const trackpadPinch = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 4 });
  document.dispatchEvent(trackpadPinch);
  expect(trackpadPinch.defaultPrevented).toBe(true);

  const ordinaryWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 4 });
  document.dispatchEvent(ordinaryWheel);
  expect(ordinaryWheel.defaultPrevented).toBe(false);
});

test("removes every gesture guard when disposed", () => {
  dispose = installAppGestureGuards(document);
  dispose();
  dispose = undefined;

  const pinch = new Event("gesturechange", { bubbles: true, cancelable: true });
  document.dispatchEvent(pinch);
  expect(pinch.defaultPrevented).toBe(false);
});
