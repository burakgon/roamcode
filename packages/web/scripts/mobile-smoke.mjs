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
const supportedBrowsers = new Set(["chromium", "webkit"]);
for (const name of requestedBrowsers) {
  assert(supportedBrowsers.has(name), `Unsupported RC_MOBILE_BROWSERS entry: ${name}`);
}

const scenes = [
  "terminal",
  "codex",
  "startup",
  "sessions",
  "newsession",
  "files",
  "ota",
  "login",
  "agents",
  "automations",
];
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
    // than reporting the obscured bottom navigation as an accidental occlusion.
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
          ".rc-agent-catalog",
          ".rc-automation-card",
          ".rc-terminal",
          ".rc-termkeys",
          ".rc-primary-nav--bottom",
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
  await page.goto(`${baseUrl}/screenshot.html?scene=${scene}`, { waitUntil: "networkidle" });
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
    const page = await openScene(context, baseUrl, "agents");
    await page.getByRole("button", { name: "Refresh agents" }).tap();
    await page.getByRole("button", { name: /Codex 2 active sessions Ready/ }).waitFor();
    assertLayout(await inspectLayout(page), `${browserName}/agents-refresh`);
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
    const page = await openScene(context, baseUrl, "automations");
    await page.locator(".rc-main").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(50);
    const bottomClearance = await page.evaluate(() => {
      const main = document.querySelector(".rc-main");
      const lastButton = [...document.querySelectorAll(".rc-automation-card > footer button")].at(-1);
      if (!(main instanceof HTMLElement) || !(lastButton instanceof HTMLElement)) return null;
      return main.getBoundingClientRect().bottom - lastButton.getBoundingClientRect().bottom;
    });
    assert(bottomClearance !== null && bottomClearance >= -0.5, `${browserName}: bottom navigation covers actions`);
    assertLayout(await inspectLayout(page), `${browserName}/automation-scroll-end`);
    await page.close();
  }

  {
    const page = await openScene(context, baseUrl, "terminal");
    const escape = page.getByRole("button", { name: "Escape" });
    const beforeEscape = await page.evaluate(() => window.__rcScreenshotInputs?.length ?? 0);
    await escape.tap();
    const afterEscape = await page.evaluate(() => window.__rcScreenshotInputs ?? []);
    assert.equal(afterEscape.length, beforeEscape + 1, `${browserName}: a key-bar tap must emit exactly once`);
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
    await dispatchTouch(host, "touchstart", pressPoint);
    await page.waitForTimeout(560);
    await dispatchTouch(host, "touchend", pressPoint);
    const selectionMenu = page.getByRole("menu", { name: "Mobile terminal clipboard menu" });
    await selectionMenu.waitFor();
    assert.equal(
      await page.locator(".rc-term-touch-selection__handle").count(),
      2,
      `${browserName}: Ghostty selection handles did not survive touchend`,
    );
    await selectionMenu.getByRole("menuitem", { name: "Done" }).tap();
    await selectionMenu.waitFor({ state: "detached" });
    assertLayout(await inspectLayout(page), `${browserName}/terminal-touch-contracts`);
    await page.close();
  }

  {
    // Open the production TerminalFiles path from the real terminal key bar. The dialog must own the entire
    // app-root stacking plane; the bottom navigation may exist behind the modal, but must never cover its
    // photo/file upload footer.
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
      const nav = document.querySelector(".rc-primary-nav--bottom");
      if (!(root && modal && panel && upload && nav)) return null;
      const rootRect = root.getBoundingClientRect();
      const modalRect = modal.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const uploadRect = upload.getBoundingClientRect();
      const navRect = nav.getBoundingClientRect();
      const navHit = document.elementFromPoint(navRect.left + navRect.width / 2, navRect.top + navRect.height / 2);
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
        navCoveredByModal: Boolean(navHit && modal.contains(navHit)),
        uploadUsable: Boolean(uploadHit && (uploadHit === upload || upload.contains(uploadHit))),
      };
    });
    assert(geometry, `${browserName}: file dialog geometry is unavailable`);
    assert.equal(geometry.modalTop, 0, `${browserName}: file dialog does not start at the app-root top`);
    assert.equal(
      geometry.modalBottom,
      geometry.rootBottom,
      `${browserName}: file dialog does not cover the bottom navigation plane`,
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
    assert.equal(geometry.navCoveredByModal, true, `${browserName}: bottom navigation paints over the file dialog`);
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
    const nav = document.querySelector(".rc-primary-nav--bottom");
    const keybar = document.querySelector(".rc-termkeys");
    const stage = document.querySelector(".rc-terminal__stage");
    if (!(root && nav && keybar && stage && visualViewport)) return null;
    const rootRect = root.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
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
      navBottom: navRect.bottom,
      keybarBottom: keybarRect.bottom,
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
  assert.equal(report.navBottom, report.visibleBottom, `${browserName}: bottom navigation does not meet the keyboard`);
  assert(report.keybarBottom <= report.navBottom + 0.5, `${browserName}: terminal key bar overlaps bottom navigation`);
  assert(report.stageHeight > 0, `${browserName}: terminal canvas collapses while the keyboard is open`);
  assert.equal(report.rootWidth, expectedWidth, `${browserName}: keyboard-open root width drifts`);
  assert.equal(report.safeBottom, "0px", `${browserName}: safe-area padding creates a second keyboard gap`);
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
    return { position: getComputedStyle(root).position, top: rect.top };
  });
  assert.deepEqual(
    restored,
    { position: "relative", top: 0 },
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
    const browser = browserName === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
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
