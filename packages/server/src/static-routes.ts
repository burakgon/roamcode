import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Server-side mirror of the web SW's `apiNavigationDenylist` (packages/web/src/pwa/sw-exclusions.ts),
 * EXTENDED with /health, /push and the /ws suffix. A request whose path matches one of these is a
 * live API/WS/health/push route — the SPA navigation fallback must NOT serve index.html for it (it
 * must hit the real handler), and the auth gate must NOT treat it as a public static asset.
 *
 * SYNC INVARIANT: this denylist (and `isPublicForRequest` below) decides which requests skip the
 * token gate, while Fastify's find-my-way router decides which handler a request reaches. The two
 * MUST agree on path normalization, or a request can look public to the gate yet reach a protected
 * handler (an auth bypass). We gate on the DECODED path (`pathForGate`) to match the router's
 * percent-decoding, and we reject encoded separators (`hasEncodedSep`). If Fastify is ever
 * configured with `caseSensitive:false` or `ignoreDuplicateSlashes:true`, this gate must apply the
 * SAME case/slash normalization first, or those options will silently reopen the bypass.
 */
export const API_PATH_DENYLIST: RegExp[] = [
  /^\/sessions/,
  /^\/resumable/,
  /^\/fs/,
  /^\/images/,
  /^\/health/,
  /^\/push/,
  /^\/version/,
  /^\/update/,
  /^\/usage/,
  /^\/diag/,
  /^\/token\//,
  /^\/auth\//,
  /^\/claude\//,
  /^\/ws-ticket/,
  /\/ws$/,
];

/**
 * The EXPLICIT public-shell allowlist — the only paths the auth gate lets a REGISTERED route serve
 * without a token. It must cover exactly what an unauthenticated PWA boot needs (the login screen has to
 * render before a token exists): the root shell, the Vite asset dir, and the top-level bundle files
 * (index.html, sw.js, manifest.webmanifest, icons — matched by extension so a new icon the web build adds
 * doesn't need a server change). Everything else — including any FUTURE route nobody remembered to gate —
 * is token-gated by default (see the transport preHandler).
 *
 * SAFE because only static handlers live at these shapes: every API route is extensionless and no API
 * route sits at `/` or under `/assets/`. Keep it that way — an API route named like a top-level static
 * file (e.g. `/report.json`) would be silently public.
 */
export const SHELL_PATH_ALLOWLIST: RegExp[] = [
  /^\/$/,
  /^\/assets\//,
  /^\/[^/]+\.(?:html|js|css|map|json|webmanifest|txt|ico|png|svg|jpg|jpeg|gif|webp|woff2?)$/,
];

/** True for the static PWA shell paths above (the auth gate's explicit allowlist). */
export function isShellPath(path: string): boolean {
  return SHELL_PATH_ALLOWLIST.some((re) => re.test(path));
}

/**
 * Normalize a raw request URL to the path the FASTIFY ROUTER will route, for the auth gate.
 * find-my-way routes the percent-DECODED path, so we must gate on the decoded path too — otherwise
 * `GET /%73essions` (`%73`=`s`) looks public to a raw-path gate but routes to `/sessions`.
 * A malformed escape (decodeURIComponent throws) falls back to the raw path (still gated by the
 * caller's encoded-separator check), never crashing the gate.
 */
