import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { pwaManifest } from "./src/pwa/manifest";

/**
 * The git short sha being built. Baked into the bundle as `__BUILD_SHA__` so the running client knows its
 * OWN version and can detect when it's a stale precached build vs the deployed server (update/stale-client.ts).
 * The OTA build runs `pnpm -r build` AFTER `git pull`, so HEAD here is the freshly-pulled commit. "unknown"
 * when git is unavailable (still safe — stale detection treats a non-real sha as "can't decide").
 */
function gitShortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  define: { __BUILD_SHA__: JSON.stringify(gitShortSha()) },
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      includeAssets: ["icon-192.svg", "icon-512.svg"],
      manifest: pwaManifest,
      injectManifest: {
        // Precache the built shell so the app loads offline. The custom sw.ts (push/notificationclick)
        // owns runtime behavior; only static assets are precached.
        globPatterns: ["**/*.{js,css,html,svg,woff,woff2}"],
      },
      devOptions: { enabled: false, type: "module" },
    }),
  ],
  server: { port: 5273 },
});
