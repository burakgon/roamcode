/**
 * Routes the service worker must NEVER serve from the precached shell. The navigation
 * fallback (serving `index.html` for app routes) is denied for the live API so those requests
 * always hit the network with the current auth token — a cached/unauthorized API response
 * would serve stale or wrong-session data and break the app. The WebSocket (`ws://`/`wss://`)
 * is never matched by a fetch route at all, so it is inherently untouched by the SW.
 */
export const apiNavigationDenylist: RegExp[] = [/^\/sessions/, /^\/fs/, /^\/pairing/, /^\/devices/, /^\/api/];
