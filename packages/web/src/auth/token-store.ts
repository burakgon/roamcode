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

/**
 * Consume a one-time pairing capability from `#pair=` and remove it immediately. Unlike the legacy
 * `?token=` path it is NOT persisted: App exchanges it for a distinct device credential first.
 */
export function consumePairingFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  // Fragment is the secure/current format (never sent to a proxy); query support is a one-release
  // compatibility path for links created by an earlier preview implementation.
  const secret = fragment.get("pair") ?? params.get("pair");
  if (secret === null || secret === "") return undefined;
  params.delete("pair");
  fragment.delete("pair");
  const qs = params.toString();
  const hash = fragment.toString();
  window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : "") + (hash ? `#${hash}` : ""));
  return secret;
}
