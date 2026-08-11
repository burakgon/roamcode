import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright";
import { createServer } from "vite";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const requestedBrowsers = (process.env.RC_MOBILE_BROWSERS ?? "chromium")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const useBundledChromium = process.env.RC_MOBILE_CHROMIUM === "bundled";
const supportedBrowsers = new Set(["chromium", "webkit"]);
for (const name of requestedBrowsers) {
  assert(supportedBrowsers.has(name), `Unsupported RC_MOBILE_BROWSERS entry: ${name}`);
}

const scenes = ["terminal", "codex", "startup", "sessions", "newsession", "files", "ota", "login"];
const profiles = [
  {
    name: "iphone-se",
    device: devices["iPhone 13 Pro"],
    viewport: { width: 320, height: 568 },
  },
  {
    name: "iphone",
    device: devices["iPhone 13 Pro"],
    viewport: { width: 390, height: 664 },
  },
  {
    name: "android",
    device: devices["Pixel 7"],
    viewport: { width: 412, height: 839 },
  },
  {
    name: "iphone-landscape",
    device: devices["iPhone 13 Pro"],
    viewport: { width: 667, height: 375 },
  },
];

const targetSelector = [
  "button:not(.rc-tf__scrim)",
  "a[href]",
  'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"])',
  "select",
  "summary",
  '[role="button"]',
  '[role="menuitem"]',
].join(",");

async function dispatchTouch(locator, type, point) {
  await locator.evaluate(
    (target, event) => {
      const touchInit = {
        identifier: 1,
        target,
        clientX: event.point.x,
        clientY: event.point.y,
        pageX: event.point.x,
        pageY: event.point.y,
        screenX: event.point.x,
        screenY: event.point.y,
      };
      // Chromium exposes the Touch constructor. WebKit keeps it illegal in script but exposes its equivalent
      // createTouch/createTouchList factories, so both engines still receive a real TouchEvent.
      let touch = touchInit;
      let touches = [touch];
      let noTouches = [];
      try {
        touch = new Touch(touchInit);
      } catch {
        touch = document.createTouch(
          window,
          target,
          touchInit.identifier,
          touchInit.pageX,
          touchInit.pageY,
          touchInit.screenX,
          touchInit.screenY,
        );
        touches = document.createTouchList(touch);
        noTouches = document.createTouchList();
      }
      if (Array.isArray(touches)) touches = [touch];
      target.dispatchEvent(
        new TouchEvent(event.type, {
          bubbles: true,
          cancelable: true,
          touches: event.type === "touchend" || event.type === "touchcancel" ? noTouches : touches,
          targetTouches: event.type === "touchend" || event.type === "touchcancel" ? noTouches : touches,
          changedTouches: touches,
        }),
      );
    },
    { type, point },
  );
}

async function dispatchPointer(locator, type, point, pointerId = 7) {
  await locator.evaluate(
    (target, event) => {
      target.dispatchEvent(
        new PointerEvent(event.type, {
          bubbles: true,
          cancelable: true,
          pointerId: event.pointerId,
          pointerType: "touch",
          isPrimary: true,
          buttons: event.type === "pointerup" || event.type === "pointercancel" ? 0 : 1,
          clientX: event.point.x,
          clientY: event.point.y,
        }),
      );
    },
    { type, point, pointerId },
  );
}

async function waitForScene(page, scene) {
  await page.waitForFunction(() => document.body.childElementCount > 0);
  await page.evaluate(() => document.fonts?.ready);
  if (scene === "terminal" || scene === "codex" || scene === "startup") {
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".rc-ghostty-canvas");
      return canvas instanceof HTMLCanvasElement && canvas.getBoundingClientRect().height > 0;
    });
  }
  await page.waitForTimeout(120);
}

