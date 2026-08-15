// The deployed PWA talks to its own origin; dev can override via VITE_API_BASE_URL.
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin;

/**
 * The published troubleshooting guide. RoamCode's docs are thorough, but nothing in the app linked to them —
 * a stuck user on a phone had no route from the failure they were looking at to the page that explains it.
 * The Node itself serves no docs, so this points at the public repository copy.
 */
export const TROUBLESHOOTING_URL = "https://github.com/burakgon/roamcode/blob/main/docs/troubleshooting.md";
