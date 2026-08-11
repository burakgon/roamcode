import type { SessionMeta } from "../types/server";

/**
 * APP BADGE count = the number of sessions currently AWAITING the user (a pending permission/question,
 * `meta.awaiting`). It's the same "needs you" signal the rail shows, surfaced as a glanceable home-screen
 * badge so a backgrounded session that needs an answer is visible without opening the app. Pure; counts
 * Only sessions needing the user contribute: the compatibility `awaiting` flag or authoritative blocked
 * agent activity. Mirrors session/SessionList's `awaitingCount` so the in-app and home-screen badges agree.
 */
export function badgeCount(sessions: Pick<SessionMeta, "awaiting" | "activity" | "agent">[]): number {
  return sessions.reduce(
    (n, session) => (session.awaiting || (session.agent?.activity ?? session.activity) === "blocked" ? n + 1 : n),
    0,
  );
}

/** True iff this browser exposes the App Badging API (Chrome/Edge/installed PWAs). iOS Safari lacks it —
 *  callers degrade silently (no-op). Guarded for non-DOM/test envs where `navigator` is absent. */
function badgingSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.setAppBadge === "function";
}

/**
 * Set (or clear) the home-screen app badge to `count`, FEATURE-DETECTED. A positive count sets the badge;
 * 0 clears it (via clearAppBadge when available, else setAppBadge(0)). A no-op where the App Badging API
 * is unsupported (iOS Safari) so it degrades silently. Best-effort: setAppBadge returns a promise that can
 * reject (permissions/transient) — swallow it so a badge failure never surfaces as an unhandled rejection.
 */
export function applyAppBadge(count: number): void {
  if (!badgingSupported()) return;
  try {
    if (count > 0) {
      void navigator.setAppBadge(count)?.catch(() => {});
    } else if (typeof navigator.clearAppBadge === "function") {
      void navigator.clearAppBadge()?.catch(() => {});
    } else {
      void navigator.setAppBadge(0)?.catch(() => {});
    }
  } catch {
    // setAppBadge can throw synchronously on some engines for an out-of-range value — never let it escape.
  }
}
