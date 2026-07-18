# Deploying roamcode.ai

**Live path: Cloudflare Workers Builds (push-to-deploy).** Every relevant push to `main` makes
Cloudflare clone the repo, run the build in `/site`, and `npx wrangler deploy` the `roamcode-site`
Worker with REAL static assets (`wrangler.jsonc` + `worker/index.ts`). The dashboard path filter must
include `site/**`, `packages/web/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and the root/package-web
manifests: the hosted terminal is built from all of them, so a web security fix or stable version bump
must not wait for an unrelated site edit. Nothing to do locally — merge and it ships.

> **Stable cloud releases need a deployment hold.** The account service, Worker/site, and Node are separate release
> units. A checked-in `site/.production-deploy-hold` makes a Cloudflare production build from `main` exit before
> building or deploying, while GitHub CI and non-production branches remain available. Keep that file present while
> uploading the reviewed site as a non-production version.
> Deploy the backward-compatible account image first, finish and verify the stable Node release, then promote the
> exact site version last. Remove the hold only after the end-to-end smoke in `docs/releases.md` passes; that reviewed
> removal commit is the production promotion. A
> `main` push by itself must never make an unreleased Node capability appear available.

- Trigger "Deploy default branch": branch `main`, root `/site`,
  build `pnpm install && pnpm build`, deploy `npx wrangler deploy`.
- Trigger "Deploy non-production branches": same, but `npx wrangler versions upload`
  (preview versions); excludes `main`.
- Build status/logs: dash.cloudflare.com → Workers & Pages → roamcode-site → Deployments,
  or the Workers Builds API/MCP.

Custom domains `roamcode.ai` and `app.roamcode.ai` are attached to the production Worker. The legacy app hostname
accepts only safe page navigations and redirects them to `https://roamcode.ai/app`; it must not become a second
account origin. `/api/stars` and `/install` are served by `worker/index.ts` (the install endpoint powers
`curl -fsSL https://roamcode.ai/install | bash`).

## Hosted account control plane

The account shell lives on the same origin at `/app` and `/activate`. Its `/api/auth/*` and
`/api/v1/*` calls are forwarded by the Worker. Prefer a private `CONTROL_PLANE` service binding;
an explicitly configured `CONTROL_PLANE_ORIGIN` is the HTTPS fallback. The Worker intentionally
returns a no-store `503 cloud_unavailable` response when neither exists, so a deployment never
pretends that cloud identity or Node inventory is connected. `keep_vars` preserves reviewed
dashboard variables across build deployments; service bindings should still be declared in the
environment-specific Wrangler configuration.

The site treats `GET /api/v1/meta/product-capabilities` as the launch authority. It is a public,
no-session, no-store endpoint with the exact v1 response shape
`{v:1,launch:{account:boolean,managedTerminal:boolean},capabilities:string[],requiredNodeCapabilities:string[]}`.
The account shell opens the hosted product only when `launch.account` is true and `capabilities`
contains `account.v1`. Managed browser enrollment additionally requires `launch.managedTerminal`,
the `managed-device-enrollment.v1` product capability, and exactly `terminal.v1`, `relay.v1`, and
`managed-device-enrollment.v1` in `requiredNodeCapabilities`. A 404 from an older control plane,
network failure, malformed response, missing capability, false launch flag, or unknown contract
version remains closed. Sign-in, sign-out, and account recovery stay available; the site never
guesses that newer hosted surfaces exist.

Keep the production Worker auto-deploy hold in place for the complete launch sequence:

1. Deploy the backward-compatible control plane with `PRODUCT_ACCOUNT_LAUNCH_ENABLED=false` and
   `PRODUCT_MANAGED_TERMINAL_LAUNCH_ENABLED=false` (both defaults are false), then verify the public
   capability response is no-store and both launch values are false.
2. Upload the exact site version as a non-production Worker version and smoke it against that control
   plane. Confirm old authentication still works while account creation, product bootstrap, and
   managed enrollment remain closed.
3. Set `PRODUCT_ACCOUNT_LAUNCH_ENABLED=true`, redeploy the control plane, and verify account creation,
   sign-in, bootstrap, Organizations, fleet inventory, and sign-out on the non-production site.
4. Publish and verify the stable Node version. Exercise the exact advertised Node capabilities plus
   managed enrollment, terminal open/reconnect, browser revocation, and CLI-device revocation end to end.
5. Only after those smokes pass, set `PRODUCT_MANAGED_TERMINAL_LAUNCH_ENABLED=true`, verify the v1
   capability document and managed flow again, then remove `site/.production-deploy-hold`. Verify the
   resulting `main` build promotes the reviewed site bytes and no unrelated source change is present.

Every hosted control-plane path also requires authenticated client-IP metadata. Configure the
active public key ID as `CONTROL_PLANE_EDGE_AUTH_KEY_ID` and its random 32-byte-or-longer value with
`wrangler secret put CONTROL_PLANE_EDGE_AUTH_SECRET`. The Worker removes browser-supplied
forwarding/private headers and signs the Cloudflare-provided client IP together with timestamp,
method, and exact path/query. The control plane keeps proxy-hop trust disabled and rejects missing,
stale, or modified signatures. Never place the secret in `wrangler.jsonc`, build variables,
source control, logs, or a command argument.

For zero-downtime rotation, first add the new key plus the old key to the control-plane verification
keyring and deploy it. Then update the Worker key ID and secret together, verify account traffic,
wait longer than the control plane's maximum signature age, and finally remove the old verifier.

## Hosted terminal PWA

`pnpm build` also installs the lockfile-pinned web workspace, type-checks it, and builds the real
RoamCode PWA into `dist/terminal` with `/terminal/` as its asset and navigation base. The marketing
site build runs second without emptying that directory. The Worker serves the same PWA entry for
`/terminal`, `/terminal/sessions`, `/terminal/automations`, and `/terminal/agents`; hashed assets,
the manifest, and the service worker continue through the static-asset binding.

Static assets are configured with `run_worker_first`. This is a security and routing invariant, not a
performance preference: the Worker must apply anti-framing/no-referrer headers to every account and
terminal shell, and it must serve product navigations from the canonical `/terminal/` asset without a
redirect that would discard `?enroll=<Node id>`. Hashed terminal assets still pass straight through the
Worker to the asset binding and retain their normal immutable cache policy.

Only the account-control-plane namespaces `/api/auth/*` and `/api/v1/*` are proxied. Paths beneath
`/terminal/` are never forwarded to that service: the browser establishes its Node-scoped,
end-to-end encrypted relay connection itself. Keep this boundary intact when adding hosted routes.

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
