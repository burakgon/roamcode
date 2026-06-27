declare global {
  /** Git short sha injected by Vite `define` at build time (see vite.config.ts). Absent (→ undefined)
   *  in dev / test contexts where no `define` runs. */
  const __BUILD_SHA__: string | undefined;
}

/**
 * The git short sha this web bundle was BUILT from, baked in at build time. Compared against the server's
 * GET /version sha to detect a stale precached bundle (see update/stale-client.ts). "dev" for an unstamped
 * build (local dev / tests) — which stale detection treats as "can't decide", so it never false-alarms.
 */
export const BUILD_SHA: string = __BUILD_SHA__ ?? "dev";