async function inspectLayout(page) {
  return page.evaluate((minimumTargetSelector) => {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const description = (element) =>
      element.getAttribute("aria-label") ||
      element.textContent?.trim().replace(/\s+/g, " ").slice(0, 72) ||
      element.tagName.toLowerCase();
    const activeModal = [...document.querySelectorAll('[aria-modal="true"]')].reverse().find(isVisible);
    // A modal intentionally covers and disables the app behind it. Judge the active modal's controls rather
    // than reporting the obscured app surface as an accidental occlusion.
    const inActiveSurface = (element) => !activeModal || activeModal.contains(element);
    const interactive = [
      ...document.querySelectorAll('button,a[href],input,textarea,select,summary,[role="button"],[role="menuitem"]'),
    ]
      .filter(isVisible)
      .filter(inActiveSurface);
    const containers = [
      ...document.querySelectorAll(
        [
          ".rc-picker",
          ".rc-picker__head",
          ".rc-picker__body > section",
          ".rc-picker__foot",
          ".rc-product-page__header",
          ".rc-terminal",
          ".rc-termkeys",
          ".rc-tf__panel",
        ].join(","),
      ),
    ]
      .filter(isVisible)
      .filter(inActiveSurface);
    const outside = [...interactive, ...containers]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -0.5 || rect.right > viewportWidth + 0.5;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${description(element)} [${rect.left.toFixed(1)}, ${rect.right.toFixed(1)}]`;
      });
    const undersized = [...document.querySelectorAll(minimumTargetSelector)]
      .filter(isVisible)
      .filter(inActiveSurface)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width < 43.5 || rect.height < 43.5;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${description(element)} (${rect.width.toFixed(1)}x${rect.height.toFixed(1)})`;
      });
    const occluded = [...document.querySelectorAll(minimumTargetSelector)]
      .filter(isVisible)
      .filter(inActiveSurface)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (x < 0 || x > viewportWidth || y < 0 || y > viewportHeight) return false;
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          const clipsX = style.overflowX !== "visible";
          const clipsY = style.overflowY !== "visible";
          if (!clipsX && !clipsY) continue;
          const ancestorRect = ancestor.getBoundingClientRect();
          if (
            (clipsX && (x < ancestorRect.left || x > ancestorRect.right)) ||
            (clipsY && (y < ancestorRect.top || y > ancestorRect.bottom))
          ) {
            return false;
          }
        }
        const hit = document.elementFromPoint(x, y);
        return !hit || (hit !== element && !element.contains(hit));
      })
      .map(description);
    const clippedLabels = [...document.querySelectorAll('button[aria-label="Refresh agents"]')]
      .filter(isVisible)
      .filter((element) => element.scrollWidth > element.clientWidth)
      .map(description);
    const boundedSurfaces = [
      [document.querySelector(".rc-tf__panel"), document.querySelector(".rc-tf")],
      [
        document.querySelector('[role="dialog"][aria-labelledby="update-title"]'),
        document.querySelector('[role="dialog"][aria-labelledby="update-title"]')?.parentElement,
      ],
    ];
    const verticallyClippedSurfaces = boundedSurfaces
      .filter(([surface, container]) => surface && container && isVisible(surface) && isVisible(container))
      .filter(([surface, container]) => {
        const surfaceRect = surface.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        return surfaceRect.top < containerRect.top - 0.5 || surfaceRect.bottom > containerRect.bottom + 0.5;
      })
      .map(([surface]) => description(surface));
    const terminal = document.querySelector(".rc-terminal");
    const visibleTerminalKeys = [...document.querySelectorAll(".rc-tk__key")].filter(isVisible).length;
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth,
      touchEnvironment:
        matchMedia("(pointer: coarse)").matches && (navigator.maxTouchPoints > 0 || "ontouchstart" in window),
      terminalKeyCount: terminal ? visibleTerminalKeys : null,
      outside,
      undersized,
      occluded,
      clippedLabels,
      verticallyClippedSurfaces,
    };
  }, targetSelector);
}

function assertLayout(report, context) {
  assert.equal(report.touchEnvironment, true, `${context}: the mobile profile lost touch/coarse-pointer emulation`);
  if (report.terminalKeyCount !== null) {
    assert.equal(report.terminalKeyCount, 14, `${context}: the mobile terminal key bar is not fully visible`);
  }
  assert.equal(report.documentWidth, report.viewportWidth, `${context}: document is horizontally scrollable`);
  assert.deepEqual(report.outside, [], `${context}: controls or primary surfaces leave the viewport`);
  assert.deepEqual(report.undersized, [], `${context}: touch targets are smaller than 44px`);
  assert.deepEqual(report.occluded, [], `${context}: visible touch targets are covered at their center`);
  assert.deepEqual(report.clippedLabels, [], `${context}: icon-button labels leak outside their box`);
  assert.deepEqual(report.verticallyClippedSurfaces, [], `${context}: a fixed surface is clipped vertically`);
}

async function openScene(context, baseUrl, scene) {
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Headless engines resolve env(safe-area-inset-bottom) to 0 even under iPhone device emulation. Force the
  // real 34px iPhone inset through the screenshot harness so duplicate safe-area ownership cannot false-pass.
  await page.goto(`${baseUrl}/screenshot.html?scene=${scene}&safeBottom=34`, { waitUntil: "networkidle" });
  await waitForScene(page, scene);
  assert.deepEqual(pageErrors, [], `${scene}: uncaught browser errors`);
  return page;
}

