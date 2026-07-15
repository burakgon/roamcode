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
- frame, queue, connection, idle-time, byte-rate, message-rate, and streamed-request limits fail closed;
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
roamcode cloud status
```

The hosted defaults are `https://relay.roamcode.ai` and `https://app.roamcode.ai`. A self-hosted operator supplies
`--url https://relay.example.com --app-url https://app.example.com`. `connect` generates the route id and 256-bit host
capability locally, sends only the domain-separated capability hash to the relay, atomically stores the raw capability
in `<dataDir>/relay-host.json` with mode 0600, and restarts an installed per-user service. It deletes the newly created
route if the local write cannot be committed. The command never prints either account or host capabilities.

Lifecycle commands are explicit and safe to retry:

```sh
roamcode cloud status
roamcode cloud rotate --account-token-file ~/.config/roamcode/account-token
roamcode cloud disconnect --confirm --account-token-file ~/.config/roamcode/account-token
```

Rotation writes the next local capability, commits only its hash remotely, restores the previous local file on API
failure, and reconnects the managed service only after both sides agree. Disconnect requires confirmation, deletes the
owned remote route first, removes local configuration, and then restarts the service. Environment-based relay settings
remain supported for infrastructure automation, but intentionally override this managed-file workflow.

## Hosted account boundary

Set `ROAMCODE_RELAY_ACCOUNTS_ENABLED=1` to enable the durable account control plane. The root capability can create,
list, suspend, quota, delete, and rotate account access. An active account capability can inspect only its own account,
create/list/delete only its own routes, and rotate only its own host hashes. Account status is checked again for HTTP
and WebSocket host/device authentication; suspending an account closes its live routes and blocks reconnects.

Account creation returns the account capability exactly once. Inventories project explicit public fields and never
contain account, host, device, or root capabilities. Free/team/enterprise defaults are quota presets—not billing or an
authorization bypass—and operators can set reviewed route/device limits explicitly. Account and route SQLite files
share the protected relay data volume and survive container replacement.

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

The current development revision was exercised on an isolated Google Cloud Axion `c4a-standard-1` ARM64 VM with
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
- Rotate the root capability with a short overlap using `ROAMCODE_RELAY_PREVIOUS_ROOT_TOKENS`. Route/device credentials
  are rotated or revoked independently through the authenticated management API.
- Alert on readiness failure, rejected-connection growth, dropped frames, sustained rate-limit closes, disk pressure,
  and restart loops. Aggregate counters contain no payloads, paths, IPs, or provider identities.
- Delete a route to revoke its host and every routed device immediately. Deleting the persistent volume removes all
  routing metadata; host/device identity keys live at their endpoints and are not recoverable from the relay.

Cloudflare account changes are intentionally outside the repository. A named Tunnel should map stable app and relay
hostnames to their loopback services, keep inbound VM ports closed, and preserve WebSocket upgrades. Never commit or
paste a tunnel token; install it through the platform secret store. Direct Caddy TLS remains the documented fallback.
