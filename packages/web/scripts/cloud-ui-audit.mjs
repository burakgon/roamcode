// Real-browser cloud UI acceptance. This intentionally consumes a short-lived `roamcode cloud pair` output file
// instead of accepting a pairing capability in argv, and it never prints or stores either pairing URL in its report.
// Run only against an isolated host/relay fixture; screenshots redact the visible fragment while preserving layout.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, devices } from "playwright";

const pairOutputPath = process.env.ROAMCODE_AUDIT_PAIR_OUTPUT;
const outputDirectory = resolve(process.env.ROAMCODE_AUDIT_OUTPUT ?? "/tmp/roamcode-cloud-ui-audit");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (!pairOutputPath || !executablePath) {
  throw new Error("ROAMCODE_AUDIT_PAIR_OUTPUT and PLAYWRIGHT_CHROMIUM_EXECUTABLE are required");
}

const initialPairing = readFileSync(pairOutputPath, "utf8").match(
  /https?:\/\/[^\s#]+\/#relay-pair=[A-Za-z0-9_-]+/u,
)?.[0];
if (!initialPairing) throw new Error("the isolated cloud-pair output did not contain a remote pairing URL");

mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const findings = [];
const screenshots = [];

function observePage(page, label) {
  page.on("pageerror", (error) => findings.push({ type: "page-error", label, message: error.message.slice(0, 240) }));
  page.on("console", (message) => {
    if (message.type() === "error")
      findings.push({ type: "console-error", label, message: message.text().slice(0, 240) });
  });
}

async function waitForApp(page, label) {
  try {
    await page
      .locator('button[aria-label="Settings"]:visible, button[aria-label^="Show sessions"]:visible')
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
  } catch (error) {
    await page.screenshot({ path: resolve(outputDirectory, `${label}-claim-timeout.png`), fullPage: false });
    const safeText = (await page.locator("body").innerText())
      .replace(/#relay-pair=[A-Za-z0-9_-]+/gu, "#relay-pair=[redacted]")
      .replace(/\brr[a-z]_[A-Za-z0-9_-]{20,}\b/gu, "[redacted capability]")
      .slice(0, 4_000);
    writeFileSync(resolve(outputDirectory, `${label}-claim-timeout.txt`), `${safeText}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    throw error;
  }
}

async function openDevices(page) {
  const settingsButton = page.getByRole("button", { name: "Settings" }).last();
  if (!(await settingsButton.isVisible())) {
    await page.getByRole("button", { name: /^Show sessions/ }).click();
    await settingsButton.waitFor({ state: "visible" });
  }
  await settingsButton.click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "Devices" }).click();
  const section = dialog.locator("#settings-device");
  await section.scrollIntoViewIfNeeded();
  await section.locator(".rc-devices__list").waitFor({ state: "visible" });
  await section.getByRole("button", { name: "Pair remotely" }).waitFor({ state: "visible" });
  await page.waitForTimeout(700);
  return { dialog, section };
}

async function auditViewport(page, label, dialog) {
  const result = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth
      );
    };
    const accessibleName = (element) => {
      const explicit = element.getAttribute("aria-label")?.trim();
      if (explicit) return explicit;
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
        const label = [...element.labels].map((item) => item.textContent?.trim()).find(Boolean);
        if (label) return label;
      }
      return (element.textContent || "").trim();
    };
    const settings = document.querySelector(".rc-settings") ?? document;
    const minimumTarget = innerWidth <= 560 ? 44 : 24;
    const undersized = [...settings.querySelectorAll("button, input, select, textarea, a[href]")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: (accessibleName(element) || element.tagName).slice(0, 80),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((target) => target.width < minimumTarget || target.height < minimumTarget);
    const unnamed = [...settings.querySelectorAll("button, input, select, textarea, a[href]")]
      .filter(visible)
      .filter((element) => !accessibleName(element)).length;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      minimumTarget,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      bodyHorizontalOverflow: document.body.scrollWidth > innerWidth + 1,
      activeCategory: document.querySelector('[aria-label="Settings categories"] [aria-current="page"]')?.textContent,
      sectionPositions: [...document.querySelectorAll(".rc-settings__section")].map((section) => ({
        id: section.id,
        top: Math.round(section.getBoundingClientRect().top),
        bottom: Math.round(section.getBoundingClientRect().bottom),
      })),
      undersized,
      unnamed,
    };
  });

  for (let index = 0; index < 12; index += 1) await page.keyboard.press("Tab");
  const focusEscaped = !(await dialog.evaluate((element) => element.contains(document.activeElement)));
  findings.push({ type: "viewport", label, ...result, focusEscaped });
}

async function screenshot(page, name) {
  const path = resolve(outputDirectory, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  screenshots.push(`${name}.png`);
}

let activePage;
let workflowError;
try {
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const desktop = await desktopContext.newPage();
  activePage = desktop;
  observePage(desktop, "desktop");
  await desktop.goto(initialPairing, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await waitForApp(desktop, "desktop");
  await screenshot(desktop, "desktop-main");

  const desktopSettings = await openDevices(desktop);
  await desktopSettings.section.getByText("Remote access").waitFor();
  await screenshot(desktop, "desktop-devices");
  await auditViewport(desktop, "desktop-devices", desktopSettings.dialog);

  await desktopSettings.section.getByRole("button", { name: "Pair remotely" }).click();
  const remoteRegion = desktopSettings.section.getByRole("region", { name: "Pair for remote access" });
  await remoteRegion.waitFor();
  await desktop.waitForTimeout(700);
  const secondPairing = (await remoteRegion.locator("code").textContent())?.trim();
  if (!secondPairing?.includes("#relay-pair=")) throw new Error("remote pairing UI did not expose the expected link");
  await desktop.addStyleTag({ content: ".rc-devices__pair code { filter: blur(8px) !important; }" });
  await screenshot(desktop, "desktop-remote-pairing-redacted");

  const mobileContext = await browser.newContext({ ...devices["iPhone 13 Pro"] });
  const mobile = await mobileContext.newPage();
  activePage = mobile;
  observePage(mobile, "mobile");
  await mobile.goto(secondPairing, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await waitForApp(mobile, "mobile");
  await screenshot(mobile, "mobile-main");

  const mobileSettings = await openDevices(mobile);
  await mobileSettings.section.getByText("Remote access").waitFor();
  await screenshot(mobile, "mobile-devices");
  await auditViewport(mobile, "mobile-devices", mobileSettings.dialog);

  await mobileSettings.section.getByRole("button", { name: "Pair remotely" }).click();
  const mobileRemoteRegion = mobileSettings.section.getByRole("region", { name: "Pair for remote access" });
  await mobileRemoteRegion.waitFor();
  await mobile.waitForTimeout(700);
  await mobile.addStyleTag({ content: ".rc-devices__pair code { filter: blur(8px) !important; }" });
  await screenshot(mobile, "mobile-remote-pairing-redacted");
  await mobileRemoteRegion.getByRole("button", { name: "Cancel" }).click();
  await mobileSettings.section.getByRole("button", { name: "Pair remotely" }).waitFor();

  await mobileSettings.section.getByRole("button", { name: "Pair another device" }).click();
  const localPairingRegion = mobileSettings.section.getByRole("region", { name: "Pair another device" });
  await localPairingRegion.waitFor();
  await localPairingRegion.getByRole("button", { name: "Cancel" }).click();
  await mobileSettings.section.getByRole("button", { name: "Pair another device" }).waitFor();

  await desktopContext.close();
  await mobileContext.close();
} catch (error) {
  workflowError = error;
  findings.push({
    type: "workflow-error",
    message: error instanceof Error ? error.message.slice(0, 500) : "unknown cloud UI audit failure",
  });
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: resolve(outputDirectory, "workflow-failure.png"), fullPage: false });
  }
} finally {
  await browser.close();
}

const blockingFindings = findings.filter(
  (finding) =>
    finding.type === "page-error" ||
    finding.type === "console-error" ||
    (finding.type === "viewport" &&
      (finding.horizontalOverflow ||
        finding.bodyHorizontalOverflow ||
        finding.focusEscaped ||
        finding.unnamed > 0 ||
        finding.undersized.length > 0)),
);
if (!workflowError && blockingFindings.length > 0) {
  workflowError = new Error(
    `cloud UI audit found ${blockingFindings.length} blocking accessibility or layout issue(s)`,
  );
}

writeFileSync(resolve(outputDirectory, "audit.json"), `${JSON.stringify({ screenshots, findings }, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(`Cloud UI audit completed with ${screenshots.length} redaction-safe screenshots.`);
if (workflowError) throw workflowError;
