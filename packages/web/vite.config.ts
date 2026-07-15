import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { pwaManifest } from "./src/pwa/manifest";

const packageVersion = (
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }
).version;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(process.env.ROAMCODE_BUILD_VERSION || packageVersion) },
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
        // Code-split product surfaces stay available offline. Fonts are cached on first use by sw.ts instead of
        // forcing every language subset and legacy woff fallback into the install-time precache.
        globPatterns: ["**/*.{js,css,html,svg}"],
      },
      devOptions: { enabled: false, type: "module" },
    }),
  ],
  server: { port: 5273 },
});
