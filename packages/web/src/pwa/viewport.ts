/**
 * Keep the full-screen shell inside the browser's visual viewport.
 *
 * `interactive-widget=resizes-content` is the preferred Android path, but it is not honoured by every
 * WebView/PWA version. iOS always reports the unobscured rectangle through `visualViewport`. Using that
 * rectangle unconditionally gives both platforms one contract: the terminal, key bar and composer are laid
 * out only in pixels that are actually visible above the software keyboard.
 */

/** The visible shell height, rounded and protected against transient zero-sized viewport reports. */
export function appHeightPx(vv: { height: number } | undefined | null, fallbackHeight: number): number {
  const height = vv?.height;
  const visible = typeof height === "number" && height > 0 ? height : undefined;
  const layout = fallbackHeight > 0 ? fallbackHeight : undefined;
  // visualViewport may briefly retain its pre-meta/pre-rotation size while innerHeight has already settled.
  // The unobscured area cannot legitimately be taller than the layout viewport, so choose the smaller report.
  const chosen = visible !== undefined && layout !== undefined ? Math.min(visible, layout) : (visible ?? layout ?? 1);
  return Math.max(1, Math.round(chosen));
}

type VirtualKeyboardNavigator = Navigator & {
  virtualKeyboard?: { overlaysContent: boolean };
};

function editableElement(element: Element | null): boolean {
  if (!element) return false;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )
    return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * Mirror the exact visual viewport rectangle into CSS variables and return a disposer for tests. The shell
 * remains fixed to that rectangle even when Safari pans the visual viewport to keep a focused input visible.
 */
export function installViewportSync(win: Window = window): () => void {
  const rootEl = win.document.documentElement;
  const vv = win.visualViewport ?? undefined;
  let raf = 0;
  let largestVisibleHeight = appHeightPx(vv, win.innerHeight);
  let largestLayoutHeight = Math.max(1, win.innerHeight);

  // Chrome exposes an explicit keyboard overlay policy. Prefer layout resizing when available, while still
  // using visualViewport below as the source of truth for older Android versions that ignore the policy.
  try {
    const virtualKeyboard = (win.navigator as VirtualKeyboardNavigator | undefined)?.virtualKeyboard;
    if (virtualKeyboard) virtualKeyboard.overlaysContent = false;
  } catch {
    /* A browser may expose a read-only implementation; visualViewport remains sufficient. */
  }

  const apply = (): void => {
    raf = 0;
    const visibleHeight = appHeightPx(vv, win.innerHeight);
    const visualWidth = vv?.width && vv.width > 0 ? vv.width : undefined;
    const layoutWidth = win.innerWidth > 0 ? win.innerWidth : rootEl.clientWidth || undefined;
    const visibleWidth = Math.max(
      1,
      Math.round(
        visualWidth !== undefined && layoutWidth !== undefined
          ? Math.min(visualWidth, layoutWidth)
          : (visualWidth ?? layoutWidth ?? 1),
      ),
    );
    const top = Math.max(0, Math.round(vv?.offsetTop || 0));
    const left = Math.max(0, Math.round(vv?.offsetLeft || 0));

    largestVisibleHeight = Math.max(largestVisibleHeight, visibleHeight);
    largestLayoutHeight = Math.max(largestLayoutHeight, win.innerHeight);
    const layoutGap = vv ? Math.max(0, win.innerHeight - vv.height) : 0;
    const baselineGap = Math.max(0, largestVisibleHeight - visibleHeight);
    const layoutShrink = Math.max(0, largestLayoutHeight - win.innerHeight);
    // Android with resizes-content commonly shrinks innerHeight and visualViewport together, so the old
    // `innerHeight - vv.height` check missed the keyboard. A focused editable plus the closed-height baseline
    // catches that path; layoutGap retains the iOS overlay path.
    const keyboardOpen = layoutGap > 80 || (baselineGap > 80 && editableElement(win.document.activeElement));

    rootEl.style.setProperty("--app-height", `${visibleHeight}px`);
    // Android/Chromium's resizes-content path already shrinks the layout viewport. Keeping the app root fixed
    // to a visual-viewport offset in that mode applies a second keyboard translation: the terminal jumps up
    // while its bottom prompt remains below the keyboard. Let the resized layout own positioning there. iOS
    // and overlay-keyboard browsers leave the layout viewport tall, so they still need the exact fixed visual
    // rectangle and its pan offsets.
    const layoutOwnsKeyboard = keyboardOpen && layoutShrink > 80;
    rootEl.style.setProperty("--app-position", layoutOwnsKeyboard ? "relative" : "fixed");
    rootEl.style.setProperty("--app-top", layoutOwnsKeyboard ? "0px" : `${top}px`);
    rootEl.style.setProperty("--app-left", layoutOwnsKeyboard ? "0px" : `${left}px`);
    rootEl.style.setProperty("--app-width", layoutOwnsKeyboard ? "100%" : `${visibleWidth}px`);
    rootEl.style.setProperty(
      "--kb-safe-bottom",
      keyboardOpen ? "0px" : "var(--safe-area-bottom, env(safe-area-inset-bottom, 0px))",
    );
  };
  const schedule = (): void => {
    if (raf) return;
    raf = win.requestAnimationFrame(apply);
  };
  const onOrientationChange = (): void => {
    largestVisibleHeight = appHeightPx(vv, win.innerHeight);
    largestLayoutHeight = Math.max(1, win.innerHeight);
    schedule();
  };
  const onShow = (): void => {
    // A bfcache restore can retain stale viewport variables. Re-read geometry without forcing a document
    // scroll or an opacity transition, both of which interfere with native scroll compositing.
    schedule();
  };

  apply();
  if (vv) {
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
  }
  win.addEventListener("resize", schedule);
  win.addEventListener("orientationchange", onOrientationChange);
  win.addEventListener("pageshow", onShow);
  return () => {
    if (raf) win.cancelAnimationFrame(raf);
    rootEl.style.removeProperty("--app-height");
    rootEl.style.removeProperty("--kb-safe-bottom");
    rootEl.style.removeProperty("--app-position");
    rootEl.style.removeProperty("--app-top");
    rootEl.style.removeProperty("--app-left");
    rootEl.style.removeProperty("--app-width");
    if (vv) {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
    }
    win.removeEventListener("resize", schedule);
    win.removeEventListener("orientationchange", onOrientationChange);
    win.removeEventListener("pageshow", onShow);
  };
}
