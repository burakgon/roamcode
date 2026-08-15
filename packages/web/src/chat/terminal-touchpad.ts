/**
 * A relative touchpad gesture translator for the terminal surface.
 *
 * The interaction contract and conservative thresholds follow Apache Guacamole's long-running default touchpad
 * mode: relative one-finger pointer movement, tap-to-click, tap-then-touch drag, two-finger secondary click, and
 * pixel-precise two-finger wheel input. The browser-facing implementation is local so terminal-specific routing can
 * stay in TerminalView without adding a remote-desktop runtime dependency.
 */

export type TerminalTouchpadButton = "left" | "middle" | "right";

export type TerminalTouchpadPoint = {
  x: number;
  y: number;
};

export type TerminalTouchpadBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type TerminalTouchpadCallbacks = {
  bounds(): TerminalTouchpadBounds;
  onTouchStart?(): void;
  onMove(point: TerminalTouchpadPoint, buttons: number, dispatch: boolean): void;
  onButton(
    button: TerminalTouchpadButton,
    pressed: boolean,
    point: TerminalTouchpadPoint,
    buttons: number,
    detail: number,
  ): void;
  /** A browser-compatible vertical scroll delta in CSS pixels. */
  onScroll(deltaY: number, point: TerminalTouchpadPoint): void;
  onGesture?(kind: "move" | "scroll" | "tap"): void;
};

const CLICK_TIME_MS = 250;
const CLICK_MOVE_THRESHOLD = 10;
const SCROLL_START_THRESHOLD = 6;
// A direct 1:1 mapping makes a full two-finger phone swipe produce only a few discrete wheel reports in
// alternate-screen TUIs such as Codex. A stable 3x gain supplies trackpad-like travel without manufacturing
// post-touch momentum, so stopping the fingers still stops the terminal immediately.
const TOUCHPAD_SCROLL_GAIN = 3;
const BUTTON_MASK: Record<TerminalTouchpadButton, number> = {
  left: 1,
  right: 2,
  middle: 4,
};
const TOUCH_BUTTON: Record<number, TerminalTouchpadButton | undefined> = {
  1: "left",
  2: "right",
  3: "middle",
};

function clampPoint(point: TerminalTouchpadPoint, bounds: TerminalTouchpadBounds): TerminalTouchpadPoint {
  return {
    x: Math.min(Math.max(bounds.left, point.x), Math.max(bounds.left, bounds.right - 1)),
    y: Math.min(Math.max(bounds.top, point.y), Math.max(bounds.top, bounds.bottom - 1)),
  };
}

function centerOf(bounds: TerminalTouchpadBounds): TerminalTouchpadPoint {
  return clampPoint(
    {
      x: bounds.left + Math.max(0, bounds.right - bounds.left) / 2,
      y: bounds.top + Math.max(0, bounds.bottom - bounds.top) / 2,
    },
    bounds,
  );
}

function cancelEvent(event: TouchEvent): void {
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
}