async function createTouchContext(browser, profile) {
  // Some system-Chrome builds ignore touch emulation on the first context created after launch. Reject that
  // context before testing anything; otherwise touch-only UI would be hidden and the test could false-pass.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const context = await browser.newContext({
      ...profile.device,
      viewport: profile.viewport,
      screen: profile.viewport,
    });
    const probe = await context.newPage();
    const touchReady = await probe.evaluate(
      () => matchMedia("(pointer: coarse)").matches && (navigator.maxTouchPoints > 0 || "ontouchstart" in window),
    );
    await probe.close();
    if (touchReady) return context;
    await context.close();
  }
  throw new Error(`${profile.name}: browser would not enable touch/coarse-pointer emulation`);
}

async function exerciseTouchContracts(context, baseUrl, browserName) {
  {
    const page = await openScene(context, baseUrl, "newsession");
    await page.getByRole("button", { name: "Use acme-api", exact: true }).tap();
    await page.getByRole("button", { name: "Pin acme-api", exact: true }).tap();
    await page.getByRole("button", { name: "Clear recent directories" }).tap();
    await page.getByRole("button", { name: "Cancel" }).last().tap();
    assertLayout(await inspectLayout(page), `${browserName}/directory-picker-actions`);
    await page.close();
  }

  {
    const page = await openScene(context, baseUrl, "sessions");
    await page.getByRole("button", { name: "Show details for acme-api" }).tap();
    await page.getByRole("button", { name: "Actions for acme-api" }).tap();
    assertLayout(await inspectLayout(page), `${browserName}/session-row-actions`);
    await page.close();
  }

  {
    const page = await openScene(context, baseUrl, "terminal");
    const escape = page.getByRole("button", { name: "Escape" });
    const escapeBox = await escape.boundingBox();
    assert(escapeBox, `${browserName}: Escape key is unavailable`);
    const escapePoint = { x: escapeBox.x + escapeBox.width / 2, y: escapeBox.y + escapeBox.height / 2 };
    const beforeEscape = await page.evaluate(() => window.__rcScreenshotInputs?.length ?? 0);
    await dispatchPointer(escape, "pointerdown", escapePoint, 31);
    assert.equal(
      await page.evaluate(() => window.__rcScreenshotInputs?.length ?? 0),
      beforeEscape,
      `${browserName}: touching a key must not emit before the press is completed`,
    );
    await dispatchPointer(escape, "pointerup", escapePoint, 31);
    assert.equal(
      await page.evaluate(() => window.__rcScreenshotInputs?.length ?? 0),
      beforeEscape + 1,
      `${browserName}: releasing inside a key must emit exactly once`,
    );

    await dispatchPointer(escape, "pointerdown", escapePoint, 32);
    const canceledPoint = { x: escapeBox.x - 12, y: escapePoint.y };
    await dispatchPointer(escape, "pointermove", canceledPoint, 32);
    await dispatchPointer(escape, "pointerup", canceledPoint, 32);
    assert.equal(
      await page.evaluate(() => window.__rcScreenshotInputs?.length ?? 0),
      beforeEscape + 1,
      `${browserName}: sliding away from an armed key must cancel it`,
    );

    await escape.tap();
    const afterEscape = await page.evaluate(() => window.__rcScreenshotInputs ?? []);
    assert.equal(afterEscape.length, beforeEscape + 2, `${browserName}: a key-bar tap must emit exactly once`);
    assert.equal(afterEscape.at(-1), "\u001b", `${browserName}: Escape must preserve its terminal sequence`);

    await page.evaluate(() => localStorage.removeItem("rc-scroll-hint-learned"));
    const host = page.locator(".rc-terminal__host");
    const hostBox = await host.boundingBox();
    assert(hostBox, `${browserName}: terminal host is missing`);
    const dragStart = { x: hostBox.x + hostBox.width * 0.42, y: hostBox.y + hostBox.height * 0.45 };
    const dragEnd = { x: dragStart.x, y: Math.min(hostBox.y + hostBox.height - 8, dragStart.y + 72) };
    await dispatchTouch(host, "touchstart", dragStart);
    await dispatchTouch(host, "touchmove", dragEnd);
    await dispatchTouch(host, "touchend", dragEnd);
    assert.equal(
      await page.evaluate(() => localStorage.getItem("rc-scroll-hint-learned")),
      "1",
      `${browserName}: one-finger terminal drag was not recognized`,
    );

    const pressPoint = { x: hostBox.x + hostBox.width * 0.68, y: hostBox.y + hostBox.height * 0.34 };
    const terminalInput = page.locator("textarea.rc-ghostty-input");
    await terminalInput.focus();
    await dispatchTouch(host, "touchstart", pressPoint);
    const selectionMenu = page.getByRole("menu", { name: "Mobile terminal clipboard menu" });
    await page.waitForTimeout(470);
    assert.equal(
      await selectionMenu.count(),
      0,
      `${browserName}: long-press actions appeared underneath a finger that is still down`,
    );
    assert.equal(
      await page.locator(".rc-term-touch-selection__handle").count(),
      2,
      `${browserName}: long-press did not acquire a live Ghostty range`,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains("rc-ghostty-input") ?? false),
      true,
      `${browserName}: acquiring text selection collapsed the existing keyboard focus`,
    );
    const touchOwnership = await page.evaluate(() => {
      const host = document.querySelector(".rc-terminal__host");
      const canvas = document.querySelector(".rc-ghostty-canvas");
      if (!(host && canvas)) return null;
      const hostStyle = getComputedStyle(host);
      const canvasStyle = getComputedStyle(canvas);
      return {
        hostTouchAction: hostStyle.touchAction,
        hostUserSelect: hostStyle.userSelect || hostStyle.webkitUserSelect,
        canvasUserSelect: canvasStyle.userSelect || canvasStyle.webkitUserSelect,
      };
    });
    assert.deepEqual(
      touchOwnership,
      { hostTouchAction: "none", hostUserSelect: "none", canvasUserSelect: "none" },
      `${browserName}: the platform can still steal the terminal's held-finger gesture`,
    );
    const contextSuppressed = await host.evaluate((target) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(contextSuppressed, true, `${browserName}: touch long-press leaked a native context menu`);

    const handlesBeforeDrag = await page.evaluate(() =>
      [...document.querySelectorAll(".rc-term-touch-selection__handle")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { name: element.getAttribute("aria-label"), x: rect.x, y: rect.y };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    );
    const selectionDragPoint = {
      x: Math.max(hostBox.x + 12, pressPoint.x - hostBox.width * 0.3),
      y: Math.min(hostBox.y + hostBox.height - 12, pressPoint.y + 18),
    };
    await dispatchTouch(host, "touchmove", selectionDragPoint);
    await page.waitForTimeout(30);
    const handlesAfterDrag = await page.evaluate(() =>
      [...document.querySelectorAll(".rc-term-touch-selection__handle")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { name: element.getAttribute("aria-label"), x: rect.x, y: rect.y };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    );
    assert.notDeepEqual(
      handlesAfterDrag,
      handlesBeforeDrag,
      `${browserName}: moving the still-held finger did not extend the selected range`,
    );
    assert.equal(
      await selectionMenu.count(),
      0,
      `${browserName}: selection actions appeared before the held-finger drag finished`,
    );

    await dispatchTouch(host, "touchend", selectionDragPoint);
    await selectionMenu.waitFor();
    await selectionMenu.getByRole("menuitem", { name: "Select all", exact: true }).waitFor();
    const menuGeometry = await selectionMenu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const viewport = visualViewport;
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        visibleLeft: viewport?.offsetLeft ?? 0,
        visibleRight: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth),
        visibleTop: viewport?.offsetTop ?? 0,
        visibleBottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight),
        actions: [...element.querySelectorAll("button")].map((button) => {
          const buttonRect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            buttonRect.left + buttonRect.width / 2,
            buttonRect.top + buttonRect.height / 2,
          );
          return {
            label: button.textContent?.trim(),
            height: buttonRect.height,
            clipped: button.scrollWidth > button.clientWidth + 0.5,
            usable: hit === button || button.contains(hit),
          };
        }),
      };
    });
    assert(
      menuGeometry.left >= menuGeometry.visibleLeft - 0.5 &&
        menuGeometry.right <= menuGeometry.visibleRight + 0.5 &&
        menuGeometry.top >= menuGeometry.visibleTop - 0.5 &&
        menuGeometry.bottom <= menuGeometry.visibleBottom + 0.5,
      `${browserName}: mobile selection actions leave the visual viewport`,
    );
    assert.equal(menuGeometry.actions.length, 4, `${browserName}: mobile selection actions are incomplete`);
    assert(
      menuGeometry.actions.every((action) => action.height >= 44 && !action.clipped && action.usable),
      `${browserName}: mobile selection action is undersized, clipped, or covered (${JSON.stringify(menuGeometry.actions)})`,
    );
    const markerGeometry = await page.evaluate(() => {
      const read = (edge) => {
        const element = document.querySelector(`.rc-term-touch-selection__handle--${edge}`);
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        const dot = getComputedStyle(element, "::before");
        const stem = getComputedStyle(element, "::after");
        return {
          anchorY: Number.parseFloat(element.style.top),
          centerY: rect.top + rect.height / 2,
          dotTop: Number.parseFloat(dot.top),
          stemTop: Number.parseFloat(stem.top),
        };
      };
      return { start: read("start"), end: read("end") };
    });
    assert(markerGeometry.start && markerGeometry.end, `${browserName}: mobile selection markers are incomplete`);
    assert(
      markerGeometry.end.anchorY - markerGeometry.start.anchorY >= 24,
      `${browserName}: start marker is attached to the bottom of its first row (${JSON.stringify(markerGeometry)})`,
    );
    assert(
      markerGeometry.start.stemTop < markerGeometry.start.dotTop &&
        markerGeometry.end.stemTop > markerGeometry.end.dotTop,
      `${browserName}: selection marker directions are reversed (${JSON.stringify(markerGeometry)})`,
    );
    const selectionPalette = await page.evaluate(() => {
      const canvas = document.querySelector(".rc-ghostty-canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const context = canvas.getContext("2d");
      if (!context) return null;
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      const isSelection = (index) =>
        Math.abs(data[index] - 80) <= 1 && Math.abs(data[index + 1] - 97) <= 1 && Math.abs(data[index + 2] - 122) <= 1;
      let backgroundPixels = 0;
      let readableGlyphPixels = 0;
      for (let y = 2; y < height - 2; y += 1) {
        for (let x = 2; x < width - 2; x += 1) {
          const index = (y * width + x) * 4;
          if (isSelection(index)) {
            backgroundPixels++;
            continue;
          }
          if (data[index] < 230 || data[index + 1] < 230 || data[index + 2] < 230) continue;
          const nearSelection = [
            ((y - 2) * width + x) * 4,
            ((y + 2) * width + x) * 4,
            (y * width + x - 2) * 4,
            (y * width + x + 2) * 4,
          ].some(isSelection);
          if (nearSelection) readableGlyphPixels++;
        }
      }
      return { backgroundPixels, readableGlyphPixels };
    });
    assert(selectionPalette, `${browserName}: selected Ghostty canvas pixels are unavailable`);
    assert(
      selectionPalette.backgroundPixels > 1_000,
      `${browserName}: selected cells do not use the high-contrast field (${JSON.stringify(selectionPalette)})`,
    );
    assert(
      selectionPalette.readableGlyphPixels > 20,
      `${browserName}: selected glyphs are not visibly separated from their field (${JSON.stringify(selectionPalette)})`,
    );

    const outputInjected = await page.evaluate(() => {
      if (typeof window.__rcScreenshotOutput !== "function") return false;
      window.__rcScreenshotOutput("\r\nbackground output while selecting");
      return true;
    });
    assert.equal(outputInjected, true, `${browserName}: screenshot output probe is unavailable`);
    await page.waitForTimeout(80);
    assert.equal(
      await page.locator(".rc-term-touch-selection__handle").count(),
      2,
      `${browserName}: live terminal output dropped the retained selection`,
    );
    assert.equal(
      await selectionMenu.count(),
      1,
      `${browserName}: live terminal output dismissed the active selection actions`,
    );

    const startSlot = page.locator('.rc-term-touch-selection__handle[data-handle-slot="start"]');
    const startSlotBeforeCross = await startSlot.boundingBox();
    const endBeforeCross = await page.locator(".rc-term-touch-selection__handle--end").boundingBox();
    assert(startSlotBeforeCross && endBeforeCross, `${browserName}: selection handles cannot start a crossing drag`);
    const startSlotCenter = {
      x: startSlotBeforeCross.x + startSlotBeforeCross.width / 2,
      y: startSlotBeforeCross.y + startSlotBeforeCross.height / 2,
    };
    const endCenter = {
      x: endBeforeCross.x + endBeforeCross.width / 2,
      y: endBeforeCross.y + endBeforeCross.height / 2,
    };
    const crossingPoint =
      endCenter.x + 64 < hostBox.x + hostBox.width - 12
        ? { x: endCenter.x + 64, y: endCenter.y }
        : {
            x: hostBox.x + Math.min(72, hostBox.width - 12),
            y: Math.min(hostBox.y + hostBox.height - 12, endCenter.y + 28),
          };
    await dispatchPointer(startSlot, "pointerdown", startSlotCenter);
    await selectionMenu.waitFor({ state: "detached" });
    await dispatchPointer(startSlot, "pointermove", crossingPoint);
    const crossedSlotBox = await startSlot.boundingBox();
    assert(crossedSlotBox, `${browserName}: held marker disappeared while crossing the fixed edge`);
    assert.equal(
      await startSlot.getAttribute("aria-label"),
      "Adjust selection end",
      `${browserName}: held marker did not swap semantic edges after crossing`,
    );
    assert(
      Math.hypot(
        crossedSlotBox.x + crossedSlotBox.width / 2 - crossingPoint.x,
        crossedSlotBox.y + crossedSlotBox.height / 2 - crossingPoint.y,
      ) <= 30,
      `${browserName}: held marker jumped away from the finger after crossing`,
    );
    await dispatchPointer(startSlot, "pointerup", crossingPoint);
    await selectionMenu.waitFor();

    const endHandle = page.locator(".rc-term-touch-selection__handle--end");
    const endHandleBox = await endHandle.boundingBox();
    assert(endHandleBox, `${browserName}: end handle is unavailable after long-press release`);
    const handleStart = {
      x: endHandleBox.x + endHandleBox.width / 2,
      y: endHandleBox.y + endHandleBox.height / 2,
    };
    const handleEnd = {
      x: Math.max(hostBox.x + 12, handleStart.x - 48),
      y: Math.max(hostBox.y + 12, handleStart.y - 18),
    };
    await dispatchPointer(endHandle, "pointerdown", handleStart);
    await selectionMenu.waitFor({ state: "detached" });
    await dispatchPointer(endHandle, "pointermove", handleEnd);
    await dispatchPointer(endHandle, "pointerup", handleEnd);
    await selectionMenu.waitFor();
    const movedEndHandleBox = await endHandle.boundingBox();
    assert(movedEndHandleBox, `${browserName}: adjusted end handle disappeared`);
    assert(
      Math.hypot(movedEndHandleBox.x - endHandleBox.x, movedEndHandleBox.y - endHandleBox.y) > 1,
      `${browserName}: dragging a retained selection handle did not change the range`,
    );

    await selectionMenu.getByRole("menuitem", { name: "Done" }).tap();
    await selectionMenu.waitFor({ state: "detached" });
    assertLayout(await inspectLayout(page), `${browserName}/terminal-touch-contracts`);
    await page.close();
  }

  {
    // Open the production TerminalFiles path from the real terminal key bar. The dialog must own the entire
    // app-root stacking plane and keep its photo/file upload footer usable.
    const page = await openScene(context, baseUrl, "terminal");
    await page.getByRole("button", { name: "Files" }).tap();
    const dialog = page.getByRole("dialog", { name: "Terminal files" });
    await dialog.waitFor();
    await page.waitForTimeout(220);
    const geometry = await page.evaluate(() => {
      const root = document.querySelector("#root");
      const modal = document.querySelector(".rc-tf");
      const panel = document.querySelector(".rc-tf__panel");
      const upload = document.querySelector(".rc-tf__upload");
      if (!(root && modal && panel && upload)) return null;
      const rootRect = root.getBoundingClientRect();
      const modalRect = modal.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const uploadRect = upload.getBoundingClientRect();
      const uploadHit = document.elementFromPoint(
        uploadRect.left + uploadRect.width / 2,
        uploadRect.top + uploadRect.height / 2,
      );
      return {
        rootBottom: rootRect.bottom,
        modalTop: modalRect.top,
        modalBottom: modalRect.bottom,
        panelBottom: panelRect.bottom,
        uploadBottom: uploadRect.bottom,
        uploadUsable: Boolean(uploadHit && (uploadHit === upload || upload.contains(uploadHit))),
      };
    });
    assert(geometry, `${browserName}: file dialog geometry is unavailable`);
    assert.equal(geometry.modalTop, 0, `${browserName}: file dialog does not start at the app-root top`);
    assert.equal(
      geometry.modalBottom,
      geometry.rootBottom,
      `${browserName}: file dialog does not cover the app-root plane`,
    );
    assert.equal(
      geometry.panelBottom,
      geometry.rootBottom,
      `${browserName}: file panel is not rooted at the visible bottom`,
    );
    assert(
      geometry.uploadBottom <= geometry.rootBottom + 0.5,
      `${browserName}: file upload action leaves the visible viewport`,
    );
    assert.equal(geometry.uploadUsable, true, `${browserName}: file upload action is covered`);
    assertLayout(await inspectLayout(page), `${browserName}/terminal-files-modal`);
    await page.getByRole("button", { name: "Close files" }).last().tap();
    await page.close();
  }
}

