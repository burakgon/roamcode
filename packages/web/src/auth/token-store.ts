// SECURITY: the access token is stored in localStorage — readable by any script in this
// origin (XSS-exposed). This is an accepted trade-off for a single-user self-hosted tool
// (spec §9). Do not store anything more sensitive here.
const KEY = "roamcode.token";

export function loadToken(): string | undefined {
  const v = localStorage.getItem(KEY);
  return v === null ? undefined : v;
}

export function saveToken(token: string): void {
  localStorage.setItem(KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(KEY);
}

/**
 * On first load, accept the access token from the URL `?token=` query param (the connect link the
 * server prints), persist it, and strip it from the URL so the secret does not linger in the address
 * bar / browser history / referer header. Any other query params (e.g. `?session=` from a push
 * deep-link) are preserved. Returns the token if one was present, else undefined.
 */
export function consumeTokenFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  const t = params.get("token");
  if (t === null || t === "") return undefined;
  saveToken(t);
  params.delete("token");
  const qs = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
  return t;
}
