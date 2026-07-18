// The deployed PWA talks to its own origin; dev can override via VITE_API_BASE_URL.
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin;

export type ProductMode = "standalone" | "cloud";

/** Product behavior is explicit. A URL prefix is routing, not a reliable statement about the product mode. */
export const PRODUCT_MODE: ProductMode =
  (import.meta.env.VITE_PRODUCT_MODE as string | undefined) === "cloud" ? "cloud" : "standalone";

/** Same-origin Cloud workbench embeds the encrypted terminal without duplicating global navigation. */
export const EMBEDDED_CLOUD =
  PRODUCT_MODE === "cloud" && new URLSearchParams(window.location.search).get("embed") === "1";