/** Install touchpad semantics on an element and return a complete lifecycle cleanup. */
export function installTerminalTouchpad(element: HTMLElement, callbacks: TerminalTouchpadCallbacks): () => void {
  let point = centerOf(callbacks.bounds());
  let touchCount = 0;
  let lastTouchX = 0;
  let lastTouchY = 0;
  let lastTouchTime = 0;
  let pixelsMoved = 0;
  let gestureInProgress = false;
  let scrolling = false;
  let pendingScrollY = 0;
  let buttons = 0;
  let pressedButton: TerminalTouchpadButton | undefined;
  let pressedDetail = 1;
  let clickReleaseTimer: number | undefined;
  let lastClick:
    { button: TerminalTouchpadButton; at: number; point: TerminalTouchpadPoint; detail: number } | undefined;

  const touchCenter = (touches: TouchList): { x: number; y: number } | undefined => {
    if (touches.length === 0) return undefined;
    let x = 0;
    let y = 0;
    for (let index = 0; index < touches.length; index++) {
      const touch = touches[index];
      if (!touch) continue;
      x += touch.clientX;
      y += touch.clientY;
    }
    return { x: x / touches.length, y: y / touches.length };
  };

  callbacks.onMove(point, buttons, false);

  const release = (button: TerminalTouchpadButton, detail = pressedDetail): void => {
    if (pressedButton !== button) return;
    buttons &= ~BUTTON_MASK[button];
    pressedButton = undefined;
    callbacks.onButton(button, false, point, buttons, detail);
  };

  const press = (button: TerminalTouchpadButton, detail: number): void => {
    if (pressedButton === button) return;
    if (pressedButton) release(pressedButton);
    pressedButton = button;
    pressedDetail = detail;
    buttons |= BUTTON_MASK[button];
    callbacks.onButton(button, true, point, buttons, detail);
  };

  const stopReleaseTimer = (): void => {
    if (clickReleaseTimer === undefined) return;
    window.clearTimeout(clickReleaseTimer);
    clickReleaseTimer = undefined;
  };

  const finishImmediately = (): void => {
    stopReleaseTimer();
    if (pressedButton) release(pressedButton);
    gestureInProgress = false;
    touchCount = 0;
    pixelsMoved = 0;
    scrolling = false;
    pendingScrollY = 0;
  };

  const clickDetail = (button: TerminalTouchpadButton, now: number): number => {
    if (
      lastClick?.button === button &&
      now - lastClick.at <= CLICK_TIME_MS * 2 &&
      Math.hypot(point.x - lastClick.point.x, point.y - lastClick.point.y) < CLICK_MOVE_THRESHOLD
    ) {
      return Math.min(3, lastClick.detail + 1);
    }
    return 1;
  };

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length === 0) return;
    cancelEvent(event);
    callbacks.onTouchStart?.();

    // The visual viewport can move or shrink between gestures (rotation, split view, or an on-screen keyboard).
    // A physical pointer cannot remain outside its display, so reconcile before even a stationary tap.
    const nextPoint = clampPoint(point, callbacks.bounds());
    if (nextPoint.x !== point.x || nextPoint.y !== point.y) {
      point = nextPoint;
      callbacks.onMove(point, buttons, false);
    }
    const previousTouchCount = touchCount;
    touchCount = Math.min(3, Math.max(touchCount, event.touches.length));

    // A new touch during the delayed release keeps the button held. Moving this new touch therefore produces
    // the same click-and-drag contract as a physical trackpad without needing a separate drag mode.
    stopReleaseTimer();

    if (gestureInProgress) {
      // Mobile browsers normally deliver a second touchstart when the other finger lands. Reset to the new
      // centroid so that finger spacing cannot become a synthetic scroll jump.
      if (event.touches.length !== previousTouchCount) {
        const center = touchCenter(event.touches);
        if (center) {
          lastTouchX = center.x;
          lastTouchY = center.y;
        }
      }
      return;
    }
    const center = touchCenter(event.touches);
    if (!center) return;
    gestureInProgress = true;
    touchCount = Math.min(3, event.touches.length);
    lastTouchX = center.x;
    lastTouchY = center.y;
    lastTouchTime = Date.now();
    pixelsMoved = 0;
    scrolling = false;
    pendingScrollY = 0;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (!gestureInProgress || event.touches.length === 0) return;
    cancelEvent(event);
    const center = touchCenter(event.touches);
    if (!center) return;
    const deltaX = center.x - lastTouchX;
    const deltaY = center.y - lastTouchY;
    pixelsMoved += Math.abs(deltaX) + Math.abs(deltaY);

    if (touchCount === 1 && event.touches.length === 1) {
      // Guacamole's velocity-sensitive scale covers both precise character-cell targeting and long traversals.
      const elapsed = Math.max(1, Date.now() - lastTouchTime);
      const velocity = pixelsMoved / elapsed;
      const scale = 1 + velocity;
      point = clampPoint({ x: point.x + deltaX * scale, y: point.y + deltaY * scale }, callbacks.bounds());
      callbacks.onMove(point, buttons, true);
      callbacks.onGesture?.("move");
      lastTouchX = center.x;
      lastTouchY = center.y;
      return;
    }

    if (touchCount === 2 && event.touches.length === 2) {
      lastTouchX = center.x;
      lastTouchY = center.y;
      pendingScrollY += deltaY;
      if (!scrolling && Math.abs(pendingScrollY) < SCROLL_START_THRESHOLD) return;
      if (!scrolling) {
        scrolling = true;
        callbacks.onGesture?.("scroll");
      }
      if (pendingScrollY === 0) return;
      // Apply natural scrolling: fingers moving down reveal older rows. The gain gives both xterm's native
      // history and mouse-aware provider TUIs enough travel for long conversations on a small phone surface.
      callbacks.onScroll(-pendingScrollY * TOUCHPAD_SCROLL_GAIN, point);
      pendingScrollY = 0;
    }
  };

  const onTouchEnd = (event: TouchEvent): void => {
    if (!gestureInProgress) return;
    cancelEvent(event);
    if (event.touches.length !== 0) return;

    const now = Date.now();
    const button = TOUCH_BUTTON[touchCount];
    if (pressedButton) {
      stopReleaseTimer();
      release(pressedButton);
    }

    if (button && !scrolling && now - lastTouchTime <= CLICK_TIME_MS && pixelsMoved < CLICK_MOVE_THRESHOLD) {
      const detail = clickDetail(button, now);
      press(button, detail);
      callbacks.onGesture?.("tap");
      lastClick = { button, at: now, point: { ...point }, detail };
      clickReleaseTimer = window.setTimeout(() => {
        clickReleaseTimer = undefined;
        release(button, detail);
        gestureInProgress = false;
        touchCount = 0;
        pixelsMoved = 0;
        scrolling = false;
        pendingScrollY = 0;
      }, CLICK_TIME_MS);
      return;
    }

    gestureInProgress = false;
    touchCount = 0;
    pixelsMoved = 0;
    scrolling = false;
    pendingScrollY = 0;
  };

  const onTouchCancel = (event: TouchEvent): void => {
    cancelEvent(event);
    finishImmediately();
  };

  const listenerOptions: AddEventListenerOptions = { passive: false };
  element.addEventListener("touchstart", onTouchStart, listenerOptions);
  element.addEventListener("touchmove", onTouchMove, listenerOptions);
  element.addEventListener("touchend", onTouchEnd, listenerOptions);
  element.addEventListener("touchcancel", onTouchCancel, listenerOptions);

  return () => {
    element.removeEventListener("touchstart", onTouchStart, listenerOptions);
    element.removeEventListener("touchmove", onTouchMove, listenerOptions);
    element.removeEventListener("touchend", onTouchEnd, listenerOptions);
    element.removeEventListener("touchcancel", onTouchCancel, listenerOptions);
    finishImmediately();
  };
}
