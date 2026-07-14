/**
 * iOS / iPadOS WebKit detection — the single source of truth (used by main.tsx's SW-reload guard and App.tsx's
 * stale/update logic). On iOS, JS-driven IN-PAGE reloads (`location.replace`/`reload`, the service-worker
 * `controllerchange` auto-reload, a hard refresh) FREEZE the standalone compositor: the screen stops
 * repainting until the app is fully closed + reopened — which is ALSO the only reliable way an iOS PWA picks
 * up a new bundle. So on iOS we suppress every automatic reload and let that close+reopen do the update.
 *
 * Detects iPhone/iPod/iPad — including iPadOS 13+, which spoofs a "Macintosh" UA but reports touch points.
 */
export function isIosLikePlatform(userAgent: string, maxTouchPoints = 0): boolean {
  return /iP(hone|od|ad)/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function isIosWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  return isIosLikePlatform(navigator.userAgent || "", navigator.maxTouchPoints || 0);
}
