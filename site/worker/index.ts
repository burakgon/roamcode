import { isPublicDocumentPath, renderPublicDocument } from "../src/public-documents";

/**
 * roamcode.ai edge worker — static assets, hosted-account routing, and two public endpoints:
 *   /app, /activate → same-origin account shell; /api/auth/* and /api/v1/* proxy privately
 *   /terminal/*     → the real PWA shell and its static assets; Node data remains on its relay transport
 *   GET /api/stars  → { stars } from GitHub, edge-cached 5 min (client never hits GitHub's rate limit)
 *   GET /install    → scripts/install.sh proxied from the repo, 5 min cache, correct content-type
 *                     (this is what `curl -fsSL https://roamcode.ai/install | bash` downloads)
 */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Preferred private Worker-to-Worker binding for the hosted account control plane. */
  CONTROL_PLANE?: { fetch(request: Request): Promise<Response> };
  /** Reviewed HTTPS origin fallback when a service binding is not available. */
  CONTROL_PLANE_ORIGIN?: string;
  /** Non-secret identifier for the active edge HMAC key. */
  CONTROL_PLANE_EDGE_AUTH_KEY_ID?: string;
  /** Wrangler secret shared only with the control plane verification keyring. */
  CONTROL_PLANE_EDGE_AUTH_SECRET?: string;
}

const REPO_API = "https://api.github.com/repos/burakgon/roamcode";
const INSTALL_SH = "https://raw.githubusercontent.com/burakgon/roamcode/main/scripts/install.sh";
const PUBLIC_REPOSITORY_URL = REPO_API.replace("https://api.github.com/repos/", "https://github.com/");
const TTL = 300;
const EDGE_SIGNATURE_DOMAIN = "roamcode-edge-client-ip-v1";
const CANONICAL_ORIGIN = "https://roamcode.ai";
const LEGACY_APP_HOST = "app.roamcode.ai";

const ACCOUNT_API_PREFIXES = ["/api/auth/", "/api/v1/"] as const;
const ACCOUNT_SHELL_PATHS = new Set([
  "/app",
  "/app/sessions",
  "/app/automations",
  "/app/agents",
  "/app/account",
  "/app/people",
  "/app/reset-password",
  "/activate",
  "/invite",
]);
const TERMINAL_DESTINATIONS = new Set(["sessions", "automations", "agents"]);
const SOURCE_DESTINATIONS = new Map([
  ["/source", ""],
  ["/source/license", "/blob/main/LICENSE"],
  ["/source/security", "/security"],
  ["/source/security-policy", "/blob/main/SECURITY.md"],
  ["/source/discussions", "/discussions"],
]);

function isAccountApi(pathname: string): boolean {
  return ACCOUNT_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isAccountShellPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ACCOUNT_SHELL_PATHS.has(normalized);
}

function isTerminalShellPath(pathname: string): boolean {
  if (pathname === "/terminal" || pathname === "/terminal/") return true;
  const match = /^\/terminal\/([^/]+)\/?$/.exec(pathname);
  return match ? TERMINAL_DESTINATIONS.has(match[1] ?? "") : false;
}

function sourceRedirect(request: Request, pathname: string): Response | undefined {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const destination = SOURCE_DESTINATIONS.get(normalized);
  if (destination === undefined) return;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: `${PUBLIC_REPOSITORY_URL}${destination}`,
      "cache-control": "public, max-age=300",
      "referrer-policy": "no-referrer",
    },
  });
}

function unavailableControlPlane(): Response {
  return Response.json(
    {
      error: "cloud_unavailable",
      error_description: "The RoamCode account service is not configured on this deployment.",
    },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "retry-after": "30",
      },
    },
  );
}

function verifiedControlPlaneOrigin(raw: string | undefined, requestOrigin: string): string | undefined {
  if (!raw) return;
  try {
    const url = new URL(raw.trim());
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.origin === requestOrigin
    ) {
      return;
    }
    return url.origin;
  } catch {
    return;
  }
}

