/**
 * Detect when the RUNNING web bundle is older than the deployed server build — the failure that made OTA
 * fixes silently never reach a device. The footer version + "update available" banner are driven by the
 * SERVER's git (HEAD vs origin), so a phone stuck on an old precached bundle shows the server's current
 * version (looks up-to-date) and never prompts — running ancient JS forever. The bundle now carries its
 * OWN build sha (Vite `__BUILD_SHA__`); comparing it to the server's `/version` sha exposes the gap so the
 * client can force a hard refresh. Generic by design: it catches ANY stale bundle, not just one bug.
 */

/** A non-real build stamp (a dev/CI build with no git) — never treated as "stale", we just can't decide. */
const UNKNOWN_SHAS = new Set(["", "dev", "unknown"]);

/**
 * Pull the short commit sha out of a `v<YYYY.MM.DD> · <sha>` version label (the shape the server's
 * versionLabel() emits, e.g. "v2026.06.27 · 0888250" or the bare "· abc1234"). Returns undefined when the
 * label is absent or carries no sha segment.
 */
export function shaFromVersionLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const idx = label.lastIndexOf("·");
  if (idx < 0) return undefined;
  const sha = label.slice(idx + 1).trim();
  return sha.length > 0 ? sha : undefined;
}

/**
 * True when the running bundle (`buildSha`, baked in at build time) is a DIFFERENT commit than the server
 * is now serving (`serverLabel`, from GET /version). Compared by prefix so a longer git abbreviation of the
 * same commit isn't a false positive. Returns false ("can't decide") when either sha is unknown — a dev
 * build with no stamp, or a server label with no sha — so it never nags without real evidence.
 */
export function isClientStale(buildSha: string | undefined, serverLabel: string | undefined): boolean {
  const build = (buildSha ?? "").trim();
  if (UNKNOWN_SHAS.has(build)) return false;
  const server = shaFromVersionLabel(serverLabel);
  if (server === undefined) return false;
  return !build.startsWith(server) && !server.startsWith(build);
}

/** sessionStorage key recording the server version we already auto-refreshed for (loop guard). */
const AUTO_REFRESH_GUARD = "rc_stale_refresh_for";

/**
 * Claim the ONE automatic hard-refresh allowed per server version per session, recording the attempt so a
 * refresh that didn't actually land never loops. Returns true the first time a given server sha is seen as
 * stale (→ caller auto-refreshes); false on any later detection of the SAME sha (→ caller shows a manual
 * "Refresh" banner instead) or when the label has no sha to key on. `storage` is sessionStorage in the app;
 * the guard resets when the app is fully closed, so a later launch gets a fresh attempt.
 */
export function claimAutoRefresh(
  serverLabel: string | undefined,
  storage: Pick<Storage, "getItem" | "setItem">,
): boolean {
  const sha = shaFromVersionLabel(serverLabel);
  if (sha === undefined) return false;
  if (storage.getItem(AUTO_REFRESH_GUARD) === sha) return false;
  storage.setItem(AUTO_REFRESH_GUARD, sha);
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
  if (typeof window !== "undefined") window.location.reload();
}
