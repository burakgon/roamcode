// @vitest-environment node
// esbuild (used by vite build) requires real Node globals; jsdom's TextEncoder breaks it.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

// The service worker is built at `vite build` (now via `injectManifest`: our hand-written
// `src/sw.ts` is the SW, and vite-plugin-pwa injects the precache manifest at `self.__WB_MANIFEST`).
// We can't unit-test its runtime, so instead we run the real build once and assert on the emitted
// artifacts: that the SW + manifest are emitted, that the custom push/notificationclick handlers
// shipped, that the manifest carries the right name/theme/icons, and — critically — that the SW
// precaches ONLY the static shell and never the live API or WebSocket (which would serve
// stale/unauthorized data and break sessions). The API navigation-fallback denial now lives
// server-side (`@fastify/static` + the server's API path denylist); the web-side mirror
// (`apiNavigationDenylist`) is covered by `sw-exclusions.test.ts`.

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
// Output under dist/ (already gitignored) so the test artifact never lands in git.
const distDir = resolve(webRoot, "dist/pwa-test");

let sw = "";
let manifest = "";

beforeAll(async () => {
  await build({
    root: webRoot,
    logLevel: "silent",
    configFile: resolve(webRoot, "vite.config.ts"),
    build: { outDir: distDir, emptyOutDir: true },
  });
  sw = readFileSync(resolve(distDir, "sw.js"), "utf8");
  manifest = readFileSync(resolve(distDir, "manifest.webmanifest"), "utf8");
}, 120_000);

describe("vite build PWA artifacts", () => {
  it("emits a service worker that precaches the app shell", () => {
    // injectManifest injects the precache list (revision-stamped entries) at __WB_MANIFEST;
    // the shell (index.html + icons) is precached just as the old generateSW config did.
    expect(sw).toMatch(/revision:/);
    expect(sw).toMatch(/index\.html/);
    expect(sw).toMatch(/icon-512\.svg/);
  });

  it("ships the custom Web Push handlers (push + notificationclick)", () => {
    // The whole reason for switching to injectManifest: our hand-written SW owns these handlers,
    // which generateSW could not host.
    expect(sw).toMatch(/addEventListener\(["']push["']/);
    expect(sw).toMatch(/addEventListener\(["']notificationclick["']/);
    expect(sw).toMatch(/showNotification/);
  });

  it("does NOT precache or intercept the live API or the WebSocket", () => {
    // The critical safety invariant (preserved from Plan 4): /sessions and /fs are never a
    // precached URL or a cache route, and the WebSocket is never matched by a fetch route.
    expect(sw).not.toMatch(/url:\s*["'][^"']*\/sessions/);
    expect(sw).not.toMatch(/url:\s*["'][^"']*\/fs/);
    expect(sw).not.toMatch(/ws:\/\//);
    expect(sw).not.toMatch(/wss:\/\//);
  });

  it("emits a manifest with the right name, theme, and icons", () => {
    const m = JSON.parse(manifest) as {
      name: string;
      theme_color: string;
      background_color: string;
      display: string;
      icons: { src: string; sizes: string }[];
    };
    expect(m.name).toBe("remote-coder");
    expect(m.theme_color).toBe("#0D0A07");
    expect(m.background_color).toBe("#0D0A07");
    expect(m.display).toBe("standalone");
    expect(m.icons.map((i) => i.src)).toEqual(expect.arrayContaining(["icon-192.svg", "icon-512.svg"]));
  });
});