async function exerciseKeyboardViewportContract(context, baseUrl, browserName, expectedWidth) {
  const page = await openScene(context, baseUrl, "codex");
  const lineContinuity = await page.evaluate(() => {
    const canvas = document.querySelector(".rc-ghostty-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const scanHeight = Math.min(canvas.height, Math.ceil(110 * devicePixelRatio));
    const pixels = context.getImageData(0, 0, canvas.width, scanHeight).data;
    const background = [pixels[0], pixels[1], pixels[2]];
    let longest = 0;
    let bestRow = -1;
    for (let y = 0; y < scanHeight; y += 1) {
      let run = 0;
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        const foreground =
          Math.abs(pixels[index] - background[0]) +
            Math.abs(pixels[index + 1] - background[1]) +
            Math.abs(pixels[index + 2] - background[2]) >
          18;
        run = foreground ? run + 1 : 0;
        if (run > longest) {
          longest = run;
          bestRow = y;
        }
      }
    }
    return { longest, width: canvas.width, bestRow };
  });
  assert(lineContinuity, `${browserName}: Ghostty canvas pixels are unavailable`);
  assert(
    lineContinuity.longest / lineContinuity.width > 0.65,
    `${browserName}: TUI box line breaks between canvas cells (longest ${lineContinuity.longest}/${lineContinuity.width})`,
  );

  const closedInsets = await page.evaluate(() => {
    const keybar = document.querySelector(".rc-termkeys");
    const grid = document.querySelector(".rc-termkeys__grid");
    if (!(keybar && grid)) return null;
    const keybarRect = keybar.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    return {
      keybarPaddingBottom: getComputedStyle(keybar).paddingBottom,
      keybarTrailingGap: keybarRect.bottom - gridRect.bottom,
    };
  });
  assert(closedInsets, `${browserName}: keyboard-closed safe-area geometry is unavailable`);
  assert.equal(
    closedInsets.keybarPaddingBottom,
    "37px",
    `${browserName}: terminal key bar does not own the phone safe-area inset`,
  );
  assert(
    closedInsets.keybarTrailingGap >= 36.5 && closedInsets.keybarTrailingGap <= 37.5,
    `${browserName}: terminal key bar safe-area geometry drifted (${closedInsets.keybarTrailingGap}px)`,
  );

  const helper = page.locator("textarea.rc-ghostty-input");
  await helper.focus();
  const installed = await page.evaluate(
    ({ height, width, offsetTop }) =>
      window.__rcSetVisualViewport?.({ height, width, offsetTop, offsetLeft: 0 }) ?? false,
    { height: 420, width: expectedWidth, offsetTop: 34 },
  );
  assert.equal(installed, true, `${browserName}: synthetic iOS visual viewport was not installed`);
  await page.waitForTimeout(50);

  const report = await page.evaluate(() => {
    const root = document.querySelector("#root");
    const keybar = document.querySelector(".rc-termkeys");
    const stage = document.querySelector(".rc-terminal__stage");
    if (!(root && keybar && stage && visualViewport)) return null;
    const rootRect = root.getBoundingClientRect();
    const keybarRect = keybar.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    return {
      activeInput: document.activeElement?.classList.contains("rc-ghostty-input") ?? false,
      rootPosition: getComputedStyle(root).position,
      rootTop: rootRect.top,
      rootBottom: rootRect.bottom,
      rootWidth: rootRect.width,
      visibleTop: visualViewport.offsetTop,
      visibleBottom: visualViewport.offsetTop + visualViewport.height,
      keybarBottom: keybarRect.bottom,
      keybarPaddingBottom: getComputedStyle(keybar).paddingBottom,
      stageHeight: stageRect.height,
      safeBottom: document.documentElement.style.getPropertyValue("--kb-safe-bottom"),
    };
  });
  assert(report, `${browserName}: keyboard-open geometry is unavailable`);
  assert.equal(report.activeInput, true, `${browserName}: Ghostty helper input lost focus`);
  assert.equal(report.rootPosition, "fixed", `${browserName}: keyboard-open root is not visual-viewport anchored`);
  assert.equal(report.rootTop, report.visibleTop, `${browserName}: iOS viewport pan pushes the app header off-screen`);
  assert.equal(
    report.rootBottom,
    report.visibleBottom,
    `${browserName}: an empty strip remains between the app and keyboard`,
  );
  assert.equal(
    report.keybarBottom,
    report.visibleBottom,
    `${browserName}: terminal key bar does not meet the keyboard`,
  );
  assert(report.stageHeight > 0, `${browserName}: terminal canvas collapses while the keyboard is open`);
  assert.equal(report.rootWidth, expectedWidth, `${browserName}: keyboard-open root width drifts`);
  assert.equal(report.safeBottom, "0px", `${browserName}: safe-area padding creates a second keyboard gap`);
  assert.equal(report.keybarPaddingBottom, "3px", `${browserName}: keyboard-open key bar grows a bottom gap`);
  assertLayout(await inspectLayout(page), `${browserName}/keyboard-open-codex`);

  await page.evaluate(
    ({ height, width }) => window.__rcSetVisualViewport?.({ height, width, offsetTop: 0, offsetLeft: 0 }),
    { height: 664, width: expectedWidth },
  );
  await page.waitForTimeout(50);
  const restored = await page.evaluate(() => {
    const root = document.querySelector("#root");
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    const keybar = document.querySelector(".rc-termkeys");
    return {
      position: getComputedStyle(root).position,
      top: rect.top,
      keybarPaddingBottom: keybar ? getComputedStyle(keybar).paddingBottom : "",
    };
  });
  assert.deepEqual(
    restored,
    { position: "relative", top: 0, keybarPaddingBottom: "37px" },
    `${browserName}: keyboard close did not restore the shell`,
  );
  await page.close();
}

