declare global {
  /** Stable package version injected by Vite `define` at build time. Absent (→ undefined)
   *  in dev / test contexts where no `define` runs. */
  const __APP_VERSION__: string | undefined;
  interface Window {
    /** Set by main.tsx once the bundle loaded + React started — read by the inline boot watchdog in
     *  index.html so it never shows the gray-screen recovery for a healthy boot. */
    __rcBooted?: boolean;
  }
}

/**
 * The stable package version this web bundle was built from. Compared against the server's GET /version
 * version to detect a stale precached bundle (see update/stale-client.ts). "dev" for an unstamped
 * build (local dev / tests) — which stale detection treats as "can't decide", so it never false-alarms.
 */
export const BUILD_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
/** Compatibility alias for callers crossing the v1 bridge. */
export const BUILD_SHA = BUILD_VERSION;
