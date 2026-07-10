# Deploying roamcode.ai

Two paths — the bootstrap path is what's LIVE today; the wrangler path takes over once
someone runs `wrangler login` on the deploy machine.

## Current: bootstrap worker (API-deployed, no wrangler auth needed)

The `roamcode-site` Worker (`worker/bootstrap.ts`) serves the built site by proxying
jsDelivr pinned to an immutable commit of the **`site-dist`** branch, with edge caching
(assets immutable, html 5 min). Same `/api/stars` + `/install` endpoints as the wrangler
worker. It exists because the first deploy ran through the Cloudflare API via MCP OAuth
from a sandbox that cannot reach the asset-upload endpoint.

To ship a site update:

1. `pnpm build` in `site/`.
2. Commit `site/dist` onto the `site-dist` branch (checkout the branch, replace `site/dist`,
   commit, push) and note the new commit SHA.
3. Update `DIST_SHA` in `worker/bootstrap.ts`.
4. Redeploy the worker script (either `pnpm exec wrangler deploy worker/bootstrap.ts --name roamcode-site`
   once wrangler is authed, or the API multipart PUT — see the git history of this deploy).

## Target: Workers static assets (first-class)

`wrangler.jsonc` + `worker/index.ts` are ready: `pnpm build && pnpm deploy` uploads
`dist/` as real static assets (ASSETS binding) and keeps the same custom domain. Once this
path is used, the bootstrap worker and the `site-dist` branch can be retired.

Custom domain `roamcode.ai` is attached to the `roamcode-site` Worker (zone
`4817be6c19fe790174dc6e777aac74fa`).