async function assertScrollEndReachable(page, scrollerSelector, target, context) {
  const scroller = page.locator(scrollerSelector);
  const before = await scroller.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert(
    before.scrollHeight > before.clientHeight,
    `${context}: the short-screen surface is not independently scrollable`,
  );
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(50);

  const scrollerBox = await scroller.boundingBox();
  const targetBox = await target.boundingBox();
  assert(scrollerBox && targetBox, `${context}: the end target is missing`);
  assert(
    targetBox.y >= scrollerBox.y - 0.5 && targetBox.y + targetBox.height <= scrollerBox.y + scrollerBox.height + 0.5,
    `${context}: the end action cannot be reached by scrolling`,
  );
  const centerIsUsable = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === element || element.contains(hit)));
  });
  assert.equal(centerIsUsable, true, `${context}: the reached end action is covered`);
}

async function exerciseShortViewportContracts(context, baseUrl, browserName) {
  {
    const page = await openScene(context, baseUrl, "login");
    await assertScrollEndReachable(
      page,
      ".rc-login",
      page.getByRole("button", { name: "Connect without a token (local dev)" }),
      `${browserName}/landscape/login`,
    );
    await page.close();
  }

  {
    const page = await openScene(context, baseUrl, "files");
    await assertScrollEndReachable(
      page,
      ".rc-tf__body",
      page.locator(".rc-tf__row").last(),
      `${browserName}/landscape/files`,
    );
    await page.locator(".rc-tf__iconbtn").tap();
    await page.close();
  }

  {
    const page = await openScene(context, baseUrl, "ota");
    const sheet = page.getByRole("dialog", { name: "Update available" });
    assert.equal(
      await sheet.evaluate((element) => element.scrollTop),
      0,
      `${browserName}: OTA sheet opens above its title`,
    );
    await assertScrollEndReachable(
      page,
      '[role="dialog"][aria-labelledby="update-title"]',
      page.getByRole("button", { name: "Update now" }),
      `${browserName}/landscape/ota`,
    );
    await page.close();
  }
}

