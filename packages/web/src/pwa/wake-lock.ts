/**
 * Keep the SCREEN AWAKE while RoamCode is in the foreground (user request: "ekran kapanmamalı remote
 * coder öndeyken") — watching claude work shouldn't race the auto-lock timer.
 *
 * Uses the Screen Wake Lock API (iOS Safari 16.4+, Chrome/Android, desktop Chrome). The OS releases the
 * lock automatically whenever the page is hidden (app backgrounded / screen locked BY THE USER — both still
 * work normally), so this only suppresses the AUTO-dim while the app is actually on screen; we re-acquire on
 * every return to visibility. Everything is best-effort: no API / a denial (e.g. low-battery mode) is a
 * silent no-op, never an error.
 */

/** Structural typing instead of lib.dom's WakeLock types so older TS lib configs can't break the build. */
interface WakeLockSentinelLike {
  release?: () => Promise<void>;
  addEventListener?: (type: "release", cb: () => void) => void;
}
interface WakeLockNavigator {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
}

/** Start holding a screen wake lock while visible; returns a disposer (used by tests — the app holds it
 *  for its whole lifetime). Safe without the API (old browsers / jsdom): a no-op. */
export function installWakeLock(doc: Document = document, nav: WakeLockNavigator = navigator): () => void {
  let lock: WakeLockSentinelLike | undefined;
  let disposed = false;
  const acquire = async (): Promise<void> => {
    if (disposed || lock || !nav.wakeLock || doc.visibilityState !== "visible") return;
    try {
      const got = await nav.wakeLock.request("screen");
      // The OS can release it at any time (backgrounding, battery saver) — track that so the next
      // visibilitychange knows to re-request instead of thinking it still holds one.
      got.addEventListener?.("release", () => {
        lock = undefined;
      });
      // The tab may have gone hidden while the request was in flight — don't hold a lock we shouldn't.
      if (disposed || doc.visibilityState !== "visible") {
        void got.release?.().catch(() => {});
        return;
      }
      lock = got;
    } catch {
      /* denied (low battery / policy) or unavailable — the screen just dims as usual */
    }
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === "visible") void acquire();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  void acquire();
  return () => {
    disposed = true;
    doc.removeEventListener("visibilitychange", onVisibility);
    void lock?.release?.().catch(() => {});
    lock = undefined;
  };
}