function isValidClientIp(value: string): boolean {
  if (value.length === 0 || value.length > 45 || value.trim() !== value) return false;
  if (value.includes(":")) {
    if (!/^[0-9A-Fa-f:.]+$/.test(value)) return false;
    try {
      return new URL(`http://[${value}]/`).hostname.length > 2;
    } catch {
      return false;
    }
  }
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

function edgeSignaturePayload(input: { timestamp: string; method: string; target: string; clientIp: string }): string {
  return [EDGE_SIGNATURE_DOMAIN, input.timestamp, input.method, input.target, input.clientIp].join("\n");
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function signEdgeClientIp(
  secret: string,
  input: { timestamp: string; method: string; target: string; clientIp: string },
): Promise<string> {
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);
  if (secretBytes.byteLength < 32 || secretBytes.byteLength > 4_096) {
    throw new Error("Edge authentication is not configured");
  }
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(edgeSignaturePayload(input))));
}

async function proxyRequest(request: Request, target: URL, env: Env): Promise<Request> {
  const clientIp = request.headers.get("cf-connecting-ip") ?? "";
  const keyId = env.CONTROL_PLANE_EDGE_AUTH_KEY_ID?.trim() ?? "";
  const secret = env.CONTROL_PLANE_EDGE_AUTH_SECRET ?? "";
  if (!isValidClientIp(clientIp) || !/^[A-Za-z0-9._:-]{1,256}$/.test(keyId)) {
    throw new Error("Edge authentication is not configured");
  }
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const method = request.method.toUpperCase();
  const requestTarget = `${target.pathname}${target.search}`;
  const signature = await signEdgeClientIp(secret, {
    timestamp,
    method,
    target: requestTarget,
    clientIp,
  });
  const headers = new Headers(request.headers);
  const publicUrl = new URL(request.url);
  // These headers belong to the private proxy hop. Never accept a browser-supplied copy.
  headers.delete("cf-connecting-ip");
  headers.delete("host");
  headers.delete("true-client-ip");
  headers.delete("x-roamcode-client-ip");
  headers.delete("x-roamcode-edge-client-ip");
  headers.delete("x-roamcode-edge-key-id");
  headers.delete("x-roamcode-edge-signature");
  headers.delete("x-roamcode-edge-timestamp");
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-real-ip",
  ]) {
    headers.delete(name);
  }
  headers.set("x-forwarded-host", publicUrl.host);
  headers.set("x-forwarded-proto", publicUrl.protocol.slice(0, -1));
  headers.set("x-forwarded-port", publicUrl.port || (publicUrl.protocol === "https:" ? "443" : "80"));
  headers.set("x-roamcode-edge-client-ip", clientIp);
  headers.set("x-roamcode-edge-key-id", keyId);
  headers.set("x-roamcode-edge-signature", signature);
  headers.set("x-roamcode-edge-timestamp", timestamp);
  return new Request(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}

function privateAccountResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, private");
  headers.set("pragma", "no-cache");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyAccountApi(request: Request, env: Env): Promise<Response> {
  const incoming = new URL(request.url);
  try {
    if (env.CONTROL_PLANE) {
      // Keep the public URL intact for Better Auth callbacks and same-origin cookies; the binding
      // decides which private service receives the request.
      return privateAccountResponse(await env.CONTROL_PLANE.fetch(await proxyRequest(request, incoming, env)));
    }
    const origin = verifiedControlPlaneOrigin(env.CONTROL_PLANE_ORIGIN, incoming.origin);
    if (!origin) return unavailableControlPlane();
    const target = new URL(`${incoming.pathname}${incoming.search}`, origin);
    return privateAccountResponse(await fetch(await proxyRequest(request, target, env)));
  } catch {
    return Response.json(
      {
        error: "cloud_unavailable",
        error_description: "The RoamCode account service could not be reached.",
      },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "retry-after": "10",
        },
      },
    );
  }
}

function shellNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/u, "");
}