const vite = await createServer({
  root: webDir,
  clearScreen: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
const address = vite.httpServer?.address();
assert(address && typeof address === "object", "Vite did not expose its isolated test address");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  for (const browserName of requestedBrowsers) {
    const browser =
      browserName === "webkit"
        ? await webkit.launch()
        : await chromium.launch(useBundledChromium ? {} : { channel: "chrome" });
    try {
      for (const profile of profiles) {
        const context = await createTouchContext(browser, profile);
        await context.addInitScript(() => {
          window.__rcScreenshotInputs = [];
          localStorage.setItem("rc-scroll-hint-learned", "1");
          const listeners = new Map();
          const state = {
            height: window.innerHeight,
            width: window.innerWidth,
            offsetTop: 0,
            offsetLeft: 0,
          };
          const viewport = {
            get height() {
              return state.height;
            },
            get width() {
              return state.width;
            },
            get offsetTop() {
              return state.offsetTop;
            },
            get offsetLeft() {
              return state.offsetLeft;
            },
            addEventListener(type, listener) {
              const bucket = listeners.get(type) ?? new Set();
              bucket.add(listener);
              listeners.set(type, bucket);
            },
            removeEventListener(type, listener) {
              listeners.get(type)?.delete(listener);
            },
          };
          try {
            Object.defineProperty(window, "visualViewport", {
              configurable: true,
              value: viewport,
            });
            window.__rcSetVisualViewport = (next) => {
              Object.assign(state, next);
              for (const type of ["resize", "scroll"]) {
                for (const listener of listeners.get(type) ?? []) listener.call(viewport, new Event(type));
              }
              return true;
            };
          } catch {
            window.__rcSetVisualViewport = () => false;
          }
        });
        try {
          for (const scene of scenes) {
            const page = await openScene(context, baseUrl, scene);
            assertLayout(await inspectLayout(page), `${browserName}/${profile.name}/${scene}`);
            await page.close();
          }
          if (profile.name === "iphone") {
            await exerciseTouchContracts(context, baseUrl, browserName);
            await exerciseKeyboardViewportContract(context, baseUrl, browserName, profile.viewport.width);
          }
          if (profile.name === "iphone-landscape") {
            await exerciseShortViewportContracts(context, baseUrl, browserName);
          }
        } finally {
          await context.close();
        }
      }
      console.log(`✓ ${browserName}: mobile layout and touch contracts`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await vite.close();
}
