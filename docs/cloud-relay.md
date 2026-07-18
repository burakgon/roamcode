# Portable gateway and relay operations

RoamCode is local-first. The portable standalone release serves the website, account shell, terminal PWA, control
API, and an outbound-only blind relay from one canonical origin. Provider logins, source code, terminal plaintext,
and execution remain on each Node.

## Deployment boundary

The public gateway/relay component in [`packaging/relay`](../packaging/relay/README.md) has a minimal attack surface:

- the relay image is multi-architecture, runs as UID/GID 10001, uses a read-only root filesystem, drops Linux
  capabilities, and contains no PTY or provider runtime;
- SQLite routing state lives on a dedicated persistent volume; routing credentials are stored only as domain-separated
  SHA-256 hashes;
- the root provisioning capability is a mounted file; health/readiness are public and content-free, while Caddy
  returns 404 for internal and root-capability management paths;
- production boot fails without an explicit browser-origin policy;
- frame, queue, global and per-route connection, idle-time, reconnect-resistant identity byte/message-rate, and
  streamed-request limits fail closed; pings count toward message limits and expired bootstrap devices are pruned;
- payloads are never persisted and operational responses are `no-store` with no content sniffing.

The same protocol and containers run on an ordinary self-hosted Linux VM. A shared service must not be called
production-ready until the exact cryptographic implementation and abuse controls receive an independent review.

## Managed host authorization runtime

Hosted provisioning returns a one-time host configuration that the public runtime stores atomically as
`<dataDir>/cloud-host.json`, owned by the service user with mode 0600. This is a distinct control-plane capability and
keyring; it is never written to or inferred from the blind relay's `relay-host.json`. If the managed file is absent,
the server follows the unchanged local/self-host authorization path.

With the file present, the host sends a privacy-minimal heartbeat containing only opaque organization, host and
process-instance ids, version, capabilities, state, sequence, timestamp, and current authorization revision. It polls
fresh signed authorization snapshots and persists the newest verified revision atomically in primary and
last-known-good files. Snapshot expiry is checked at authorization time, so losing the network does not extend a
grant: remote actors fail closed at expiry while the retained revision continues to block replay. Host and loopback
principals remain a local break-glass path.

The authenticated `/api/v1/cloud/status` recovery read remains available to a paired managed client after snapshot
expiry. It reports only managed/self-hosted mode, coarse sync and expiry state, last successful sync time, and a stable
recovery action. It deliberately omits credentials, key material, signed claims, target identifiers, and internal
control-plane addresses.

Authorization signing keys rotate through an explicit overlap. The bootstrap keyset comes only from the protected
host configuration. A replacement keyset is accepted only when its exact domain-separated canonical bytes verify
under an already pinned Ed25519 key that is still valid at verification time; only then is it atomically written back
to `cloud-host.json`. Every active key cross-signs the set. The accepted current key can become a finite-lived previous
key but can never be restored from previous to current, and an overlap key cannot disappear before its inclusive
retirement time. These rules reject a later response from a stale control-plane replica instead of rolling trust back.

The signature profile is explicit and downgrade-safe. Existing V1 software/self-host configurations continue to
verify raw, domain-separated `Ed25519` envelopes. New hosted V2 configurations use `Ed25519-SHA256`: the signature is
over exactly `SHA-256(domain || NUL || canonical protected envelope)`, so even the largest allowed snapshot produces a
32-byte hardware-signer input. A V2 host accepts only V2 keysets, V2 snapshots, the V2 algorithm, and the V2 domains;
hybrid or V1 responses fail closed. V2 key rotation keeps the same every-active-key cross-signing requirement.

