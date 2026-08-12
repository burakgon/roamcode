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
      const points = Array.isArray(event.point) ? event.point : [event.point];
      const touchInits = points.map((point, index) => ({
        identifier: index + 1,
        target,
        clientX: point.x,
        clientY: point.y,
        pageX: point.x,
        pageY: point.y,
        screenX: point.x,
        screenY: point.y,
      }));
      // Chromium exposes the Touch constructor. WebKit keeps it illegal in script but exposes its equivalent
      // createTouch/createTouchList factories, so both engines still receive a real TouchEvent.
      let touches = touchInits;
      let noTouches = [];
      try {
        touches = touchInits.map((touch) => new Touch(touch));
      } catch {
        touches = touchInits.map((touch) =>
          document.createTouch(
            window,
            target,
            touch.identifier,
            touch.pageX,
            touch.pageY,
            touch.screenX,
            touch.screenY,
          ),
        );
        touches = document.createTouchList(...touches);
        noTouches = document.createTouchList();
      }
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

async function waitForHostClipboardWrites(page, minimum) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (page.__rcHostClipboardWrites.length >= minimum) return;
    await page.waitForTimeout(20);
  }
  throw new Error(`host clipboard write count never reached ${minimum}`);
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
      // The terminal bar deliberately compresses eight controls into one row; height and per-control width
      // carry a dedicated geometry contract below. The opened D-pad is checked separately at full 44x44.
      .filter((element) => !element.classList.contains("rc-tk__key"))
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
    const compactHeaderGeometry = (() => {
      const header = document.querySelector(".rc-chat-header");
      if (!(header instanceof HTMLElement) || !isVisible(header)) return null;
      const style = getComputedStyle(header);
      const paddingTop = Number.parseFloat(style.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
      const meta = header.querySelector(".rc-hdr-meta");
      return {
        rowHeight: header.clientHeight - paddingTop - paddingBottom,
        paddingBottom,
        metaVisible: meta instanceof HTMLElement && isVisible(meta),
      };
    })();
    const visibleTerminalKeys = [...document.querySelectorAll(".rc-tk__key")].filter(isVisible).length;
    const terminalKeyGeometry = (() => {
      if (!terminal) return null;
      const grid = document.querySelector(".rc-termkeys__grid");
      if (!(grid instanceof HTMLElement)) return null;
      const readRect = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          layoutWidth: element.offsetWidth,
          layoutHeight: element.offsetHeight,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2,
        };
      };
      const byLabel = (label) => readRect(document.querySelector(`.rc-tk__key[aria-label="${label}"]`));
      return {
        grid: readRect(grid),
        primary: [
          "Control (sticky)",
          "Escape",
          "Tab",
          "Arrow keys",
          "Paste clipboard",
          "Files",
          "Chat input",
          "Show keyboard",
        ].map(byLabel),
        keys: [...grid.querySelectorAll(".rc-tk__key")].filter(isVisible).map(readRect),
      };
    })();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth,
      touchEnvironment:
        matchMedia("(pointer: coarse)").matches && (navigator.maxTouchPoints > 0 || "ontouchstart" in window),
      compactHeaderGeometry,
      terminalKeyCount: terminal ? visibleTerminalKeys : null,
      terminalKeyGeometry,
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
  if (report.compactHeaderGeometry) {
    assert(
      report.compactHeaderGeometry.rowHeight >= 43.5 && report.compactHeaderGeometry.rowHeight <= 44.5,
      `${context}: session header is not one compact touch row (${JSON.stringify(report.compactHeaderGeometry)})`,
    );
    assert(
      report.compactHeaderGeometry.paddingBottom <= 0.5,
      `${context}: session header regained decorative bottom padding (${JSON.stringify(report.compactHeaderGeometry)})`,
    );
    assert.equal(
      report.compactHeaderGeometry.metaVisible,
      false,
      `${context}: mobile session metadata should collapse into the compact header`,
    );
  }
  if (report.terminalKeyCount !== null) {
    assert.equal(report.terminalKeyCount, 8, `${context}: the compact mobile terminal key bar is not fully visible`);
    const geometry = report.terminalKeyGeometry;
    assert(geometry?.grid, `${context}: terminal key geometry is unavailable`);
    assert(
      geometry.grid.height >= 49.5 && geometry.grid.height <= 50.5,
      `${context}: terminal toolbar is not a single compact row (${JSON.stringify(geometry.grid)})`,
    );
    assert(
      geometry.primary.every((key) => key && key.layoutWidth >= 33.5 && key.layoutHeight >= 43.5),
      `${context}: a primary compact key is unusably small (${JSON.stringify(geometry.primary)})`,
    );
    assert(
      geometry.primary.every((key, index, keys) => index === 0 || keys[index - 1].right <= key.left + 0.5),
      `${context}: terminal toolbar no longer follows the Moshi-style key/utility order (${JSON.stringify(geometry.primary)})`,
    );
    assert(
      geometry.keys.every(
        (key) =>
          key &&
          key.left >= geometry.grid.left - 0.5 &&
          key.right <= geometry.grid.right + 0.5 &&
          key.top >= geometry.grid.top - 0.5 &&
          key.bottom <= geometry.grid.bottom + 0.5,
      ),
      `${context}: a compact terminal key leaves its single row`,
    );
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
  page.__rcHostClipboardWrites = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Observe the payload after RoamCode's copy handler has populated the real browser event. This proves the
  // device/browser half of copy-on-select independently from the mocked host endpoint and survives page reloads.
  await page.addInitScript(() => {
    window.__rcDeviceClipboardWrites = [];
    document.addEventListener("copy", (event) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text) window.__rcDeviceClipboardWrites.push(text);
    });
  });
  // Screenshot terminals use a synthetic socket, but completed selections and explicit native Copy must still
  // reach the host clipboard endpoint. Record the authenticated API shape and exact request count so a browser
  // copy event cannot accidentally mirror the same selection twice.
  await page.route("**/api/v1/sessions/*/clipboard", async (route) => {
    page.__rcHostClipboardWrites.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ copied: true, target: "host" }),
    });
  });
  // Headless engines resolve env(safe-area-inset-bottom) to 0 even under iPhone device emulation. Force the
  // real 34px iPhone inset through the screenshot harness so duplicate safe-area ownership cannot false-pass.
  await page.goto(`${baseUrl}/screenshot.html?scene=${scene}&safeBottom=34`, { waitUntil: "networkidle" });
  // addInitScript runs before the page's mobile viewport meta tag is parsed, when Chromium still reports its
  // 980px fallback layout viewport. Seed the visualViewport test double again from the settled page dimensions.
  await page.evaluate(() =>
    window.__rcSetVisualViewport?.({ height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0 }),
  );
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

