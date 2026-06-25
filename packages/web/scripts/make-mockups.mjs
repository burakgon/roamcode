// Wrap the raw README screenshots (docs/screenshots/) in device mockups (docs/mockups/) — phone shots
// in a sleek dark bezel, the desktop shot in a macOS-style browser window — so the GitHub page reads as
// a polished product, not bare screenshots. Run AFTER app-screenshot.mjs:
//   pnpm -C packages/web build:shot && node packages/web/scripts/app-screenshot.mjs && node packages/web/scripts/make-mockups.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SS = join(__dirname, "..", "..", "..", "docs", "screenshots");
const OUT = join(__dirname, "..", "..", "..", "docs", "mockups");
const dataURI = (name) => "data:image/png;base64," + readFileSync(join(SS, `${name}.png`)).toString("base64");

// Phone shots → a clean dark bezel (rounded screen, soft drop shadow, transparent around).
const PHONES = ["chat-mobile-top", "question-mobile", "wizard-mobile", "rewind-mobile", "login-mobile", "chat-mobile"];
const phoneHTML = (src) => `<!doctype html><html><head><style>
 body{margin:0;background:transparent}
 .wrap{display:inline-block;padding:38px}
 .phone{padding:11px;background:linear-gradient(155deg,#42424a,#1d1d22);border-radius:46px;
   box-shadow:0 24px 46px -16px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.11),inset 0 1.6px 0 rgba(255,255,255,.18),inset 0 -1.6px 0 rgba(0,0,0,.5)}
 .screen{border-radius:36px;overflow:hidden;display:block;box-shadow:inset 0 0 0 1px rgba(255,255,255,.07)}
 .screen img{display:block;width:384px}
</style></head><body><div class="wrap"><div class="phone"><div class="screen"><img src="${src}"></div></div></div></body></html>`;

// Desktop shot → a macOS-style browser window (traffic lights + rounded corners + soft shadow).
const browserHTML = (src) => `<!doctype html><html><head><style>
 body{margin:0;background:transparent}
 .wrap{display:inline-block;padding:42px}
 .win{border-radius:12px;overflow:hidden;background:#202024;box-shadow:0 26px 54px -18px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.12)}
 .bar{height:36px;background:#1b1b1e;display:flex;align-items:center;gap:9px;padding:0 15px;border-bottom:1px solid rgba(255,255,255,.06)}
 .d{width:11px;height:11px;border-radius:50%}.r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
 .win img{display:block;width:1120px}
</style></head><body><div class="wrap"><div class="win"><div class="bar"><span class="d r"></span><span class="d y"></span><span class="d g"></span></div><img src="${src}"></div></div></body></html>`;

const browser = await chromium.launch();
async function frame(html, out) {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const i = document.querySelector("img");
    return i && i.complete && i.naturalWidth > 0;
  }, { timeout: 8000 });
  await (await page.$(".wrap")).screenshot({ path: out, omitBackground: true });
  await page.close();
  console.log("  framed", out.split("/").pop());
}
try {
  for (const n of PHONES) await frame(phoneHTML(dataURI(n)), join(OUT, `${n}.png`));
  await frame(browserHTML(dataURI("chat-desktop")), join(OUT, "chat-desktop.png"));
} finally {
  await browser.close();
}
console.log(`Mockups written to ${OUT}`);