Keyset trust itself expires. A host that misses the complete overlap window fails closed: it will not extend an old
pin, perform trust-on-first-use, or accept a backdated signature. Recovery is an explicit authenticated host
re-provision/credential-rotation operation through the control plane, followed by atomic installation of the newly
returned protected `cloud-host.json`; operators must never hand-edit key material. Signed snapshots are bounded to a
one-hour maximum lifetime and issue-age, and a retiring key cannot sign a snapshot that remains valid past that key's
retirement. Unsigned metadata, unknown signers, redirects, oversized responses, target mismatches, equal/lower
snapshot revisions, and expired envelopes never update durable state.

## Connect a host

The normal hosted flow uses the user's signed-in control-plane session. Browser-assisted device authorization keeps
account credentials out of argv, and the approved `https://roamcode.ai` origin is pinned to the saved session:

```sh
roamcode cloud login
roamcode cloud whoami
roamcode cloud connect --label "Workstation"
roamcode cloud pair
roamcode cloud status
```

The account, app, and relay share one configured canonical HTTPS origin. The control plane returns that connection
origin during provisioning, so a signed-in user does not need `--url` or `--app-url`.

`connect` creates two independent capabilities with different trust boundaries:

- the `rch_…` capability authenticates this Node only to the account control plane and is persisted in
  `<dataDir>/cloud-host.json`;
- the `rrh_…` capability authenticates this Node only to its blind relay route and is persisted in
  `<dataDir>/relay-host.json`. Its raw value never reaches the control plane or relay provisioning API; only its
  domain-separated hash does.

Both files are owned, non-symlink, mode-0600 regular files. Before the remote mutation, the CLI also writes a private
mode-0600 `cloud-host-operation.json` recovery journal containing the stable operation identity and locally generated
material. A retry replays that exact idempotent operation instead of creating another Node or changing credentials.
The journal is removed only after both final files have been durably committed. The command never prints any of these
capabilities.

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
roamcode cloud configure --app-url https://roamcode.ai
roamcode cloud rotate
roamcode cloud disconnect --confirm
```

Managed rotation changes both boundary-specific capabilities through one idempotent signed-in control-plane
operation, again sending only the relay capability hash. An interrupted local commit retains the recovery journal and
the next invocation resumes the same operation. Managed disconnect requires confirmation, revokes the Node remotely
before removing both local configuration files, and treats an already-revoked Node as a successful retry.

Environment-based relay settings remain supported for infrastructure automation, but intentionally override this
managed-file workflow except for `cloud pair`, which can use a complete reviewed environment configuration.
`cloud configure --app-url` atomically repairs or changes the managed trusted PWA origin without re-provisioning the
route; environment-managed hosts must set `ROAMCODE_RELAY_APP_URL` in their service configuration instead.

### Standalone relay compatibility

The explicit account-capability path remains available for a legacy deployment, a self-hosted standalone relay, or
operator-managed infrastructure. It is intentionally separate from the hosted account session:

```sh
install -m 600 /secure/input/relay-account-token ~/.config/roamcode/relay-account-token
roamcode cloud connect \
  --account-token-file ~/.config/roamcode/relay-account-token \
  --url https://roamcode.example.com \
  --app-url https://roamcode.example.com \
  --label "Workstation"