async function secureShellResponse(request: Request, response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  const nonce = shellNonce();
  const html = await response.text();
  const securedHtml = html.replace(/<script(?![^>]*\bsrc\s*=)([^>]*)>/giu, `<script nonce="${nonce}"$1>`);
  for (const name of [
    "accept-ranges",
    "content-encoding",
    "content-length",
    "content-range",
    "etag",
    "last-modified",
  ]) {
    headers.delete(name);
  }
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.set(
    "content-security-policy",
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      "connect-src 'self' https: wss:",
      "worker-src 'self'",
      "manifest-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
  );
  return new Response(request.method === "HEAD" ? null : securedHtml, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function shellAsset(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  const headers = new Headers(request.headers);
  for (const name of ["if-match", "if-modified-since", "if-none-match", "if-range", "range"]) headers.delete(name);
  const response = await env.ASSETS.fetch(new Request(url, { method: request.method, headers, redirect: "manual" }));
  return secureShellResponse(request, response);
}

async function accountShell(request: Request, env: Env): Promise<Response> {
  // Assets canonicalizes /index.html back to /. Fetching the root asset internally avoids
  // leaking that redirect to /app or /activate while still serving the exact same Vite entry.
  return shellAsset(request, env, "/");
}

async function terminalShell(request: Request, env: Env): Promise<Response> {
  // Cloudflare Assets canonicalizes a nested /index.html to its directory URL. Fetch that canonical
  // entry directly so a product navigation stays a 200 and its external ?enroll selector is not lost
  // to an internal 307. Hashed assets, the manifest, icons, and service worker continue through ASSETS.
  return shellAsset(request, env, "/terminal/");
}

function publicDocumentResponse(request: Request, pathname: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(
      { error: "method_not_allowed", error_description: "Public documents support GET and HEAD only." },
      {
        status: 405,
        headers: { allow: "GET, HEAD", "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  const html = renderPublicDocument(pathname);
  if (!html) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      "content-security-policy": [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join("; "),
      "content-type": "text/html; charset=utf-8",
      "permissions-policy": "camera=(), geolocation=(), microphone=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "index, follow",
    },
  });
}

async function cached(
  request: Request,
  ctx: { waitUntil(p: Promise<unknown>): void },
  make: () => Promise<Response>,
): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(new URL(request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.ok) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);

    // Keep account cookies and product navigation on one canonical origin. Do not redirect non-idempotent
    // requests or forward arbitrary legacy query strings, which may contain retired credentials.
    if (url.hostname.toLowerCase() === LEGACY_APP_HOST) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return Response.json(
          { error: "legacy_origin", error_description: "Use https://roamcode.ai/app for RoamCode accounts." },
          { status: 421, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
        );
      }
      return new Response(null, {
        status: 308,
        headers: {
          location: `${CANONICAL_ORIGIN}/app`,
          "cache-control": "public, max-age=3600",
          "referrer-policy": "no-referrer",
        },
      });
    }

    const repositoryRedirect = sourceRedirect(request, url.pathname);
    if (repositoryRedirect) return repositoryRedirect;

    if (isPublicDocumentPath(url.pathname)) return publicDocumentResponse(request, url.pathname);

    if (isAccountApi(url.pathname)) return proxyAccountApi(request, env);

    // The cloud device-flow service currently emits /device. Keep it as a compatibility alias while
    // the human-facing route remains /activate.
    if (url.pathname === "/device") {
      url.pathname = "/activate";
      return Response.redirect(url.toString(), 302);
    }

    if ((request.method === "GET" || request.method === "HEAD") && isAccountShellPath(url.pathname)) {
      return accountShell(request, env);
    }

    if ((request.method === "GET" || request.method === "HEAD") && isTerminalShellPath(url.pathname)) {
      return terminalShell(request, env);
    }

    if (url.pathname === "/api/stars") {
      return cached(request, ctx, async () => {
        const gh = await fetch(REPO_API, {
          headers: { "user-agent": "roamcode-site", accept: "application/vnd.github+json" },
        });
        if (!gh.ok)
          return new Response(JSON.stringify({ error: "github unavailable" }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        const data = (await gh.json()) as { stargazers_count?: number };
        return new Response(JSON.stringify({ stars: data.stargazers_count ?? 0 }), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, s-maxage=${TTL}, max-age=60`,
            "access-control-allow-origin": "https://roamcode.ai",
          },
        });
      });
    }

    if (url.pathname === "/install") {
      return cached(request, ctx, async () => {
        const sh = await fetch(INSTALL_SH, { headers: { "user-agent": "roamcode-site" } });
        if (!sh.ok) {
          return new Response(
            "# install script temporarily unavailable — see https://github.com/burakgon/roamcode\nexit 1\n",
            {
              status: 502,
              headers: { "content-type": "text/x-shellscript" },
            },
          );
        }
        return new Response(await sh.text(), {
          headers: {
            "content-type": "text/x-shellscript; charset=utf-8",
            "cache-control": `public, s-maxage=${TTL}, max-age=60`,
          },
        });
      });
    }

    return env.ASSETS.fetch(request);
  },
};
