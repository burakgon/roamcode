/**
 * A relative touchpad gesture translator for the terminal surface.
 *
 * The interaction contract and conservative thresholds follow Apache Guacamole's long-running default touchpad
 * mode: relative one-finger pointer movement, tap-to-click, tap-then-touch drag, two-finger secondary click, and
 * thresholded two-finger wheel input. The browser-facing implementation is local so terminal-specific routing can
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
  onScroll(up: boolean, count: number, point: TerminalTouchpadPoint): void;
  onGesture?(kind: "move" | "scroll" | "tap"): void;
};

const CLICK_TIME_MS = 250;
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
export function installTerminalTouchpad(
  element: HTMLElement,
  callbacks: TerminalTouchpadCallbacks,
  devicePixelRatio = window.devicePixelRatio || 1,
): () => void {
  // These are Apache Guacamole's deliberately conservative CSS-pixel thresholds. Keeping them density-aware
  // prevents high-DPI phone jitter from becoming a click or a stream of wheel ticks.
  const clickMoveThreshold = 10 * Math.max(1, devicePixelRatio);
  const scrollThreshold = 20 * Math.max(1, devicePixelRatio);

  let point = centerOf(callbacks.bounds());
  let touchCount = 0;
  let lastTouchX = 0;
  let lastTouchY = 0;
  let lastTouchTime = 0;
  let pixelsMoved = 0;
  let gestureInProgress = false;
  let buttons = 0;
  let pressedButton: TerminalTouchpadButton | undefined;
  let pressedDetail = 1;
  let clickReleaseTimer: number | undefined;
  let lastClick:
    { button: TerminalTouchpadButton; at: number; point: TerminalTouchpadPoint; detail: number } | undefined;

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
  };

  const clickDetail = (button: TerminalTouchpadButton, now: number): number => {
    if (
      lastClick?.button === button &&
      now - lastClick.at <= CLICK_TIME_MS * 2 &&
      Math.hypot(point.x - lastClick.point.x, point.y - lastClick.point.y) < clickMoveThreshold
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
    touchCount = Math.min(3, Math.max(touchCount, event.touches.length));

    // A new touch during the delayed release keeps the button held. Moving this new touch therefore produces
    // the same click-and-drag contract as a physical trackpad without needing a separate drag mode.
    stopReleaseTimer();

    if (gestureInProgress) return;
    const touch = event.touches[0];
    if (!touch) return;
    gestureInProgress = true;
    touchCount = Math.min(3, event.touches.length);
    lastTouchX = touch.clientX;
    lastTouchY = touch.clientY;
    lastTouchTime = Date.now();
    pixelsMoved = 0;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (!gestureInProgress || event.touches.length === 0) return;
    cancelEvent(event);
    const touch = event.touches[0];
    if (!touch) return;
    const deltaX = touch.clientX - lastTouchX;
    const deltaY = touch.clientY - lastTouchY;
    pixelsMoved += Math.abs(deltaX) + Math.abs(deltaY);

    if (touchCount === 1 && event.touches.length === 1) {
      // Guacamole's velocity-sensitive scale covers both precise character-cell targeting and long traversals.
      const elapsed = Math.max(1, Date.now() - lastTouchTime);
      const velocity = pixelsMoved / elapsed;
      const scale = 1 + velocity;
      point = clampPoint({ x: point.x + deltaX * scale, y: point.y + deltaY * scale }, callbacks.bounds());
      callbacks.onMove(point, buttons, true);
      callbacks.onGesture?.("move");
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
      return;
    }

    if (touchCount === 2 && event.touches.length === 2 && Math.abs(deltaY) >= scrollThreshold) {
      const count = Math.max(1, Math.floor(Math.abs(deltaY) / scrollThreshold));
      // Natural scrolling: fingers moving down move the terminal content down, revealing older rows.
      callbacks.onScroll(deltaY > 0, count, point);
      callbacks.onGesture?.("scroll");
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
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

    if (button && now - lastTouchTime <= CLICK_TIME_MS && pixelsMoved < clickMoveThreshold) {
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
      }, CLICK_TIME_MS);
      return;
    }

    gestureInProgress = false;
    touchCount = 0;
    pixelsMoved = 0;
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
