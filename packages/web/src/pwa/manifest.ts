import type { ManifestOptions } from "vite-plugin-pwa";

/**
 * The web app manifest, extracted so it can be unit-tested (name/theme/icons) independently
 * of a full `vite build`. `vite.config.ts` feeds this straight into `VitePWA({ manifest })`.
 *
 * theme_color keeps the near-black neutral `--bg` ink (#0a0a0b) — the RUNTIME meta tag manages the live
 * chrome color anyway. background_color is PURE black: it paints the pre-boot splash, and near-black-on-
 * black flashed visibly on OLED (the app then applies the real theme before first paint, so #000 is
 * correct for both themes). The icons are the coral terminal mark on the ink. `display: "standalone"`
 * makes it an installable, app-like PWA.
 */
export const pwaManifest: Partial<ManifestOptions> = {
  name: "RoamCode",
  short_name: "RoamCode",
  description: "Operate Claude Code and Codex sessions on your machine, remotely.",
  theme_color: "#0a0a0b",
  background_color: "#000000",
  display: "standalone",
  start_url: "/",
  // PNG icons alongside the SVGs: some installers (and iOS via apple-touch-icon) don't render SVG icons,
  // falling back to a screenshot. The 512 PNG is the maskable one (full-bleed square; the launcher rounds).
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    { src: "icon-192.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
    { src: "icon-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" },
  ],
};
