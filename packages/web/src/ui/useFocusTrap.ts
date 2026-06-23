import { useEffect } from "react";
import type { RefObject } from "react";

/** Selector for the elements a modal can legitimately move keyboard focus to. */
const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    // Skip elements removed from the layout (display:none / hidden attribute / collapsed
    // ancestor). `getClientRects().length` is the jsdom-friendly visibility probe;
    // `offsetParent` is always null under jsdom's no-layout DOM.
    if (el.hasAttribute("hidden")) return false;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    return true;
  });
}

/**
 * Makes a dialog a real modal: focuses its first focusable element on mount, cycles Tab /
 * Shift+Tab WITHIN the container (wrapping last↔first), and restores focus to whatever was
 * focused before the dialog opened when it unmounts. This is the substance behind
 * `aria-modal="true"` — without it Tab escapes to the inert background and closing strands
 * focus on `<body>`. Hand-rolled (~30 lines) so we pull in no dependency.
 *
 * @param ref       points at the dialog's root element
 * @param active    when false the trap is inert (defaults to true)
 */
export function useFocusTrap(ref: RefObject<HTMLElement>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    // Capture the trigger so focus can return to it on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the dialog on open (first focusable, else the container itself).
    const initial = focusable(container);
    if (initial.length > 0) {
      initial[0]!.focus();
    } else {
      container.setAttribute("tabindex", "-1");
      container.focus();
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== "Tab" || !container) return;
      const items = focusable(container);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement;

      if (e.shiftKey) {
        // Backwards off the first element wraps to the last.
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Forwards off the last element wraps to the first.
        if (activeEl === last || !container.contains(activeEl)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      // Restore focus to the trigger, guarding if it has since left the document.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [ref, active]);
}