async function exerciseDesktopClipboardContract(browser, baseUrl, browserName) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseUrl).origin });
  try {
    const page = await openScene(context, baseUrl, "terminal");
    const injected = await page.evaluate(() => {
      if (typeof window.__rcScreenshotOutput !== "function") return false;
      const row = "desktop_clipboard_probe ".repeat(10);
      window.__rcScreenshotOutput(`\u001b[2J\u001b[H${Array.from({ length: 60 }, () => row).join("\r\n")}`);
      return true;
    });
    assert.equal(injected, true, `${browserName}: desktop clipboard probe is unavailable`);
    await page.waitForTimeout(80);
    const host = page.locator(".rc-terminal__host");
    const hostBox = await host.boundingBox();
    assert(hostBox, `${browserName}: desktop clipboard terminal is missing`);
    await page.mouse.click(hostBox.x + 140, hostBox.y + 110, { button: "right" });
    await waitForHostClipboardWrites(page, 1);
    assert(
      page.__rcHostClipboardWrites.some(({ text }) => text?.includes("desktop_clipboard_probe")),
      `${browserName}: finishing a physical-mouse selection never reached the host clipboard endpoint`,
    );
    assert(
      await page.evaluate(() =>
        window.__rcDeviceClipboardWrites.some((text) => text.includes("desktop_clipboard_probe")),
      ),
      `${browserName}: finishing a physical-mouse selection never populated the browser copy event`,
    );
    if (browserName === "chromium") {
      assert(
        (await page.evaluate(() => navigator.clipboard.readText())).includes("desktop_clipboard_probe"),
        `${browserName}: finishing a physical-mouse selection never changed the device clipboard`,
      );
    }
    assert.equal(
      await page.locator(".rc-term-copy-notice, .rc-term-touch-selection__menu").count(),
      0,
      `${browserName}: selecting terminal text mounted custom clipboard chrome`,
    );
    await page.close();
  } finally {
    await context.close();
  }
}

