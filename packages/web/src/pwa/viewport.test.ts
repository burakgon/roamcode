import { afterEach, expect, test, vi } from "vitest";
import { appHeightPx, installViewportSync } from "./viewport";

test("appHeightPx prefers the visual-viewport height and protects against zero", () => {
  expect(appHeightPx({ height: 380.6 }, 844)).toBe(381);
  expect(appHeightPx(undefined, 844)).toBe(844);
  expect(appHeightPx({ height: 0 }, 844)).toBe(844);
  expect(appHeightPx({ height: 980 }, 568)).toBe(568);
  expect(appHeightPx({ height: 0 }, 0)).toBe(1);
});

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function viewportFixture(options: {
  height: number;
  width?: number;
  innerHeight?: number;
  activeElement?: HTMLElement;
}) {
  const viewportListeners: Record<string, () => void> = {};
  const windowListeners: Record<string, () => void> = {};
  const virtualKeyboard = { overlaysContent: true };
  const vv = {
    height: options.height,
    width: options.width ?? 390,
    offsetTop: 0,
    offsetLeft: 0,
    addEventListener: (type: string, listener: () => void) => {
      viewportListeners[type] = listener;
    },
    removeEventListener: vi.fn(),
  };
  if (options.activeElement) document.body.appendChild(options.activeElement);
  const fakeWindow = {
    document,
    navigator: { virtualKeyboard },
    innerHeight: options.innerHeight ?? options.height,
    innerWidth: options.width ?? 390,
    visualViewport: vv,
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
    addEventListener: (type: string, listener: () => void) => {
      windowListeners[type] = listener;
    },
    removeEventListener: vi.fn(),
  } as unknown as Window;
  return { fakeWindow, viewportListeners, virtualKeyboard, vv, windowListeners };
}

test("uses the exact visual viewport rectangle even while the keyboard is closed", () => {
  const { fakeWindow, virtualKeyboard } = viewportFixture({ height: 844, width: 390 });

  const dispose = installViewportSync(fakeWindow);

  expect(virtualKeyboard.overlaysContent).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("844px");
  expect(document.documentElement.style.getPropertyValue("--app-position")).toBe("fixed");
  expect(document.documentElement.style.getPropertyValue("--app-width")).toBe("390px");
  expect(document.documentElement.style.getPropertyValue("--kb-safe-bottom")).toContain("--safe-area-bottom");
  dispose();
  expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
});

test("Android keyboard resize shrinks the shell even when innerHeight and visualViewport match", () => {
  const input = document.createElement("textarea");
  const { fakeWindow, viewportListeners, vv } = viewportFixture({ height: 844, activeElement: input });
  const dispose = installViewportSync(fakeWindow);

  input.focus();
  vv.height = 380;
  Object.defineProperty(fakeWindow, "innerHeight", { configurable: true, value: 380 });
  viewportListeners.resize?.();

  expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("380px");
  expect(document.documentElement.style.getPropertyValue("--kb-safe-bottom")).toBe("0px");
  dispose();
});

test("mirrors visual-viewport pan offsets without scrolling or opacity repaint tricks", () => {
  const { fakeWindow, viewportListeners, vv } = viewportFixture({ height: 844 });
  const scrollTo = vi.fn();
  Object.assign(fakeWindow, { scrollTo });
  const dispose = installViewportSync(fakeWindow);

  vv.height = 420;
  vv.offsetTop = 31;
  vv.offsetLeft = 4;
  viewportListeners.resize?.();

  expect(document.documentElement.style.getPropertyValue("--app-top")).toBe("31px");
  expect(document.documentElement.style.getPropertyValue("--app-left")).toBe("4px");
  expect(scrollTo).not.toHaveBeenCalled();
  dispose();
});
