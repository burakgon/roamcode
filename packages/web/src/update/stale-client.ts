/**
 * Detect when the running web bundle has a different stable package version from the deployed server.
 * Both stamps come from the release version; commit abbreviations are deliberately not part of identity.
 */

/** A non-release stamp (a dev/test build) is never treated as stale because we cannot decide safely. */
const UNKNOWN_VERSIONS = new Set(["", "dev", "unknown"]);
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Normalize the server's `vX.Y.Z` label to `X.Y.Z`. Prerelease/build metadata is excluded because the OTA
 * channel deliberately offers stable versions only.
 */
export function versionFromServerLabel(label: string | undefined): string | undefined {
  const version = (label ?? "").trim().replace(/^v/, "");
  return STABLE_VERSION.test(version) ? version : undefined;
}

/** Compatibility name retained for one precache cycle; it now returns the SemVer value. */
export const shaFromVersionLabel = versionFromServerLabel;

/**
 * True when the running bundle and server report different stable package versions. Returns false when
 * either side is a dev/unrecognized value, so the PWA never reloads without real release evidence.
 */
export function isClientStale(buildVersion: string | undefined, serverLabel: string | undefined): boolean {
  const build = (buildVersion ?? "").trim().replace(/^v/, "");
  if (UNKNOWN_VERSIONS.has(build) || !STABLE_VERSION.test(build)) return false;
  const server = versionFromServerLabel(serverLabel);
  if (server === undefined) return false;
  return build !== server;
}

/** sessionStorage key recording the server version we already auto-refreshed for (loop guard). */
const AUTO_REFRESH_GUARD = "rc_stale_refresh_for";

/**
 * Claim the ONE automatic hard-refresh allowed per server version per session, recording the attempt so a
 * refresh that did not land never loops. A later version gets a fresh attempt.
 */
export function claimAutoRefresh(
  serverLabel: string | undefined,
  storage: Pick<Storage, "getItem" | "setItem">,
): boolean {
  const version = versionFromServerLabel(serverLabel);
  if (version === undefined) return false;
  if (storage.getItem(AUTO_REFRESH_GUARD) === version) return false;
  storage.setItem(AUTO_REFRESH_GUARD, version);
  return true;
}

/**
 * Force the browser to drop a stale precached bundle and reload onto the deployed one: unregister every
 * service worker and delete every Cache so the next navigation bypasses the SW precache entirely and
 * re-fetches the shell from origin (sw.js + index.html are served no-store/no-cache). Best-effort — a
 * cleanup failure still reloads. This is the lever the SW's own auto-update doesn't reliably pull on iOS.
 */
export async function hardRefresh(): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // best-effort: reload anyway below
  }
  // replace(href), NOT reload(): this runs AUTOMATICALLY on the stale-bundle self-heal (App.tsx), and an
  // in-place reload() in iOS Safari/standalone can leave the compositor frozen — the DOM updates + input
  // works, but the screen stops repainting while the "old version" banner is up. A replace() navigation
  // swaps onto the fresh bundle without that freeze. (The SW/caches are already dropped above, so it re-
  // fetches from origin regardless.)
  if (typeof window !== "undefined") window.location.replace(window.location.href);
}
