import { useEffect, useState } from "react";

/**
 * Whether this device/window can host the split-screen workspace: a REAL pointer (hover + fine — i.e. a
 * desktop, per the user's "desktop only" decision) AND enough width for two readable terminals. Phones and
 * jsdom (no matchMedia) return false, so the battle-hardened mobile path is completely untouched — and the
 * existing App tests keep exercising the single-view branch.
 */
const QUERY = "(hover: hover) and (pointer: fine) and (min-width: 900px)";

export function splitCapableNow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** Live-updating variant: shrinking the window below the breakpoint falls back to the single view (the
 *  layout TREE is preserved — only the focused pane renders — and widening restores the full split). */
export function useSplitCapable(): boolean {
  const [capable, setCapable] = useState(() => splitCapableNow());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(QUERY);
    const on = (): void => setCapable(mq.matches);
    // Safari < 14 lacks addEventListener on MediaQueryList; addListener is the legacy spelling.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    }
    mq.addListener(on);
    return () => mq.removeListener(on);
  }, []);
  return capable;
}
