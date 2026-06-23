import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Server-side mirror of the web SW's `apiNavigationDenylist` (packages/web/src/pwa/sw-exclusions.ts),
 * EXTENDED with /health, /push and the /ws suffix. A request whose path matches one of these is a
 * live API/WS/health/push route — the SPA navigation fallback must NOT serve index.html for it (it
 * must hit the real handler), and the auth gate must NOT treat it as a public static asset.
 */
export const API_PATH_DENYLIST: RegExp[] = [/^\/sessions/, /^\/fs/, /^\/health/, /^\/push/, /\/ws$/];

/**
 * True for the PUBLIC static shell (HTML/JS/CSS/icons/manifest/sw + any SPA route) — served WITHOUT
 * a token so the login screen can load and THEN authenticate. A path is public iff it is NOT an
 * API/WS/health/push route. (The served bundle carries no secret: the token lives only in the
 * browser localStorage.)
 *
 * INVARIANT: a built shell asset must NEVER live at a path starting `/sessions`, `/fs`, `/ws`,
 * `/health`, or `/push`. This holds for the Vite build (assets are emitted under `/assets/`, plus
 * root `/index.html`, `/icon-*.svg`, `/manifest.webmanifest`, `/sw.js`) — none collide with the
 * denylist. If a future asset were ever emitted under one of those prefixes, this default-deny would
 * wrongly 401 a real asset to an unauthenticated shell load (the shell would fail to boot). Keep the
 * Vite output prefixes clear of the denylist, or special-case the asset path here.
 */
export function isPublicPath(path: string): boolean {
  return !API_PATH_DENYLIST.some((re) => re.test(path));
}

export interface RegisterStaticOptions {
  /** Absolute path to the built PWA (packages/web/dist). */
  webDir: string;
}

/**
 * Serve the built PWA at `/` with an SPA fallback: any GET navigation that is NOT a static file and
 * NOT an API/WS/health/push route returns index.html, so client-side routes (e.g. /login) work on a
 * hard refresh. The fallback is scoped by `isPublicPath` so an unknown /sessions/... never silently
 * resolves to the shell (it must 404/401 from the real handlers).
 */
export function registerStatic(app: FastifyInstance, opts: RegisterStaticOptions): void {
  app.register(fastifyStatic, { root: opts.webDir, wildcard: false });

  // SPA fallback for navigations to non-file public paths (e.g. /login, /sessions-ui deep links that
  // are CLIENT routes). `setNotFoundHandler` runs only when no route/file matched.
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && isPublicPath(request.url.split("?")[0] ?? "/")) {
      // sendFile is added to reply by @fastify/static.
      return (reply as unknown as { sendFile: (f: string) => unknown }).sendFile("index.html");
    }
    reply.code(404).send({ error: "not found" });
  });
}