async function exerciseTouchContracts(context, baseUrl, browserName) {
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseUrl).origin });
  }
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
    await page.getByRole("button", { name: "Actions for acme-api" }).tap();
    await page.getByRole("button", { name: "Show details for acme-api" }).tap();
    await page.getByRole("button", { name: "Actions for acme-api" }).tap();
    assertLayout(await inspectLayout(page), `${browserName}/session-row-actions`);
    await page.close();
  }

  {
    const page = await openScene(context, baseUrl, "terminal");
    const sessionsTrigger = page.getByRole("button", { name: /Show sessions/ });
    const sessionsTriggerBox = await sessionsTrigger.boundingBox();
    assert(sessionsTriggerBox, `${browserName}: the mobile rail trigger is not visible`);
    assert(
      sessionsTriggerBox.width >= 43.5 && sessionsTriggerBox.height >= 43.5,
      `${browserName}: the mobile rail trigger lost its touch target (${JSON.stringify(sessionsTriggerBox)})`,
    );
    assert.equal(
      await sessionsTrigger.evaluate((button) => getComputedStyle(button).backgroundColor),
      "rgba(0, 0, 0, 0)",
      `${browserName}: the restored mobile rail trigger regained a visible tile`,
    );
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

    const terminalInput = page.locator("textarea.rc-ghostty-input");
    assert.equal(
      await terminalInput.evaluate((target) => document.activeElement === target),
      false,
      `${browserName}: the touch terminal focused itself before an explicit keyboard request`,
    );
    const terminalCanvas = page.locator(".rc-ghostty-canvas");
    const keyboard = page.getByRole("button", { name: "Show keyboard" });
    await keyboard.tap();
    assert.equal(
      await terminalInput.evaluate((target) => document.activeElement === target),
      true,
      `${browserName}: the explicit keyboard control did not focus terminal input`,
    );
    await escape.tap();
    assert.equal(
      await terminalInput.evaluate((target) => document.activeElement === target),
      true,
      `${browserName}: an ordinary terminal key changed the open keyboard state`,
    );

    await page.getByRole("button", { name: "Files", exact: true }).tap();
    await page.getByRole("dialog", { name: "Terminal files" }).waitFor();
    assert.equal(
      await terminalInput.evaluate((target) => document.activeElement === target),
      true,
      `${browserName}: the Files toolbar launcher changed the open keyboard state`,
    );
    await page.getByRole("button", { name: "Close files" }).last().tap();
    await keyboard.tap();

    const dpadButton = page.getByRole("button", { name: "Arrow keys" });
    await dpadButton.tap();
    const dpadGroup = page.getByRole("group", { name: "Arrow keys" });
    await dpadGroup.waitFor();
    assert.equal(
      await terminalInput.evaluate((target) => document.activeElement === target),
      true,
      `${browserName}: opening the D-pad changed the open keyboard state`,
    );
    await page.waitForTimeout(150); // measure full-size targets after the 120ms entrance transform settles
    const dpadGeometry = await page.evaluate(() => {
      const panel = document.querySelector(".rc-termkeys__dpad");
      const toolbar = document.querySelector(".rc-termkeys__grid");
      if (!(panel instanceof HTMLElement && toolbar instanceof HTMLElement)) return null;
      const rect = (label) => {
        const element = document.querySelector(`.rc-tk__key[aria-label="${label}"]`);
        if (!(element instanceof HTMLElement)) return null;
        const value = element.getBoundingClientRect();
        return {
          left: value.left,
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          width: value.width,
          height: value.height,
          centerX: value.left + value.width / 2,
        };
      };
      const panelRect = panel.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      return {
        panel: { left: panelRect.left, right: panelRect.right, bottom: panelRect.bottom },
        toolbarTop: toolbarRect.top,
        arrows: {
          left: rect("Arrow left"),
          up: rect("Arrow up"),
          down: rect("Arrow down"),
          right: rect("Arrow right"),
          enter: rect("Enter"),
        },
        viewportWidth: innerWidth,
      };
    });
    assert(dpadGeometry, `${browserName}: opened D-pad geometry is unavailable`);
    const { left, up, down, right, enter } = dpadGeometry.arrows;
    assert(left && up && down && right && enter, `${browserName}: opened D-pad is incomplete`);
    assert(
      [left, up, down, right, enter].every((key) => key.width >= 43.5 && key.height >= 43.5),
      `${browserName}: D-pad directions are smaller than 44px (${JSON.stringify(dpadGeometry.arrows)})`,
    );
    assert(
      Math.abs(up.centerX - down.centerX) <= 0.5 &&
        up.bottom <= down.top + 0.5 &&
        left.right <= down.left + 0.5 &&
        down.right <= right.left + 0.5 &&
        Math.abs(left.top - down.top) <= 0.5 &&
        Math.abs(right.top - down.top) <= 0.5,
      `${browserName}: D-pad does not form an inverted-T keyboard layout (${JSON.stringify(dpadGeometry.arrows)})`,
    );
    assert(
      dpadGeometry.panel.left >= 0 &&
        dpadGeometry.panel.right <= dpadGeometry.viewportWidth &&
        dpadGeometry.panel.bottom < dpadGeometry.toolbarTop,
      `${browserName}: D-pad is not compactly anchored above the toolbar (${JSON.stringify(dpadGeometry)})`,
    );
    await page.getByRole("button", { name: "Arrow right" }).tap();
    await page.getByRole("button", { name: "Enter" }).tap();
    assert.equal(
      await terminalInput.evaluate((target) => document.activeElement === target),
      true,
      `${browserName}: D-pad keys changed the open keyboard state`,
    );
    await dpadButton.tap();
    await dpadGroup.waitFor({ state: "detached" });

    const terminalBox = await terminalCanvas.boundingBox();
    assert(terminalBox, `${browserName}: terminal canvas geometry is unavailable`);
    const terminalPoint = { x: terminalBox.x + 20, y: terminalBox.y + 20 };
    await dispatchPointer(terminalCanvas, "pointerdown", terminalPoint, 33);
    await dispatchPointer(terminalCanvas, "pointerup", terminalPoint, 33);
    await terminalCanvas.evaluate((target) =>
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 20 })),
    );
    assert.equal(
      await terminalInput.evaluate((target) => document.activeElement === target),
      false,
      `${browserName}: a terminal touch failed to release focus or its compatibility event reopened the keyboard`,
    );

    const chat = page.getByRole("button", { name: "Chat input" });
    await chat.tap();
    const chatComposer = page.getByRole("region", { name: "Chat input composer" });
    const chatMessage = page.getByRole("textbox", { name: "Chat message" });
    await chatComposer.waitFor();
    await page.waitForTimeout(180); // let the 140ms anchored-panel entrance settle before measuring geometry
    assert.equal(
      await chatMessage.evaluate((target) => document.activeElement === target),
      false,
      `${browserName}: opening the compact chat composer raised the keyboard`,
    );
    await chatMessage.tap();
    assert.equal(
      await chatMessage.evaluate((target) => document.activeElement === target),
      true,
      `${browserName}: tapping the chat field did not focus its text input`,
    );
    await chatMessage.fill("mobile prompt");
    assert.equal(await chatMessage.inputValue(), "mobile prompt", `${browserName}: the focused chat field cannot type`);
    await chatMessage.fill("");
    const composerGeometry = await page.evaluate(() => {
      const composer = document.querySelector(".rc-chat-input");
      const toolbar = document.querySelector(".rc-termkeys");
      if (!(composer instanceof HTMLElement && toolbar instanceof HTMLElement)) return null;
      const composerRect = composer.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      return { gap: toolbarRect.top - composerRect.bottom, width: composerRect.width, viewportWidth: innerWidth };
    });
    assert(
      composerGeometry && composerGeometry.gap >= 0 && composerGeometry.gap <= 6,
      `${browserName}: the chat composer is not anchored immediately above the key bar (${JSON.stringify(composerGeometry)})`,
    );
    assert(
      composerGeometry.width <= composerGeometry.viewportWidth - 10,
      `${browserName}: the compact chat composer leaves the mobile viewport`,
    );

    await chatMessage.evaluate((target) => target.blur());
    await keyboard.tap();
    assert.equal(
      await chatMessage.evaluate((target) => document.activeElement === target),
      true,
      `${browserName}: the keyboard control did not focus the open chat composer`,
    );
    await page.getByRole("button", { name: "Close chat input" }).tap();
    await keyboard.tap();
    assert.equal(
      await terminalInput.evaluate((target) => document.activeElement === target),
      true,
      `${browserName}: the keyboard control did not focus terminal input`,
    );

    const beforeComposition = await page.evaluate(() => window.__rcScreenshotInputs?.length ?? 0);
    await terminalInput.evaluate((target) => {
      target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      target.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "kod" }));
    });
    assert.deepEqual(
      await page.evaluate((offset) => window.__rcScreenshotInputs?.slice(offset) ?? [], beforeComposition),
      ["kod"],
      `${browserName}: active IME text remained buffered until the word was committed`,
    );
    await terminalInput.evaluate((target) => {
      target.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "kodl" }));
      target.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "kodla" }));
      target.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: " ",
        }),
      );
    });
    assert.deepEqual(
      await page.evaluate((offset) => window.__rcScreenshotInputs?.slice(offset) ?? [], beforeComposition),
      ["kod", "l", "a", " "],
      `${browserName}: IME updates were duplicated or delayed at composition commit`,
    );

    await page.evaluate(() => localStorage.removeItem("rc-touchpad-hint-learned"));
    const host = page.locator(".rc-terminal__host");
    const hostBox = await host.boundingBox();
    assert(hostBox, `${browserName}: terminal host is missing`);
    const softwarePointer = page.locator(".rc-terminal__touch-cursor");
    const pointerBefore = await softwarePointer.boundingBox();
    assert(pointerBefore, `${browserName}: touchpad pointer is not visible`);
    // The unit contract advances the exact seven-second timer. Here, force the resulting DOM state so the real
    // browser verifies paint + first-movement recovery without idling every CI run for another seven seconds.
    await softwarePointer.evaluate((target) => {
      target.dataset.visible = "false";
    });
    await page.waitForTimeout(200);
    assert.equal(
      await softwarePointer.getAttribute("data-visible"),
      "false",
      `${browserName}: the idle touchpad pointer did not auto-hide`,
    );
    assert.equal(
      await softwarePointer.evaluate((target) => getComputedStyle(target).opacity),
      "0",
      `${browserName}: the auto-hidden touchpad pointer remains painted`,
    );
    const dragStart = { x: hostBox.x + hostBox.width * 0.32, y: hostBox.y + hostBox.height * 0.45 };
    const dragEnd = { x: dragStart.x + 36, y: dragStart.y + 18 };
    const scrollTopBeforeMove = await host.evaluate((target) => target.scrollTop);
    await dispatchTouch(host, "touchstart", dragStart);
    await page.waitForTimeout(40);
    await dispatchTouch(host, "touchmove", dragEnd);
    await dispatchTouch(host, "touchend", dragEnd);
    const pointerAfter = await softwarePointer.boundingBox();
    assert(pointerAfter, `${browserName}: touchpad pointer disappeared after movement`);
    assert.equal(
      await softwarePointer.getAttribute("data-visible"),
      "true",
      `${browserName}: finger movement did not reveal the idle touchpad pointer`,
    );
    assert(
      Math.hypot(pointerAfter.x - pointerBefore.x, pointerAfter.y - pointerBefore.y) > 20,
      `${browserName}: one-finger movement did not move the relative software pointer`,
    );
    assert.equal(
      await host.evaluate((target) => target.scrollTop),
      scrollTopBeforeMove,
      `${browserName}: one-finger pointer movement leaked into terminal scrollback`,
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem("rc-touchpad-hint-learned")),
      "1",
      `${browserName}: the default touchpad gesture was not recognized`,
    );

    const probeInjected = await page.evaluate(() => {
      if (typeof window.__rcScreenshotOutput !== "function") return false;
      const row = "touchpad_probe ".repeat(12);
      window.__rcScreenshotOutput(`\u001b[2J\u001b[H${Array.from({ length: 80 }, () => row).join("\r\n")}`);
      return true;
    });
    assert.equal(probeInjected, true, `${browserName}: touchpad selection probe is unavailable`);
    await page.waitForTimeout(80);

    const firstFinger = { x: hostBox.x + hostBox.width * 0.28, y: hostBox.y + hostBox.height * 0.38 };
    const secondFinger = { x: firstFinger.x + 54, y: firstFinger.y };
    await terminalInput.focus();
    const secondaryClipboardResponse = page.waitForResponse(
      (response) => response.url().includes("/api/v1/sessions/") && response.url().endsWith("/clipboard"),
    );
    await dispatchTouch(host, "touchstart", [firstFinger, secondFinger]);
    await dispatchTouch(host, "touchend", [firstFinger, secondFinger]);
    await secondaryClipboardResponse;
    assert(
      page.__rcHostClipboardWrites.some(({ text }) => text?.includes("touchpad_probe")),
      `${browserName}: two-finger selection never reached the host clipboard endpoint`,
    );
    assert(
      await page.evaluate(() => window.__rcDeviceClipboardWrites.some((text) => text.includes("touchpad_probe"))),
      `${browserName}: two-finger selection never populated the browser copy event`,
    );
    if (browserName === "chromium") {
      assert(
        (await page.evaluate(() => navigator.clipboard.readText())).includes("touchpad_probe"),
        `${browserName}: two-finger selection never changed the device clipboard`,
      );
    }
    assert.equal(
      await page
        .locator(
          ".rc-term-touch-selection__handle, .rc-term-touch-selection__guard, .rc-term-touch-selection__menu, .rc-term-copy-notice",
        )
        .count(),
      0,
      `${browserName}: two-finger selection mounted custom clipboard chrome`,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains("rc-ghostty-input") ?? false),
      false,
      `${browserName}: touchpad selection retained hidden input focus and could resurrect the keyboard`,
    );
    // Reload the isolated fixture before the independent tap-drag contract. The touchpad intentionally keeps
    // short-lived tap state, so reusing the just-completed secondary-click gesture would couple two tests.
    await page.reload();
    await waitForScene(page, "terminal");

    // A tap followed promptly by a second touch keeps the primary button held. Moving that second touch must
    // exercise Ghostty's ordinary desktop drag-selection path, copy it, and leave no custom selection overlay.
    const selectionStart = { x: firstFinger.x, y: firstFinger.y };
    const selectionEnd = { x: selectionStart.x - 35, y: selectionStart.y - 45 };
    await dispatchTouch(host, "touchstart", selectionStart);
    await dispatchTouch(host, "touchend", selectionStart);
    await page.waitForTimeout(45);
    const tapDragClipboardResponse = page.waitForResponse(
      (response) => response.url().includes("/api/v1/sessions/") && response.url().endsWith("/clipboard"),
    );
    await dispatchTouch(host, "touchstart", selectionStart);
    await dispatchTouch(host, "touchmove", selectionEnd);
    await dispatchTouch(host, "touchend", selectionEnd);
    await tapDragClipboardResponse;
    assert.equal(
      await page
        .locator(
          ".rc-term-touch-selection__handle, .rc-term-touch-selection__guard, .rc-term-touch-selection__menu, .rc-term-copy-notice",
        )
        .count(),
      0,
      `${browserName}: tap-drag selection left custom selection chrome over the terminal`,
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
        nativeScroll: host.classList.contains("rc-ghostty-native-scroll"),
        scrollSpacer: Boolean(host.querySelector(".rc-ghostty-scroll-spacer")),
      };
    });
    assert.deepEqual(
      touchOwnership,
      {
        hostTouchAction: "none",
        hostUserSelect: "none",
        canvasUserSelect: "none",
        nativeScroll: true,
        scrollSpacer: true,
      },
      `${browserName}: the terminal surface is not fully owned by the virtual touchpad`,
    );
    const contextSuppressed = await host.evaluate((target) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(contextSuppressed, true, `${browserName}: touch input leaked a native context menu`);
    assert.equal(
      await page
        .locator(
          ".rc-term-touch-selection__handle, .rc-term-touch-selection__guard, .rc-term-touch-selection__menu, .rc-term-copy-notice",
        )
        .count(),
      0,
      `${browserName}: tap-drag selection mounted custom clipboard chrome`,
    );
    // Sample after two presented frames so the Ghostty selection paint assertion is not a scheduler race.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
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
      await page
        .locator(
          ".rc-term-touch-selection__handle, .rc-term-touch-selection__guard, .rc-term-touch-selection__menu, .rc-term-copy-notice",
        )
        .count(),
      0,
      `${browserName}: live terminal output introduced custom clipboard chrome`,
    );

    const pasteProbe = "mobile_keybar_paste_probe";
    const clipboardReady =
      browserName === "chromium"
        ? await page.evaluate(async (text) => {
            try {
              await navigator.clipboard.writeText(text);
              return (await navigator.clipboard.readText()) === text;
            } catch {
              return false;
            }
          }, pasteProbe)
        : await page.evaluate((text) => {
            try {
              const clipboard = navigator.clipboard ?? {};
              Object.defineProperty(clipboard, "readText", {
                configurable: true,
                value: async () => text,
              });
              if (!navigator.clipboard)
                Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
              return typeof navigator.clipboard?.readText === "function";
            } catch {
              return false;
            }
          }, pasteProbe);
    assert.equal(clipboardReady, true, `${browserName}: device clipboard read could not be exercised`);
    const beforePasteInputs = await page.evaluate(() => window.__rcScreenshotInputs?.length ?? 0);
    await page.getByRole("button", { name: "Paste clipboard" }).tap();
    await page.waitForFunction(
      ({ offset, text }) => window.__rcScreenshotInputs?.slice(offset).some((input) => input.includes(text)),
      { offset: beforePasteInputs, text: pasteProbe },
    );
    assert.equal(
      await page.locator(".rc-term-touch-selection__handle, .rc-term-touch-selection__guard").count(),
      0,
      `${browserName}: Paste did not return the terminal to its native unselected state`,
    );
    assert.equal(
      await page.locator(".rc-term-touch-selection__menu, .rc-term-copy-notice").count(),
      0,
      `${browserName}: key-bar Paste mounted custom clipboard chrome`,
    );

    // Insecure LAN origins intentionally have no async Clipboard API. Exercise the native-input fallback as a
    // browser event contract: the button focuses Ghostty's editable textarea and the platform paste event is sent
    // once through Ghostty rather than through a custom RoamCode prompt.
    const nativePasteProbe = "mobile_native_paste_probe";
    const nativeFallbackReady = await page.evaluate((text) => {
      try {
        const clipboard = navigator.clipboard ?? {};
        Object.defineProperty(clipboard, "readText", { configurable: true, value: undefined });
        if (!navigator.clipboard)
          Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
        const original = document.execCommand?.bind(document);
        document.execCommand = (command) => {
          if (command !== "paste") return original?.(command) ?? false;
          const event = new Event("paste", { bubbles: true, cancelable: true });
          Object.defineProperty(event, "clipboardData", {
            value: { files: [], getData: (type) => (type === "text/plain" ? text : "") },
          });
          document.activeElement?.dispatchEvent(event);
          return event.defaultPrevented;
        };
        return typeof navigator.clipboard?.readText !== "function";
      } catch {
        return false;
      }
    }, nativePasteProbe);
    assert.equal(nativeFallbackReady, true, `${browserName}: native Paste fallback could not be exercised`);
    const beforeNativePasteInputs = await page.evaluate(() => window.__rcScreenshotInputs?.length ?? 0);
    await page.getByRole("button", { name: "Paste clipboard" }).tap();
    await page.waitForFunction(
      ({ offset, text }) => window.__rcScreenshotInputs?.slice(offset).some((input) => input.includes(text)),
      { offset: beforeNativePasteInputs, text: nativePasteProbe },
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains("rc-ghostty-input") ?? false),
      true,
      `${browserName}: native Paste fallback did not focus Ghostty's editable input`,
    );
    await page.waitForTimeout(100);
    assertLayout(await inspectLayout(page), `${browserName}/terminal-touch-contracts`);
    await page.close();
  }

  {
    // Exercise the real Ghostty canvas inside a real browser: normal-buffer output must create an actual
    // overflow range, moving that range must update Ghostty's viewport (the jump chip is the public signal),
    // and scrolling must never synthesize provider/tmux input.
    const page = await openScene(context, baseUrl, "codex");
    const injected = await page.evaluate(() => {
      if (typeof window.__rcScreenshotOutput !== "function") return false;
      const lines = Array.from({ length: 96 }, (_, index) => `native scrollback row ${index + 1}`).join("\n");
      window.__rcScreenshotOutput(`\u001b[?1049l\u001b[2J\u001b[H${lines}`);
      return true;
    });
    assert.equal(injected, true, `${browserName}: native scroll output probe is unavailable`);
    const host = page.locator(".rc-terminal__host");
    await page.waitForFunction(() => {
      const target = document.querySelector(".rc-terminal__host");
      return target instanceof HTMLElement && target.scrollHeight > target.clientHeight && target.scrollTop > 0;
    });
    const beforeInputs = await page.evaluate(() => window.__rcScreenshotInputs?.length ?? 0);
    const scrollHostBox = await host.boundingBox();
    assert(scrollHostBox, `${browserName}: touchpad scroll surface is unavailable`);
    const scrollStart = [
      { x: scrollHostBox.x + scrollHostBox.width * 0.42, y: scrollHostBox.y + scrollHostBox.height * 0.42 },
      { x: scrollHostBox.x + scrollHostBox.width * 0.58, y: scrollHostBox.y + scrollHostBox.height * 0.42 },
    ];
    const scrollEnd = scrollStart.map((point) => ({ ...point, y: point.y + 72 }));
    const scrollTopBefore = await host.evaluate((target) => target.scrollTop);
    await dispatchTouch(host, "touchstart", scrollStart);
    await dispatchTouch(host, "touchmove", scrollEnd);
    await dispatchTouch(host, "touchend", scrollEnd);
    await page.waitForTimeout(80);
    const movement = await host.evaluate(
      (target, before) => ({
        before,
        after: target.scrollTop,
        maximum: target.scrollHeight - target.clientHeight,
      }),
      scrollTopBefore,
    );
    assert(
      movement.before > movement.after && movement.maximum > 0,
      `${browserName}: two-finger touchpad scroll did not reveal older terminal rows (${JSON.stringify(movement)})`,
    );
    assert.equal(
      await page.evaluate(() => window.__rcScreenshotInputs?.length ?? 0),
      beforeInputs,
      `${browserName}: two-finger touchpad scroll emitted provider/tmux input`,
    );
    await page.getByRole("button", { name: "Jump to latest output" }).waitFor();
    await page.getByRole("button", { name: "Jump to latest output" }).tap();
    const latest = await host.evaluate((target) => ({
      scrollTop: target.scrollTop,
      maximum: target.scrollHeight - target.clientHeight,
    }));
    assert(
      Math.abs(latest.scrollTop - latest.maximum) <= 1,
      `${browserName}: jump-to-latest did not restore the native scroll surface (${JSON.stringify(latest)})`,
    );
    await page.evaluate(() => window.__rcScreenshotOutput?.("\u001b[?1049h"));
    await page.waitForFunction(() => {
      const target = document.querySelector(".rc-terminal__host");
      return (
        target instanceof HTMLElement &&
        target.classList.contains("rc-ghostty-alt-screen") &&
        getComputedStyle(target).touchAction === "none"
      );
    });
    const alternateSurface = await host.evaluate((target) => ({
      scrollTop: target.scrollTop,
      maximum: target.scrollHeight - target.clientHeight,
    }));
    assert.deepEqual(
      alternateSurface,
      { scrollTop: 0, maximum: 0 },
      `${browserName}: alternate-screen app retained browser-owned scrollback (${JSON.stringify(alternateSurface)})`,
    );
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
    { position: "fixed", top: 0, keybarPaddingBottom: "37px" },
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
  // Dense surfaces may fit the complete action set without scrolling. If they overflow, prove the end remains
  // reachable through the surface's own scroller; otherwise the same visibility/hit-target checks below apply.
  if (before.scrollHeight > before.clientHeight) {
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  }
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
      if (browserName === "chromium") await exerciseDesktopClipboardContract(browser, baseUrl, browserName);
      for (const profile of profiles) {
        const context = await createTouchContext(browser, profile);
        await context.addInitScript(() => {
          window.__rcScreenshotInputs = [];
          localStorage.setItem("rc-touchpad-hint-learned", "1");
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
