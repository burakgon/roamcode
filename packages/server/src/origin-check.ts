/**
 * Origin / CSWSH (cross-site WebSocket hijacking) guard for the WS upgrade and state-changing HTTP.
 *
 * The token is the only auth boundary, and it can leak into a URL (`?token=` connect link, push deep
 * link, browser history). The WS handshake (and any browser-driven HTTP) carries an `Origin` header the
 * page CANNOT forge — so a malicious cross-origin page that somehow holds the token still can't make the
 * BROWSER attach to our WS / drive our API, because the browser stamps its OWN origin on the request and
 * we reject it. Without this check, a leaked-in-URL token is enough for a foreign page to puppet the host.
 *
 * SAFE DEFAULT (must never reject the real app): a request is allowed when
 *   - the `Origin` header is ABSENT (native/non-browser clients, same-origin navigations + most
 *     same-origin GETs omit it — the PWA's own fetches are same-origin), OR
 *   - the Origin's host:port equals the request `Host` (same-origin — the PWA always is), OR
 *   - the Origin matches the configured public URL (ROAMCODE_PUBLIC_URL), OR
 *   - the Origin is a loopback/localhost origin (local dev), OR
 *   - the Origin is in the explicit ROAMCODE_ALLOWED_ORIGINS allow-list.
 * Only a PRESENT, cross-origin, non-allow-listed Origin is rejected (403).
 */

/** Normalize a URL/origin string to a comparable `scheme://host[:port]` origin (lowercased). Returns
 *  undefined for anything that isn't a parseable absolute URL (so it can never match by accident). */
export function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return undefined; // a sandboxed/opaque origin serializes to "null"
  try {
    const u = new URL(trimmed);
    // `URL.origin` is `scheme://host[:port]` with the default port elided — exactly the comparison we want.
    return u.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True if a host (no scheme) is a loopback/localhost name. Accepts a bare host or host:port. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, ""); // drop a :port suffix
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** True if a normalized origin (`scheme://host[:port]`) is loopback. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

export interface OriginCheckOptions {
  /** The configured public-facing origin (from ROAMCODE_PUBLIC_URL). May be a full URL. */
  publicUrl?: string;
  /** Extra allow-listed origins (ROAMCODE_ALLOWED_ORIGINS, comma-separated → array). */
  allowedOrigins?: string[];
}

/**
 * Decide whether a request's Origin is allowed. PURE / I/O-free so it is unit-testable; the transport
 * preHandler passes `origin` (the header) and `host` (the request Host header).
 *
 * @param origin the request's `Origin` header (may be undefined)
 * @param host   the request's `Host` header (e.g. `remotecode.example.com` or `127.0.0.1:4280`)
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  opts: OriginCheckOptions = {},
): boolean {
  // Absent Origin → allow (native clients, same-origin navigations + most same-origin GETs omit it). A
  // present-but-unparseable / opaque ("null") Origin normalizes to undefined and is treated the same way
  // (it cannot be a real cross-origin browser page driving us — those send a concrete origin).
  const reqOrigin = normalizeOrigin(origin);
  if (reqOrigin === undefined) return true;

  // Same-origin: the Origin's host:port equals the request Host. The PWA (served same-origin) always is.
  if (host) {
    const sameOriginHost = (() => {
      try {
        return new URL(reqOrigin).host.toLowerCase() === host.trim().toLowerCase();
      } catch {
        return false;
      }
    })();
    if (sameOriginHost) return true;
  }

  // Loopback origin (local dev directly against 127.0.0.1/localhost).
  if (isLoopbackOrigin(reqOrigin)) return true;

  // Configured public URL (the tunnel/user-facing origin the PWA is actually installed under).
  const publicOrigin = normalizeOrigin(opts.publicUrl);
  if (publicOrigin !== undefined && reqOrigin === publicOrigin) return true;

  // Explicit allow-list extension.
  for (const extra of opts.allowedOrigins ?? []) {
    if (normalizeOrigin(extra) === reqOrigin) return true;
  }

  return false;
}

/** Parse a comma-separated ROAMCODE_ALLOWED_ORIGINS value into a trimmed, non-empty list. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