export function pathForGate(rawUrl: string): string {
  const raw = rawUrl.split("?")[0] ?? "/";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * True if the RAW (pre-decode) path carries an encoded slash or backslash (`%2f`/`%2F`/`%5c`/`%5C`).
 * find-my-way's handling of encoded slashes can desync from a single `decodeURIComponent`, and any
 * request that needs an encoded separator to look public is inherently suspicious — so we treat such
 * requests as NON-public (gated) regardless of what they decode to.
 */
export function hasEncodedSep(rawUrl: string): boolean {
  const raw = rawUrl.split("?")[0] ?? "/";
  return /%2f|%5c/i.test(raw);
}

/**
 * The auth-boundary decision for a real request: a request is public (skips the token gate / may get
 * the SPA shell) IFF it has no encoded separator AND its decoded path is a public static/shell path.
 * Both the preHandler bypass (transport.ts) and the SPA `setNotFoundHandler` MUST use this, so the
 * gate and the router agree on what is reachable.
 */
export function isPublicForRequest(rawUrl: string): boolean {
  return !hasEncodedSep(rawUrl) && isPublicPath(pathForGate(rawUrl));
}

/**
 * True for the PUBLIC static shell (HTML/JS/CSS/icons/manifest/sw + SPA navigations) — served WITHOUT
 * a token so the login screen can load and THEN authenticate. A path is public iff it is on the shell
 * allowlist, OR it is an extensionless NAVIGATION path (an SPA client route like `/login` gets
 * index.html on a hard refresh) outside the reserved API namespace. (The served bundle carries no
 * secret: the token lives only in the browser localStorage.)
 *
 * NOTE this predicate alone is NOT the auth boundary for routes: the transport preHandler is
 * DEFAULT-DENY — it only honors the navigation half of this when the request matched NO registered
 * route (fastify's `is404`), so a real handler can never hide behind an extensionless path. The
 * navigation half here also drives the SPA fallback in {@link registerStatic}'s notFound handler.
 *
 * INVARIANT: a built shell asset must NEVER live at a path starting `/sessions`, `/fs`, `/ws`,
 * `/health`, or `/push`. This holds for the Vite build (assets are emitted under `/assets/`, plus
 * root `/index.html`, `/icon-*.svg`, `/manifest.webmanifest`, `/sw.js`) — none collide with the
 * denylist. If a future asset were ever emitted under one of those prefixes, this default-deny would
 * wrongly 401 a real asset to an unauthenticated shell load (the shell would fail to boot). Keep the
 * Vite output prefixes clear of the denylist, or special-case the asset path here.
 */
export function isPublicPath(path: string): boolean {
  if (isShellPath(path)) return true;
  return !looksLikeAssetRequest(path) && !API_PATH_DENYLIST.some((re) => re.test(path));
}

/**
 * True if the path looks like a request for a static FILE — it lives under `/assets/` or its last
 * segment has an extension (e.g. `.js`/`.css`/`.png`/`.svg`). A file request that reaches the
 * notFound handler means the file does NOT exist on disk, so it must 404 — it must NOT fall back to
 * index.html. Serving the HTML shell for a missing `.js` makes the browser block the module script
 * (MIME mismatch → blank page) and can POISON a service-worker precache (HTML cached as the JS
 * entry). Only extensionless navigation paths (client routes like `/`, `/login`) get the SPA shell.
 *
 * Operational note: `@fastify/static` with `wildcard:false` globs the dist and registers one route
 * per file AT STARTUP, so after rebuilding the web bundle (new content-hashed filenames) the server
 * must be RESTARTED for the new assets to get routes — otherwise they reach this handler and (now)
 * correctly 404 instead of silently serving the shell.
 */
export function looksLikeAssetRequest(path: string): boolean {
  return path.startsWith("/assets/") || /\/[^/]+\.[a-z0-9]+$/i.test(path);
}

export interface RegisterStaticOptions {
  /** Absolute path to the built PWA (packages/web/dist). */
  webDir: string;
}

/**
 * Serve the built PWA at `/` with an SPA fallback: a GET NAVIGATION (extensionless, public, non-API)
 * that no static file matched returns index.html, so client routes (e.g. /login) work on a hard
 * refresh. A request that looks like a missing FILE (`/assets/*`, or any `*.ext`) is served LIVE from
 * disk when the file exists under webDir but @fastify/static's startup glob missed it (a build that
 * landed after this server started — an OTA window / manual rebuild); otherwise it returns 404, never
 * the shell — so a missing asset fails loudly instead of poisoning a browser/SW cache with HTML. An
 * unknown /sessions/... still 404/401s from the real handlers / the gate.
 */
export function registerStatic(app: FastifyInstance, opts: RegisterStaticOptions): void {
  app.register(fastifyStatic, { root: opts.webDir, wildcard: false });

  // The service worker is the OTA UPDATE TRIGGER: a client only swaps to a new bundle once the browser
  // sees a CHANGED sw.js. A cacheable sw.js therefore pins clients to a STALE bundle — behind Cloudflare a
  // cacheable sw.js inherits a multi-hour browser TTL, which silently blocked OTA updates from reaching
  // clients until that cache expired (and reopening the PWA kept serving the old bundle). Force sw.js
  // UNCACHED so every update check fetches it fresh and the OTA lands immediately. Cloudflare won't edge-
  // cache a no-store response, so origin headers pass straight through — no CDN config needed. Done in
  // onSend (not @fastify/static's setHeaders, which the plugin's own default cache-control overrides).
  // Content-hashed `/assets/*` are immutable, so their default caching is left untouched.
  // ALSO force the HTML SHELL (index.html — served at `/`, `/index.html`, and every SPA-fallback route)
  // uncached: the shell embeds the content-hashed asset filenames, so a cached shell keeps pointing the
  // browser at OLD assets — a stale bundle that survives an OTA even though the assets themselves rotated.
  // Detected by content-type (text/html) so the SPA fallback routes are covered too; hashed `/assets/*`
  // (JS/CSS) are immutable and keep their default long-cache.
  app.addHook("onSend", async (request, reply, payload) => {
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (pathForGate(request.url) === "/sw.js" || contentType.includes("text/html")) {
      reply.header("cache-control", "no-store, no-cache, must-revalidate");
    }
    return payload;
  });

  app.setNotFoundHandler((request, reply) => {
    const sendFile = (reply as unknown as { sendFile: (f: string) => unknown }).sendFile.bind(reply);
    const path = pathForGate(request.url);
    if (request.method === "GET" && isPublicForRequest(request.url)) {
      if (looksLikeAssetRequest(path)) {
        // An asset @fastify/static didn't serve. With `wildcard:false` it freezes the asset route list
        // at STARTUP, so a build that landed AFTER this server started — an OTA's build→restart window,
        // a manual rebuild, a parallel deploy — has new content-hashed `/assets/*` with NO route. The
        // freshly-served index.html points at exactly those, so without this they 404 and the app fails
        // to boot until a restart re-globs. Serve such a file LIVE from disk (constrained to webDir) so
        // the update window never 404s; a genuinely missing file still 404s (never the HTML shell, which
        // would poison a browser/SW cache).
        const rel = path.replace(/^\/+/, "");
        const abs = resolve(opts.webDir, rel);
        const root = resolve(opts.webDir);
        if ((abs === root || abs.startsWith(root + sep)) && existsSync(abs)) {
          return sendFile(rel);
        }
        reply.code(404).send({ error: "not found" });
        return;
      }
      // A GET NAVIGATION (extensionless, public, non-API) that matched no file → the SPA shell.
      return sendFile("index.html");
    }
    reply.code(404).send({ error: "not found" });
  });
}
