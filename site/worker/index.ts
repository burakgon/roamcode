/**
 * roamcode.ai edge worker — static assets plus two tiny endpoints:
 *   GET /api/stars  → { stars } from GitHub, edge-cached 5 min (client never hits GitHub's rate limit)
 *   GET /install    → scripts/install.sh proxied from the repo, 5 min cache, correct content-type
 *                     (this is what `curl -fsSL https://roamcode.ai/install | bash` downloads)
 */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const REPO_API = "https://api.github.com/repos/burakgon/roamcode";
const INSTALL_SH = "https://raw.githubusercontent.com/burakgon/roamcode/main/scripts/install.sh";
const TTL = 300;

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
