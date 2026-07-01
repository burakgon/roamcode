/**
 * Keep the `--app-height` CSS variable in sync with the VISUAL viewport — the slice of the screen NOT
 * covered by the on-screen keyboard — so the app shell shrinks to the space above the keyboard instead of
 * being overlapped by it.
 *
 * Why this is needed: the layout is `height: 100%` (→ `--app-height`) end-to-end. On iOS Safari the on-screen
 * keyboard OVERLAYS the page — `window.innerHeight`, `100%`, and `100dvh` do NOT shrink — so the bottom of
 * the app (the terminal's cursor line, the chat composer) ends up hidden BEHIND the keyboard, and the user
 * has to manually scroll/drag it into view. `window.visualViewport` reports the true visible height; we
 * mirror it into `--app-height`, which `#root` consumes, so the whole shell (and the terminal host inside it,
 * whose ResizeObserver then refits) collapses to the visible area. On Chrome/Android
 * `interactive-widget=resizes-content` (index.html) already resizes the layout viewport and visualViewport
 * agrees, so the two mechanisms never fight.
 */

/**
 * The height (in CSS px) the app shell should occupy: the visual-viewport height when available (keyboard-
 * aware), else the layout height. Rounded, and floored at 1px so a transient 0 can never collapse the UI.
 * Pure + unit-testable (no DOM).
 */
export function appHeightPx(vv: { height: number } | undefined | null, fallbackHeight: number): number {
  const h = vv?.height;
  const chosen = typeof h === "number" && h > 0 ? h : fallbackHeight;
  return Math.max(1, Math.round(chosen));
}

// ---------------------------------------------------------------------------
// Compositor-freeze heal. iOS standalone PWAs can leave the COMPOSITOR frozen after a layout change that
// coincides with the on-screen keyboard rising: you tap a session, the terminal mounts + focuses (keyboard
// up), yet the SCREEN keeps showing the stale list frame — the DOM and input work, only painting stops. An
// opacity blip on #root forces a recomposite (unlike a display toggle it never blurs the focused terminal).
// The heal is ARMED for a window — re-armed whenever a terminal focuses — so the keyboard-show that follows
// kicks the repaint, then it disarms so there's no steady-state cost.
let repaintArmedUntil = 0;
const nowMs = (): number => (typeof Date !== "undefined" ? Date.now() : 0);

/** Force iOS to recomposite a stale/frozen frame: an imperceptible opacity blip on #root (never blurs focus). */
export function kickRepaint(win: Window = window): void {
  const el = win.document.getElementById("root");
  if (!el) return;
  el.style.opacity = "0.9999";
  win.requestAnimationFrame(() => {
    el.style.opacity = "";
  });
}

/** Arm the freeze-heal for `ms`: the next viewport change (the keyboard rising) then kicks a repaint. Called
 *  at boot AND whenever a terminal focuses — so selecting a session even long after load still un-freezes. */
export function armRepaint(ms = 15_000): void {
  repaintArmedUntil = nowMs() + ms;
}

/**
 * Start mirroring the visual viewport into `--app-height` and return a disposer. Idempotent-safe to call
 * once at boot (the returned disposer is only needed by tests). Degrades gracefully: with no
 * `visualViewport` (old browsers) it sets the current layout height once and simply never updates — the
 * `100%` fallback in CSS already covers that case.
 */
export function installViewportSync(win: Window = window): () => void {
  const rootEl = win.document.documentElement;
  const vv = win.visualViewport ?? undefined;
  let raf = 0;
  // Arm the compositor-freeze heal (kickRepaint / armRepaint above) for the post-boot window. TerminalView
  // re-arms it whenever it focuses, so selecting a session even long after boot still un-freezes iOS.
  armRepaint();
  const apply = (): void => {
    raf = 0;
    rootEl.style.setProperty("--app-height", `${appHeightPx(vv, win.innerHeight)}px`);
    // When the on-screen keyboard is UP, the shell is sized to the visual viewport so the key bar already
    // sits ABOVE the keyboard — the bottom safe-area inset then becomes dead space ("the gap"). Zero it out
    // while the keyboard is open; restore the real inset otherwise. Consumers read var(--kb-safe-bottom).
    const kbOpen = !!vv && win.innerHeight - vv.height > 120;
    rootEl.style.setProperty("--kb-safe-bottom", kbOpen ? "0px" : "env(safe-area-inset-bottom, 0px)");
    if (nowMs() < repaintArmedUntil) kickRepaint(win);
  };
  const schedule = (): void => {
    // Coalesce the burst of resize/scroll events the keyboard animation fires into one write per frame.
    if (raf) return;
    raf = win.requestAnimationFrame(apply);
  };
  const onShow = (): void => {
    // After an in-place OTA navigation the page can come back hit-test-desynced OR paint-frozen (see above).
    // Reset any phantom document scroll (realigns hit-testing), kick a repaint (un-freezes the compositor),
    // and re-sync the height. `pageshow` fires on the initial load, a reload/replace, AND a bfcache restore,
    // so this heals "first open after OTA" without a manual reopen.
    try {
      win.scrollTo(0, 0);
    } catch {
      /* no scrollTo (jsdom) — ignore */
    }
    kickRepaint(win);
    schedule();
  };
  apply(); // set immediately so the very first paint is already keyboard-aware
  if (vv) {
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
  }
  win.addEventListener("orientationchange", schedule);
  win.addEventListener("pageshow", onShow);
  return () => {
    if (raf) win.cancelAnimationFrame(raf);
    if (vv) {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
    }
    win.removeEventListener("orientationchange", schedule);
    win.removeEventListener("pageshow", onShow);
  };
}
