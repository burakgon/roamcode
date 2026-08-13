import { useEffect, useRef, type RefObject } from "react";

const INTENT_DISTANCE_PX = 8;
const COMMIT_DISTANCE_PX = 46;
const FAST_COMMIT_DISTANCE_PX = 28;
const FAST_SWIPE_PX_PER_MS = 0.34;
const CLICK_SUPPRESSION_MS = 550;

interface SessionSwipeOptions {
  /** Called as soon as horizontal intent wins, before touch/pointer release. Toolbars use this to cancel
   * an armed key so the same finger cannot both change session and type into the terminal. */
  onHorizontalIntent?: () => void;
}

/**
 * Install a single-finger, horizontally dominant session swipe on compact mobile chrome.
 * Left advances, right goes back. Vertical movement is never captured, and the click which
 * browsers synthesize after a completed swipe is suppressed so a title/key below the finger
 * is not accidentally activated while the session changes.
 */
export function useSessionSwipe<T extends HTMLElement>(
  onPrevious?: () => void,
  onNext?: () => void,
  options: SessionSwipeOptions = {},
): RefObject<T | null> {
  const ref = useRef<T>(null);
  const callbacks = useRef({ onPrevious, onNext, onHorizontalIntent: options.onHorizontalIntent });
  callbacks.current = { onPrevious, onNext, onHorizontalIntent: options.onHorizontalIntent };
  const enabled = Boolean(onPrevious || onNext);

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;

    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let tracking = false;
    let horizontal = false;
    let suppressClicksUntil = 0;

    const reset = () => {
      tracking = false;
      horizontal = false;
    };
    const start = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        reset();
        return;
      }
      startX = touch.clientX;
      startY = touch.clientY;
      startedAt = performance.now();
      tracking = true;
      horizontal = false;
    };
    const move = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (!horizontal && Math.abs(dx) >= INTENT_DISTANCE_PX) {
        if (Math.abs(dx) <= Math.abs(dy) * 1.2) {
          reset();
          return;
        }
        horizontal = true;
        callbacks.current.onHorizontalIntent?.();
      }
      if (horizontal && event.cancelable) event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      if (!tracking) return;
      const touch = event.changedTouches[0];
      const elapsed = Math.max(1, performance.now() - startedAt);
      const dx = touch ? touch.clientX - startX : 0;
      const dy = touch ? touch.clientY - startY : 0;
      const dominant = Math.abs(dx) > Math.abs(dy) * 1.2;
      const committed =
        horizontal &&
        dominant &&
        (Math.abs(dx) >= COMMIT_DISTANCE_PX ||
          (Math.abs(dx) >= FAST_COMMIT_DISTANCE_PX && Math.abs(dx) / elapsed >= FAST_SWIPE_PX_PER_MS));
      reset();
      if (!committed) return;
      suppressClicksUntil = performance.now() + CLICK_SUPPRESSION_MS;
      if (event.cancelable) event.preventDefault();
      if (dx < 0) callbacks.current.onNext?.();
      else callbacks.current.onPrevious?.();
    };
    const cancel = () => reset();
    const suppressClick = (event: MouseEvent) => {
      if (performance.now() > suppressClicksUntil) return;
      event.preventDefault();
      event.stopPropagation();
    };

    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end, { passive: false });
    element.addEventListener("touchcancel", cancel, { passive: true });
    element.addEventListener("click", suppressClick, true);
    return () => {
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", cancel);
      element.removeEventListener("click", suppressClick, true);
    };
  }, [enabled]);

  return ref;
}
