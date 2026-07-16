# Optional cloud relay operations

RoamCode is local-first: direct HTTPS and the complete single-host product work without an account or cloud service.
The optional cloud edge adds a static PWA origin and an outbound-only blind relay for reachability and multi-host
discovery. Provider logins, source code, terminal plaintext, and execution remain on each host.

## Deployment boundary

The reference deployment in [`packaging/relay`](../packaging/relay/README.md) has a minimal attack surface:

- the relay image is multi-architecture, runs as UID/GID 10001, uses a read-only root filesystem, drops Linux
  capabilities, and contains no PTY or provider runtime;
- SQLite routing state lives on a dedicated persistent volume; routing credentials are stored only as domain-separated
  SHA-256 hashes;
- the root provisioning capability is a mounted file, health/readiness are public and content-free, and aggregate
  metrics require that root capability;
- production boot fails without an explicit browser-origin policy;
- frame, queue, global and per-route connection, idle-time, reconnect-resistant identity byte/message-rate, and
  streamed-request limits fail closed; pings count toward message limits and expired bootstrap devices are pruned;
- payloads are never persisted and operational responses are `no-store` with no content sniffing.

The same protocol and container work on a self-hosted VM or a managed RoamCode deployment. A hosted service must not be
called production-ready until the exact cryptographic implementation and abuse controls receive an independent review.

## Connect a host

Hosted accounts receive an `rrk_…` account capability through an authenticated signup or operator workflow. Save it
directly to a regular file owned by the current user; the CLI deliberately has no raw-token flag, so the capability
cannot land in shell history or the process list:

```sh
install -m 600 /secure/input/roamcode-account-token ~/.config/roamcode/account-token
roamcode cloud connect \
  --account-token-file ~/.config/roamcode/account-token \
  --label "Workstation"
roamcode cloud pair
roamcode cloud status
```

The hosted defaults are `https://relay.roamcode.ai` and `https://app.roamcode.ai`. A self-hosted operator supplies
`--url https://relay.example.com --app-url https://app.example.com`. `connect` generates the route id and 256-bit host
capability locally, sends only the domain-separated capability hash to the relay, atomically stores the raw capability
in `<dataDir>/relay-host.json` with mode 0600, and restarts an installed per-user service. It deletes the newly created
route if the local write cannot be committed. The command never prints either account or host capabilities.
`cloud pair` then provisions one expiry-bounded relay bootstrap, writes no reusable capability to disk, and prints a
five-minute terminal QR and app URL whose fragment is never sent in an HTTP request. The browser generates its durable
routing capability locally and sends only that capability through the end-to-end encrypted claim for host-side hash
promotion. The link capability remains valid only as a bounded retry overlap until its original expiry, so a lost
final response or accidental same-tab reload is recoverable without turning a copied one-use URL into permanent
broker access. The PWA removes the fragment immediately, retains an unfinished attempt only in that tab's session
storage, and clears it on success, cancellation, invalid input, or expiry.

Lifecycle commands are explicit and safe to retry:

```sh
roamcode cloud status
roamcode cloud pair
roamcode cloud configure --app-url https://app.roamcode.ai
roamcode cloud rotate --account-token-file ~/.config/roamcode/account-token
roamcode cloud disconnect --confirm --account-token-file ~/.config/roamcode/account-token
```

Rotation writes the next local capability and commits only its hash remotely. After an ambiguous response it first
compensates the remote route back to the previous hash; it restores the previous local file only when rejection or
compensation is authoritative. If neither side can be confirmed, it retains the new private local capability and asks
the operator to retry instead of discarding the credential the relay may already require. Disconnect requires
confirmation, deletes the owned remote route first, removes local configuration, and then restarts the service.
Environment-based relay settings remain supported for infrastructure automation, but intentionally override this
managed-file workflow except for `cloud pair`, which can use a complete reviewed environment configuration.
`cloud configure --app-url` atomically repairs or changes the managed trusted PWA origin without re-provisioning the
route; environment-managed hosts must set `ROAMCODE_RELAY_APP_URL` in their service configuration instead.

## Hosted account boundary

Set `ROAMCODE_RELAY_ACCOUNTS_ENABLED=1` to enable the durable account control plane. The root capability can create,
list, suspend, quota, delete, and rotate account access. An active account capability can inspect only its own account,
create/list/delete only its own routes, and rotate only its own host hashes. Account status is checked again for HTTP
and WebSocket host/device authentication; suspending an account closes its live routes and blocks reconnects.

The compatibility API returns a server-generated account capability exactly once when an operator does not supply
pre-hashed material. Inventories project explicit public fields and never contain account, host, device, or root
capabilities. Free/team/enterprise defaults are quota presets—not billing or an authorization bypass—and operators can
set reviewed route/device limits explicitly. Account and route SQLite files share the protected relay data volume and
survive container replacement.

Operators should use the secure CLI instead of placing root credentials in raw HTTP commands. The root and generated
account capabilities stay in owned, non-symlink, mode-0600 files; account creation and rotation send only locally
derived, domain-separated hash and lookup material:

