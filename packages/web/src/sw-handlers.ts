export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  /** APP BADGE: total awaiting-session count at send time, so the SW can set the home-screen badge even
   *  while the app is CLOSED. Absent (older server / malformed) → the SW leaves the badge alone. */
  badgeCount?: number;
  /** Re-alert even when a notification with the SAME `tag` is already showing. Each session carries a
   *  DISTINCT tag, so two different waiting sessions never collapse into one; `renotify` is what makes a
   *  SECOND alert for the SAME session (same tag) buzz again instead of silently updating in place.
   *  Absent → the browser default (false). */
  renotify?: boolean;
  /** Keep the notification on screen until the user acts on it (desktop), for a prompt that must not be
   *  missed. Absent → the browser default (false). */
  requireInteraction?: boolean;
}

interface AppScope {
  origin: string;
  pathname: string;
  entryPath: string;
}

function appScope(rawScope = "/"): AppScope {
  const currentOrigin =
    typeof globalThis.location?.origin === "string" && globalThis.location.origin !== "null"
      ? globalThis.location.origin
      : "https://roamcode.invalid";
  const scope = new URL(rawScope, currentOrigin);
  const pathname = scope.pathname.endsWith("/") ? scope.pathname : `${scope.pathname}/`;
  return {
    origin: scope.origin,
    pathname,
    entryPath: pathname === "/" ? "/" : `${pathname}sessions`,
  };
}

/** Keep notification navigation inside the PWA registration that received the push. */
export function appScopedNotificationUrl(rawUrl: string, rawScope = "/"): string {
  const scope = appScope(rawScope);
  let target: URL;
  try {
    target = new URL(rawUrl, scope.origin);
  } catch {
    return scope.entryPath;
  }
  if (target.origin !== scope.origin) return scope.entryPath;
  if (scope.pathname !== "/") {
    const scopeRoot = scope.pathname.slice(0, -1);
    if (target.pathname === "/" || target.pathname === scopeRoot || target.pathname === scope.pathname) {
      target.pathname = scope.entryPath;
    } else if (!target.pathname.startsWith(scope.pathname)) {
      return scope.entryPath;
    }
  }
  return `${target.pathname}${target.search}${target.hash}`;
}

/** A scoped worker must never focus or reload an unrelated same-origin account/marketing tab. */
export function urlIsWithinAppScope(rawUrl: string, rawScope = "/"): boolean {
  const scope = appScope(rawScope);
  try {
    const target = new URL(rawUrl, scope.origin);
    if (target.origin !== scope.origin) return false;
    if (scope.pathname === "/") return true;
    return target.pathname === scope.pathname.slice(0, -1) || target.pathname.startsWith(scope.pathname);
  } catch {
    return false;
  }
}

/** Defensive parse: the push body is attacker-influenced-ish (it comes from the push service), so a
 * malformed/empty payload must never throw inside the SW push handler — fall back to a generic shape. */
export function parsePushPayload(raw: string | undefined): PushPayload {
  const fallback: PushPayload = {
    title: "RoamCode",
    body: "A session needs your attention",
    url: "/",
    tag: "roamcode",
  };
  if (!raw) return fallback;
  try {
    const obj = JSON.parse(raw) as Partial<PushPayload>;
    return {
      title: typeof obj.title === "string" ? obj.title : fallback.title,
      body: typeof obj.body === "string" ? obj.body : fallback.body,
      url: typeof obj.url === "string" ? obj.url : fallback.url,
      tag: typeof obj.tag === "string" ? obj.tag : fallback.tag,
      // Only carry a finite, non-negative integer count (defensive against a malformed/poisoned payload);
      // anything else is dropped so the SW leaves the badge untouched.
      ...(typeof obj.badgeCount === "number" && Number.isInteger(obj.badgeCount) && obj.badgeCount >= 0
        ? { badgeCount: obj.badgeCount }
        : {}),
      // Booleans are carried only when the server actually sent them, so an absent flag stays a browser
      // default rather than a forced false (and `toEqual` on a minimal payload sees no extra keys).
      ...(typeof obj.renotify === "boolean" ? { renotify: obj.renotify } : {}),
      ...(typeof obj.requireInteraction === "boolean" ? { requireInteraction: obj.requireInteraction } : {}),
    };
  } catch {
    return fallback;
  }
}

/**
 * APP BADGE from a push: set the home-screen badge to the count carried in the push PAYLOAD, so a
 * backgrounded/closed app still shows a glanceable "needs you" count. FEATURE-DETECTED (the App Badging
 * API is absent on iOS Safari) and best-effort (the promise can reject) so it degrades silently and never
 * throws inside the SW push handler. A payload with no `badgeCount` (older server) leaves the badge alone.
 * `nav` is injectable for tests; defaults to the SW global `self.navigator`.
 */
export function applyBadgeFromPush(
  payload: PushPayload,
  nav: { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> } | undefined,
): void {
  if (payload.badgeCount === undefined) return;
  if (!nav || typeof nav.setAppBadge !== "function") return;
  try {
    if (payload.badgeCount > 0) {
      void nav.setAppBadge(payload.badgeCount)?.catch(() => {});
    } else if (typeof nav.clearAppBadge === "function") {
      void nav.clearAppBadge()?.catch(() => {});
    } else {
      void nav.setAppBadge(0)?.catch(() => {});
    }
  } catch {
    // never let a badge failure escape into the SW push handler
  }
}

export function notificationOptions(p: PushPayload, scope = "/"): NotificationOptions {
  const icon = `${appScope(scope).pathname}icon-192.svg`;
  return {
    body: p.body,
    // A DISTINCT tag per session keeps a second waiting session from silently replacing the first;
    // `renotify` (needs a tag, which is always set) re-alerts on a repeat for the SAME session.
    tag: p.tag,
    icon,
    badge: icon,
    // Pass the flags through only when the payload set them, so an absent flag keeps the browser default
    // instead of forcing false. `renotify` without a tag throws — but the tag above is always present.
    ...(p.renotify !== undefined ? { renotify: p.renotify } : {}),
    ...(p.requireInteraction !== undefined ? { requireInteraction: p.requireInteraction } : {}),
    data: { url: appScopedNotificationUrl(p.url, scope) },
  };
}

export function clickTargetUrl(notification: { data?: unknown }, scope = "/"): string {
  const data = notification.data as { url?: unknown } | undefined;
  return appScopedNotificationUrl(typeof data?.url === "string" ? data.url : "/", scope);
}
