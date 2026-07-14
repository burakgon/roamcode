/// <reference types="vite-plugin-pwa/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import "./styles/global.css";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { installViewportSync } from "./pwa/viewport";
import { isIosWebKit } from "./pwa/platform";
import { respondToServiceWorkerVersionProbe } from "./pwa/sw-version-handshake";
import { applyTheme, loadTheme } from "./pwa/theme";
import { installWakeLock } from "./pwa/wake-lock";
import { migrateLegacyStorage } from "./storage-migration";
import { BUILD_VERSION } from "./build-info";

// Rename migration FIRST (before any storage read): move legacy `remote-coder.*` localStorage keys to
// `roamcode.*` so existing devices keep their token/theme/settings across the rename.
if (typeof localStorage !== "undefined") migrateLegacyStorage(localStorage);

// Apply the saved theme (dark / OLED true-black) BEFORE the first paint so there's no near-black→black flash.
applyTheme(loadTheme());

// Mirror the visual viewport into --app-height so the shell shrinks to the area above the on-screen keyboard
// (instead of the composer / terminal cursor hiding behind it). Started before render so the first paint is
// already keyboard-aware. Lives for the app's lifetime — no disposer needed.
installViewportSync();

// Keep the screen awake while the app is FOREGROUNDED (watching claude work shouldn't race the auto-lock
// timer). The OS still releases it when the app is backgrounded or the user locks the screen themselves.
installWakeLock();

// Auto-update the service worker (precached shell loads offline). With `registerType: "autoUpdate"` the new
// SW activates in the background (skipWaiting), but the OPEN page keeps running the stale JS until something
// reloads it. On NON-iOS we reload ONCE when a freshly-installed SW takes control, to pick up the new assets
// (guarded against the very first install so it never reload-loops on a fresh device).
//
// iOS/WebKit is EXCLUDED: an in-page reload — reload() OR replace() — FREEZES an iOS standalone PWA's
// compositor on the first post-OTA open (the screen stops repainting until the app is force-closed +
// reopened). That is exactly the reported "OTA sonrası ilk açılışta kilitleniyor" bug — the replace() the
// old comment claimed was safe is NOT. iOS PWAs pick up a new bundle reliably only on a full close+reopen
// anyway, and App.tsx surfaces a "close & reopen to update" banner — so on iOS we suppress the auto-reload
// entirely and let that close+reopen do it.
if (typeof navigator !== "undefined" && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    respondToServiceWorkerVersionProbe(event, BUILD_VERSION);
  });
  if (!isIosWebKit()) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading || !hadController) return;
      reloading = true;
      window.location.replace(window.location.href);
    });
  }
}
registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Last-resort boundary: a render crash anywhere shows a recoverable error (with Reload =
        hardRefresh) instead of a silent gray screen. */}
    <ErrorBoundary variant="full">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Tell the inline boot watchdog (index.html) that the bundle loaded + React started, so it never shows
// the gray-screen recovery for a healthy boot — and clear any overlay it raised during a slow load.
window.__rcBooted = true;
document.getElementById("rc-boot-recovery")?.remove();
