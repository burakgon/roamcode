// The deployed PWA talks to its own origin; dev can override via VITE_API_BASE_URL.
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin;