roamcode cloud rotate --account-token-file ~/.config/roamcode/relay-account-token
roamcode cloud disconnect --confirm --account-token-file ~/.config/roamcode/relay-account-token
```

The file must be an owned, non-symlink, mode-0600 regular file. A raw capability is never accepted as a CLI value.
This compatibility path provisions the relay directly and therefore does not install managed organization grants,
heartbeat, or signed authorization snapshots.

## Standalone relay account boundary

Set `ROAMCODE_RELAY_ACCOUNTS_ENABLED=1` to enable the durable standalone relay account store. The root capability can
create, list, suspend, quota, delete, and rotate account access. An active account capability can inspect only its own
account, create/list/delete only its own routes, and rotate only its own host hashes. Account status is checked again
for HTTP and WebSocket host/device authentication; suspending an account closes its live routes and blocks reconnects.

The hosted control plane uses the root-authenticated `/internal/v1` API over the private container network. Account
and route provisioning are idempotent `PUT` operations with caller-selected stable ids. They accept only
domain-separated hashes (and the account lookup digest), never a raw account or host capability. Credential rotation
is retry-safe through account revisions or an expected route hash; stale operations return 409 without reverting a
newer credential. Deletes are repeatable, and account deletion purges owned routes and their live connections.

| Method | Private path | Concurrency contract |
| --- | --- | --- |
| `PUT` | `/internal/v1/accounts/:accountId` | Full plan limits plus account `credentialHash` and `credentialLookup`; exact replay returns 200. |
| `GET` | `/internal/v1/accounts/:accountId/status` | Public account fields and route quota usage only. |
| `PUT` | `/internal/v1/accounts/:accountId/credential` | Requires `expectedRevision` and new hash/lookup material. |
| `DELETE` | `/internal/v1/accounts/:accountId` | Requires `expectedRevision`; a completed or unknown delete returns 204. |
| `PUT` | `/internal/v1/accounts/:accountId/routes/:routeId` | Requires label and host `credentialHash`; exact replay returns 200. |
| `GET` | `/internal/v1/accounts/:accountId/routes/:routeId/status` | Public route fields plus live host/device counts. |
| `PUT` | `/internal/v1/accounts/:accountId/routes/:routeId/credential` | Requires `expectedCredentialHash` and the new `credentialHash`. |
| `DELETE` | `/internal/v1/accounts/:accountId/routes/:routeId` | Requires `expectedCredentialHash`; a completed or unknown delete returns 204. |

The public gateway returns 404 for `/internal/*`, plural `/v1/accounts*`, `/v1/metrics`, the root route collection, and
root deletion of a route. The singular `/v1/account*` compatibility surface and host-authenticated route status/device
handlers remain public for existing clients. Public traffic must target Caddy, never the relay container directly.

The compatibility API returns a server-generated account capability exactly once when an operator does not supply
pre-hashed material. Inventories project explicit public fields and never contain account, host, device, or root
capabilities. Free/team/enterprise defaults are quota presets—not billing or an authorization bypass—and operators can
set reviewed route/device limits explicitly. Account and route SQLite files share the protected relay data volume and
survive container replacement.

Operators should use the secure CLI instead of placing root credentials in raw HTTP commands. The root and generated
account capabilities stay in owned, non-symlink, mode-0600 files; account creation and rotation send only locally
derived, domain-separated hash and lookup material. Run root commands against the relay's private loopback listener;
these commands intentionally fail through the public gateway:

```sh
roamcode cloud account-create \
  --url http://127.0.0.1:4281 \
  --root-token-file /secure/path/relay-root-token \
  --output /secure/path/acme-account-token \
  --label "Acme engineering" \
  --plan team

roamcode cloud account-list \
  --url http://127.0.0.1:4281 \
  --root-token-file /secure/path/relay-root-token

roamcode cloud account-update \
  --url http://127.0.0.1:4281 \
  --root-token-file /secure/path/relay-root-token \
  --account-id rra_example-account-id \
  --expected-revision 1 \
  --account-status suspended

# After an ambiguous create/rotation result, verify and commit the retained capability:
roamcode cloud account-recover \
  --url https://roamcode.example.com \
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
3. the private relay returns 401 for `/v1/metrics` without the root capability, while the public gateway returns 404;
4. a route created before a container restart is present after restart;
5. an account-owned route and its account authentication survive a restart, while another account cannot list,
   rotate, or delete it;
6. the root capability is absent from `docker inspect` environment output;
7. the runtime has no `node-pty` package;
8. the container runs with a read-only root filesystem, all capabilities dropped, and `no-new-privileges`;
9. the VM exposes only the intended gateway ports 80/443.

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

The gateway route and relay protocol contract are in [`packaging/relay`](../packaging/relay/README.md). That
two-service component profile is not the complete account control plane; production uses the signed standalone
release set that adds PostgreSQL, the account API, workers, backups, restore, and atomic updates.