```sh
roamcode cloud account-create \
  --url https://relay.example.com \
  --root-token-file /secure/path/relay-root-token \
  --output /secure/path/acme-account-token \
  --label "Acme engineering" \
  --plan team

roamcode cloud account-list \
  --url https://relay.example.com \
  --root-token-file /secure/path/relay-root-token

roamcode cloud account-update \
  --url https://relay.example.com \
  --root-token-file /secure/path/relay-root-token \
  --account-id rra_example-account-id \
  --expected-revision 1 \
  --account-status suspended

# After an ambiguous create/rotation result, verify and commit the retained capability:
roamcode cloud account-recover \
  --url https://relay.example.com \
  --output /secure/path/acme-account-token
```

`account-rotate` requires an account id, current revision, and output path. It stages the new capability privately,
commits its hashes with revision protection, then atomically replaces the output. A transport failure, timeout, or
server error retains a private `.pending` recovery file because the remote result is ambiguous. `account-recover`
authenticates that capability against a recovery-only account endpoint before atomically committing it; an optional
account id pins the expected owner. This verification also works for suspended accounts without restoring their
route access. A definitive client/API rejection removes the staged file.
`account-delete` requires both the current revision and `--confirm`.

Stable releases publish anonymous ARM64/amd64 images to GitHub Container Registry. Use the exact image names and
digests from the release's `roamcode-cloud-images.json` asset; the same digests are embedded in
`roamcode-release.json`. Each image carries an SBOM, build provenance, source revision, and stable version metadata.
The release workflow refuses to overwrite an existing SemVer or commit tag and creates the discoverable GitHub Release
only after npm, OCI, anonymous-pull, and Homebrew gates succeed.

## ARM verification contract

For every release candidate, build the relay image natively or through a trusted multi-architecture builder and prove:

1. image architecture is `arm64`, configured user is `10001:10001`, and a healthcheck exists;
2. `/ready` returns 200 while durable SQLite is writable;
3. `/v1/metrics` returns 401 without the root capability;
4. a route created before a container restart is present after restart;
5. an account-owned route and its account authentication survive a restart, while another account cannot list,
   rotate, or delete it;
6. the root capability is absent from `docker inspect` environment output;
7. the runtime has no `node-pty` package;
8. the container runs with a read-only root filesystem, all capabilities dropped, and `no-new-privileges`;
9. the host exposes only the intended edge ports—or only outbound traffic when using a tunnel.

The current development revision was exercised on an isolated Google Cloud Axion `c4a-standard-2` ARM64 VM with
Secure Boot, vTPM, integrity monitoring, no service account, a dedicated network, and SSH restricted to the validating
client. No existing project VM or RoamCode installation was reused. The three npm tarballs were installed together in
a clean Node 24 ARM64 container; native SQLite and PTY modules loaded, a one-use device pairing created an idempotent
workspace and Codex agent, native terminal and HTTP lease input produced decision/completion attention, and a graceful
server replacement preserved the device, workspace, agent, resolved attention, and tmux process. Reconnect adopted the
same provider process without launching a duplicate, and the acceptance harness verified that its runtime credential
did not enter server or provider diagnostic output.

The relay and edge images from the same revision were also built natively on ARM64. The relay passed non-root,
read-only-root, dropped-capability, mounted-secret, readiness, protected-metrics, account quota/isolation, route
idempotency, credential rotation, account suspension, and durable container-replacement checks. The edge passed Caddy
configuration validation, PWA shell/service-worker delivery, immutable asset caching, no-store navigation caching, and
the same read-only/no-new-privileges runtime posture.

## Operations

- Snapshot or copy the relay data volume before upgrades. SQLite WAL mode and a five-second busy timeout are enabled.
- Roll out an exact image digest, wait for `/ready`, then replace the old instance. Broker restarts drop live sockets;
  host and browser clients establish fresh authenticated ephemeral channels automatically.
- Rotate the root capability with a short overlap by placing at most three owned private files in
  `ROAMCODE_RELAY_PREVIOUS_ROOT_TOKEN_DIR`, then recreating the relay after adding or removing an overlap file.
  Route/device credentials remain independent, and previous root capabilities never need to enter container
  environment variables.
- Alert on readiness failure, rejected-connection growth, dropped frames, sustained rate-limit closes, disk pressure,
  and restart loops. Aggregate counters contain no payloads, paths, IPs, or provider identities.
- Delete a route to revoke its host and every routed device immediately. Deleting the persistent volume removes all
  routing metadata; host/device identity keys live at their endpoints and are not recoverable from the relay.

Cloudflare account changes are intentionally outside the repository. A named Tunnel should map stable app and relay
hostnames to their loopback services, keep inbound VM ports closed, and preserve WebSocket upgrades. Never commit or
paste a tunnel token; install it through the platform secret store. Direct Caddy TLS remains the documented fallback.

The hardened no-public-IP GCP deployment profile, least-privilege secret flow, verified backups, snapshot retention,
and Tunnel-only ingress contract are in [`packaging/relay/gcp`](../packaging/relay/gcp/README.md).
