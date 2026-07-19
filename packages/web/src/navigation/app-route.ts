export const APP_DESTINATIONS = ["sessions", "automations", "agents"] as const;

export type AppDestination = (typeof APP_DESTINATIONS)[number];

export const APP_PATH_PREFIX = "/app";

export const APP_DESTINATION_PATHS = {
  sessions: `${APP_PATH_PREFIX}/sessions`,
  automations: `${APP_PATH_PREFIX}/automations`,
  agents: `${APP_PATH_PREFIX}/agents`,
} as const satisfies Record<AppDestination, string>;

const DESTINATION_BY_PATH = new Map<string, AppDestination>(
  APP_DESTINATIONS.map((destination) => [APP_DESTINATION_PATHS[destination], destination]),
);

/** Resolve an app pathname without letting unknown URLs create an invalid product destination. */
export function destinationFromPathname(pathname: string): AppDestination {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return DESTINATION_BY_PATH.get(normalizedPath) ?? "sessions";
}

export function currentAppDestination(): AppDestination {
  return destinationFromPathname(window.location.pathname);
}

/**
 * Move between product destinations while preserving session deep links and pairing fragments.
 * The caller owns UI state changes; this helper only writes browser history.
 */
export function navigateToDestination(destination: AppDestination): void {
  const nextUrl = `${APP_DESTINATION_PATHS[destination]}${window.location.search}${window.location.hash}`;
  window.history.pushState(window.history.state, "", nextUrl);
}

/** Subscribe to browser back/forward destination changes. */
export function subscribeToDestinationChanges(listener: (destination: AppDestination) => void): () => void {
  const onPopState = () => listener(currentAppDestination());
  window.addEventListener("popstate", onPopState);
  return () => window.removeEventListener("popstate", onPopState);
}
