/**
 * roamcode.ai BOOTSTRAP worker — used until wrangler auth exists on the deploy machine.
 *
 * Why this exists: the site was first deployed through the Cloudflare API (MCP OAuth) from an
 * environment whose sandbox cannot reach the asset-upload endpoint (session-JWT auth + blocked
 * egress). So instead of Workers static assets, this worker serves the built site by proxying
 * jsDelivr, PINNED to an immutable commit of the `site-dist` branch, with edge caching on top.
 * Same endpoints as worker/index.ts (/api/stars, /install). To ship a new site build: push the
 * new `site/dist` to `site-dist`, update DIST_SHA, redeploy (scripts/deploy-site-api.md).
 * Once `wrangler login` is available, prefer `pnpm deploy` (wrangler.jsonc, worker/index.ts).
 */

export const DIST_SHA = "dc969c7bc90b1da2db49e4a03cd68e8ddf4df5bb";
const CDN = `https://cdn.jsdelivr.net/gh/burakgon/roamcode@${DIST_SHA}/site/dist`;
const REPO_API = "https://api.github.com/repos/burakgon/roamcode";
const INSTALL_SH = "https://raw.githubusercontent.com/burakgon/roamcode/main/scripts/install.sh";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  woff2: "font/woff2",
  svg: "image/svg+xml",
  png: "image/png",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  json: "application/json",
};

async function edgeCached(request: Request, ctx: ExecutionContext, make: () => Promise<Response>): Promise<Response> {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.ok) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/stars") {
      return edgeCached(request, ctx, async () => {
        const gh = await fetch(REPO_API, {
          headers: { "user-agent": "roamcode-site", accept: "application/vnd.github+json" },
        });
        if (!gh.ok) return new Response(JSON.stringify({ error: "github unavailable" }), { status: 502, headers: { "content-type": TYPES.json! } });
        const data = (await gh.json()) as { stargazers_count?: number };
        return new Response(JSON.stringify({ stars: data.stargazers_count ?? 0 }), {
          headers: { "content-type": TYPES.json!, "cache-control": "public, s-maxage=300, max-age=60" },
        });
      });
    }

    if (url.pathname === "/install") {
      return edgeCached(request, ctx, async () => {
        const sh = await fetch(INSTALL_SH, { headers: { "user-agent": "roamcode-site" } });
        if (!sh.ok) {
          return new Response("# install script temporarily unavailable — see https://github.com/burakgon/roamcode\nexit 1\n", {
            status: 502,
            headers: { "content-type": "text/x-shellscript" },
          });
        }
        return new Response(await sh.text(), {
          headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, s-maxage=300, max-age=60" },
        });
      });
    }

    // static site via pinned jsDelivr (immutable commit): "/" → index.html; no dots allowed to escape
    let path = url.pathname;
    if (path.includes("..")) return new Response("nope", { status: 400 });
    const isAsset = path.startsWith("/assets/");
    if (path === "/" || !/\.[a-z0-9]+$/i.test(path)) path = "/index.html";
    const ext = path.split(".").pop()!.toLowerCase();

    return edgeCached(request, ctx, async () => {
      const upstream = await fetch(CDN + path, { cf: { cacheEverything: true, cacheTtl: 86400 } } as RequestInit);
      if (upstream.status === 404) return new Response("not found", { status: 404 });
      if (!upstream.ok) return new Response("upstream error", { status: 502 });
      return new Response(upstream.body, {
        headers: {
          "content-type": TYPES[ext] ?? "application/octet-stream",
          "cache-control": isAsset
            ? "public, max-age=31536000, immutable" // hashed filenames — safe forever
            : "public, max-age=300, s-maxage=3600",
          "x-content-type-options": "nosniff",
          "referrer-policy": "strict-origin-when-cross-origin",
        },
      });
    });
  },
};
