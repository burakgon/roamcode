# Deploying roamcode.ai

**Live path: Cloudflare Workers Builds (push-to-deploy).** Every push to `main` that touches
`site/**` makes Cloudflare clone the repo, run the build in `/site`, and `npx wrangler deploy`
the `roamcode-site` Worker with REAL static assets (`wrangler.jsonc` + `worker/index.ts`).
Nothing to do locally — merge and it ships.

- Trigger "Deploy default branch": branch `main`, root `/site`,
  build `pnpm install && pnpm build`, deploy `npx wrangler deploy`.
- Trigger "Deploy non-production branches": same, but `npx wrangler versions upload`
  (preview versions); excludes `main`.
- Build status/logs: dash.cloudflare.com → Workers & Pages → roamcode-site → Deployments,
  or the Workers Builds API/MCP.

Custom domain `roamcode.ai` is attached to the Worker (zone `4817be6c19fe790174dc6e777aac74fa`);
`/api/stars` and `/install` are served by `worker/index.ts` (the install endpoint powers
`curl -fsSL https://roamcode.ai/install | bash`).

## pnpm notes (learned the hard way)

`site/` has its OWN `pnpm-workspace.yaml`: it scopes plain `pnpm` commands to site/ (without
it they silently bind to the REPO workspace) and it is where pnpm 11 reads `allowBuilds`
from (the package.json `pnpm` field is ignored). Don't use `--ignore-workspace` here — it
would bypass this file and re-break the esbuild/workerd/sharp build scripts.

## Historical: the bootstrap worker

Before the GitHub App was connected, the site was deployed via the Cloudflare API (MCP OAuth)
as `worker/bootstrap.ts` — a proxy serving the built site from jsDelivr pinned to a `site-dist`
branch commit (that sandbox can't reach the asset-upload endpoint, so real uploads were
impossible). Replaced by Workers Builds on 2026-07-10; the file stays as reference, the
`site-dist` branch was deleted.
