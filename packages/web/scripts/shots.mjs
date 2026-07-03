/* eslint-disable */
// Regenerate the README/marketing screenshots from the real components with mock data (docs/media/*.png).
// Spins up a Vite dev server on the screenshot harness (src/screenshot), drives Playwright's bundled Chromium
// across each scene at its device frame, and shoots. No live server / auth / real claude session needed.
//   Run: node packages/web/scripts/shots.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, devices } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "..");
const outDir = join(webDir, "..", "..", "docs", "media");
mkdirSync(outDir, { recursive: true });
const PORT = 5273;
const BASE = `http://localhost:${PORT}`;

// iPhone emulation (hasTouch + isMobile) so the media queries resolve to pointer:coarse / hover:none —
// otherwise desktop Chrome hides the touch-only key bar (@media hover:hover and pointer:fine).
const IPHONE = devices["iPhone 13 Pro"];
const SHOTS = [
  { name: "terminal-mobile", scene: "terminal", mobile: true, wait: 2200 },
  { name: "startup-mobile", scene: "startup", mobile: true, wait: 2200 },
  {
    name: "keybar-mobile",
    scene: "terminal",
    mobile: true,
    wait: 2200,
    click: 'button[aria-label="Select text"]',
    post: 700,
  },
  { name: "sessions-mobile", scene: "sessions", mobile: true, wait: 1400 },
  { name: "newsession-mobile", scene: "newsession", mobile: true, wait: 1600 },
  { name: "files-mobile", scene: "files", mobile: true, wait: 1400 },
  { name: "ota-mobile", scene: "ota", mobile: true, wait: 1400 },
  {
    name: "login-mobile",
    scene: "login",
    mobile: true,
    wait: 1200,
    fill: { sel: "input", value: "rc_9f3ad217e8b4c0615d" },
  },
  { name: "desktop", scene: "desktop", mobile: false, wait: 2400 },
  { name: "split-desktop", scene: "split", mobile: false, wait: 2800 },
];
// ONLY=<name[,name]> shoots a subset — e.g. `ONLY=split-desktop node packages/web/scripts/shots.mjs` after
// touching one scene, so a single-image refresh doesn't cost a full sweep (kind to the prod box).
const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
const SELECTED = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--clearScreen", "false"], {
  cwd: webDir,
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/screenshot.html`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error("vite did not start in time");
}

try {
  await waitServer();
  // Use the system Chrome (channel) so no Playwright browser download is needed.
  const browser = await chromium.launch({ channel: "chrome" });
  for (const s of SELECTED) {
    const ctx = s.mobile
      ? await browser.newContext({ ...IPHONE })
      : await browser.newContext({ viewport: { width: 1320, height: 840 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    // Suppress the one-time two-finger-scroll hint so shots are clean + deterministic.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("rc-scroll-hint-learned", "1");
      } catch {
        /* ignore */
      }
    });
    await page.goto(`${BASE}/screenshot.html?scene=${s.scene}`, { waitUntil: "networkidle" });
    // Clean marketing shots: no keyboard-focus rings (the dialogs' focus traps auto-focus a control).
    await page.addStyleTag({ content: "*:focus, *:focus-visible { outline: none !important; }" });
    await page.waitForTimeout(s.wait);
    if (s.fill) {
      try {
        await page.fill(s.fill.sel, s.fill.value);
        await page.waitForTimeout(250);
      } catch (e) {
        console.warn(`  fill failed for ${s.name}: ${e.message}`);
      }
    }
    if (s.click) {
      try {
        await page.click(s.click, { timeout: 2500 });
        await page.waitForTimeout(s.post ?? 400);
      } catch (e) {
        console.warn(`  click failed for ${s.name}: ${e.message}`);
      }
    }
    await page.screenshot({ path: join(outDir, `${s.name}.png`) });
    console.log(`  ✓ ${s.name}.png`);
    await ctx.close();
  }
  await browser.close();
  console.log(`done → ${outDir}`);
} finally {
  vite.kill("SIGTERM");
}
