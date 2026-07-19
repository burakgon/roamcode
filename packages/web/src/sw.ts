/// <reference lib="webworker" />
import { precacheAndRoute, matchPrecache } from "workbox-precaching";
import {
  parsePushPayload,
  notificationOptions,
  clickTargetUrl,
  applyBadgeFromPush,
  urlIsWithinAppScope,
} from "./sw-handlers";
import { BUILD_VERSION } from "./build-info";
import { isIosLikePlatform } from "./pwa/platform";
import { clientRunsBuildVersion } from "./pwa/sw-version-handshake";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// Precache the built shell for OFFLINE use + serve the content-hashed (immutable) assets cache-first.
// Empty `directoryIndex` + `cleanURLs:false` stop workbox from auto-mapping a `/` NAVIGATION to the
// precached index.html — navigations go network-first below instead. (Asset requests, which never end in
// `/`, still match the precache route and stay cache-first.)
precacheAndRoute(self.__WB_MANIFEST, { directoryIndex: "", cleanURLs: false });

const FONT_CACHE = `roamcode-fonts-${BUILD_VERSION}`;

// Fontsource emits several language subsets and both modern/legacy formats. Pre-installing all of them made a first
// PWA activation download hundreds of unused kilobytes. Cache only the same-origin font files the browser actually
// selects; content-hashed URLs keep this cache immutable and an offline miss falls back to the system font cleanly.
self.addEventListener("fetch", (event: FetchEvent) => {
  if (event.request.destination !== "font") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(FONT_CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    })(),
  );
});

// NETWORK-FIRST navigations (the app-shell document). The server serves index.html no-cache and it always
// references the CURRENT content-hashed bundle, so fetching the shell fresh means a STALE precached shell can
// never strand the app on a 404 bundle — the white-screen-after-deploy trap. Offline → the precached shell.
self.addEventListener("fetch", (event: FetchEvent) => {
  if (event.request.mode !== "navigate") return; // assets fall through to precacheAndRoute (cache-first)
  event.respondWith(
    (async () => {
      try {
        return await fetch(event.request);
      } catch {
        return (await matchPrecache("/index.html")) ?? (await matchPrecache("index.html")) ?? Response.error();
      }
    })(),
  );
});

// Activate immediately so a freshly registered SW takes over without waiting for every tab to close.
self.addEventListener("install", () => void self.skipWaiting());

// On activate: take control of open non-iOS windows. The page-owned `controllerchange` handler performs the
// reload after activation has completed. Do not call WindowClient.navigate() from inside activate.waitUntil():
// the replacement navigation is then handled by a worker that is still activating, so a cold deep link can
// deadlock with its document request pending forever. The boot watchdog remains the explicit recovery path for
// a shell whose JavaScript cannot start.
self.addEventListener("activate", (event: ExtendableEvent) =>
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith("roamcode-fonts-") && name !== FONT_CACHE)
          .map((name) => caches.delete(name)),
      );
      // iOS/WebKit: do the activate-time takeover ONLY off iOS. On iOS this whole block is skipped BEFORE
      // clients.claim(), because claim() itself makes the open page's `controllerchange` fire → the old
      // bundle's own location.replace runs → and an in-page reload FREEZES a standalone PWA's compositor on
      // the first post-OTA open (the reported "OTA sonrası ilk açılışta kilitleniyor"). By not claiming and
      // not navigating, the currently-open page keeps running cleanly; the app shows a "close & reopen to
      // update" banner, and the next full close+reopen loads the new SW + bundle (the only reliable iOS PWA
      // update). Elsewhere, claim + navigate still rescues a stale/white shell without a freeze.
      const scope = self.registration.scope;
      const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((client) =>
        urlIsWithinAppScope(client.url, scope),
      );
      const workerNavigator = self.navigator;
      const maxTouchPoints = (workerNavigator as WorkerNavigator & { maxTouchPoints?: number }).maxTouchPoints ?? 0;
      if (isIosLikePlatform(workerNavigator?.userAgent ?? "", maxTouchPoints)) {
        // Never claim/navigate an open iOS PWA: that freezes its compositor. Instead ask open pages which
        // bundle they run. A pre-handshake or older page cannot report this worker's version, so unregister
        // the worker; the current page remains untouched and the next close/reopen is forced to the network.
        // A fresh install's page answers with the same version, preserving normal offline/push behavior.
        const currentClient = await Promise.all(windows.map((client) => clientRunsBuildVersion(client, BUILD_VERSION)));
        if (windows.length > 0 && !currentClient.some(Boolean)) await self.registration.unregister();
        return;
      }
      await self.clients.claim();
    })(),
  ),
);

// Web Push: show the notification the server sent, and set the home-screen app badge to the awaiting count
// carried in the payload — so the badge updates even when the app is CLOSED (the running app clears/refreshes
// it on foreground). Both are feature-detected/best-effort and never throw out of the handler.
self.addEventListener("push", (event: PushEvent) => {
  const payload = parsePushPayload(event.data?.text());
  applyBadgeFromPush(payload, self.navigator);
  event.waitUntil(
    self.registration.showNotification(payload.title, notificationOptions(payload, self.registration.scope)),
  );
});

// Notification click: focus an existing app window (deep-linking it to the session) or open one.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const scope = self.registration.scope;
  const url = clickTargetUrl(event.notification, scope);
  event.waitUntil(
    (async () => {
      const all = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((client) =>
        urlIsWithinAppScope(client.url, scope),
      );
      for (const client of all) {
        if ("focus" in client) {
          await (client as WindowClient).focus();
          if ("navigate" in client) await (client as WindowClient).navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
