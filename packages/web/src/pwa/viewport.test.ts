import { afterEach, expect, test, vi } from "vitest";
import { appHeightPx, installViewportSync } from "./viewport";

test("appHeightPx prefers the visual-viewport height (keyboard-aware)", () => {
  // Keyboard open: visualViewport is shorter than the layout — use the shorter, visible height.
  expect(appHeightPx({ height: 380.6 }, 844)).toBe(381);
});

test("appHeightPx falls back to the layout height when visualViewport is missing or zero", () => {
  expect(appHeightPx(undefined, 844)).toBe(844);
  expect(appHeightPx(null, 844)).toBe(844);
  expect(appHeightPx({ height: 0 }, 844)).toBe(844);
});

test("appHeightPx never returns below 1px", () => {
  expect(appHeightPx({ height: 0 }, 0)).toBe(1);
});

afterEach(() => {
  document.documentElement.style.removeProperty("--app-height");
  document.documentElement.style.removeProperty("--kb-safe-bottom");
  vi.restoreAllMocks();
});

test("installViewportSync writes --app-height and updates on a visualViewport resize", () => {
  const listeners: Record<string, () => void> = {};
  const vv = {
    height: 844,
    addEventListener: (ev: string, cb: () => void) => {
      listeners[ev] = cb;
    },
    removeEventListener: vi.fn(),
  };
  const fakeWin = {
    document: document,
    innerHeight: 844,
    visualViewport: vv,
    requestAnimationFrame: (cb: () => void) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Window;

  const dispose = installViewportSync(fakeWin);
  // Keyboard closed → the shell is the FULL screen (100dvh, covers the home-indicator inset); the real safe-area
  // inset is kept on the key bar (--kb-safe-bottom) to lift the keys above the home bar.
  expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("100dvh");
  expect(document.documentElement.style.getPropertyValue("--kb-safe-bottom")).toBe("env(safe-area-inset-bottom, 0px)");

  // Simulate the keyboard opening: visual viewport shrinks, resize fires.
  vv.height = 380;
  listeners.resize?.();
  expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("380px");
  // Keyboard up: the bottom inset is zeroed so the key bar has no dead gap beneath it.
  expect(document.documentElement.style.getPropertyValue("--kb-safe-bottom")).toBe("0px");

  dispose();
});

test("installViewportSync resets scroll + re-syncs on pageshow (iOS post-reload hit-test realign)", () => {
  const winListeners: Record<string, () => void> = {};
  const vv = { height: 844, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const scrollTo = vi.fn();
  const fakeWin = {
    document: document,
    innerHeight: 844,
    visualViewport: vv,
    requestAnimationFrame: (cb: () => void) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
    scrollTo,
    addEventListener: (ev: string, cb: () => void) => {
      winListeners[ev] = cb;
    },
    removeEventListener: vi.fn(),
  } as unknown as Window;

  const dispose = installViewportSync(fakeWin);
  // Stale the value so we can prove pageshow re-applies it (a real post-reload desync leaves it wrong).
  document.documentElement.style.setProperty("--app-height", "1px");
  // A small visual-viewport shrink (44px < the 120px keyboard threshold) is the home-indicator inset, NOT the
  // keyboard → treated as keyboard-CLOSED, so the shell is the full screen (100dvh), covering the inset.
  vv.height = 800;
  winListeners.pageshow?.();
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
  expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("100dvh");

  dispose();
});

test("installViewportSync kicks a repaint (opacity blip on #root) to un-freeze iOS's compositor", () => {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  let rafCb: (() => void) | undefined;
  const fakeWin = {
    document: document,
    innerHeight: 844,
    visualViewport: undefined,
    requestAnimationFrame: (cb: () => void) => {
      rafCb = cb;
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
    scrollTo: vi.fn(),
    setTimeout: () => 0, // never disarm during the test
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Window;

  installViewportSync(fakeWin); // the initial apply() kicks the blip while armed
  expect(root.style.opacity).toBe("0.9999");
  rafCb?.(); // next frame clears it — imperceptible
  expect(root.style.opacity).toBe("");

  document.body.removeChild(root);
});
