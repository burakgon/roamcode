# Peer federation

Peer federation lets one RoamCode host coordinate explicitly scoped agents on another RoamCode host. It is the
machine-to-machine layer behind cross-instance `read`, `wait`, `send`, `start`, and `focus` operations. It does not
copy source code or provider credentials into RoamCode Cloud, and it is not a generic HTTP proxy.

## Product boundary

- Each peer remains an independent RoamCode instance and remains authoritative for its own workspaces, sessions,
  agents, RBAC, policy, and input leases.
- The calling host stores one independently revocable **device credential** issued by the remote host. It never
  receives the remote host recovery key or a provider login.
- A connection starts with `read` and `wait` actions but **no workspace access**. An administrator must discover and
  select remote workspaces before operational data is returned.
- Local authorization and policy run first. The remote host then authenticates the peer device and applies its own
  authorization and policy. Either side can deny the operation.
- Many callers can observe an agent, but terminal input still requires the remote session's single-writer lease.

Peer federation currently requires the calling host to reach the remote host through a stable HTTPS origin (plain
HTTP is accepted only on loopback for isolated development). The optional blind relay remains a separate browser-to-
host reachability path; it is not a generic peer transport.

## Recommended setup in the PWA

1. Give the remote host a stable HTTPS origin and set its public URL normally.
2. On the remote host, run `roamcode pair --url https://remote-host.example`. The link expires after five minutes and
   can be claimed once.
3. On the coordinating host, open **Settings → Organization → Peer hosts → Connect**. Paste the complete one-use link
   and review the confirmation.
4. RoamCode claims a new device credential directly from the remote host, pins the returned host identity, stores the
   credential only in the coordinating host's private data directory, and clears the pairing link from the form.
5. Select **Scope**, discover the remote workspace inventory, choose the minimum actions and workspaces, then apply the
   revisioned scope.

If role enforcement is enabled on the remote host, the new device appears as `RoamCode peer · <coordinator label>` in
its device inventory. On that remote host, create or choose an agent/service member, grant only the required role, and
assign the new device under **Settings → Organization → Team**. Identity verification is allowed before assignment,
but workspace and agent operations remain denied until the binding exists.

To recover a revoked connection, create a new pairing link on the same remote origin, choose **Access** on the peer
card, and review the replacement. RoamCode activates it only after the pinned remote host identity verifies. Removing
a peer immediately deletes the locally stored access; the remote device can also be revoked from the remote host's
device inventory.

## CLI workflow

The CLI never accepts a pairing link or durable credential as a command-line value. Put the one-use link in an owned,
mode-0600 regular file, then register it:

```sh
roamcode api peer-add \
  --peer-pairing-file ./remote-peer-link \
  --label "Build host" \
  --confirm

roamcode api peers
roamcode api peer-discover --peer <peer-id> --expected-revision 1
roamcode api peer-update \
  --peer <peer-id> \
  --expected-revision 2 \
  --actions read,wait,send,start,focus \
  --workspaces <workspace-id>
```

Delete the pairing-link file after a successful claim. `ROAMCODE_PEER_PAIRING_FILE` is the environment-variable
equivalent. Existing service automation may instead use `--peer-url` plus `--peer-credential-file`; those two files
are mutually exclusive with pairing enrollment, and the credential must already be an independently revocable remote
device/service credential.

Remote operations use the same stable control contract as local operations:

```sh
roamcode api peer-workspaces --peer <peer-id>
roamcode api peer-agents --peer <peer-id>
roamcode api peer-sessions --peer <peer-id>
roamcode api start --peer <peer-id> --workspace <workspace-id> --provider codex --options-json '{}'
roamcode api wait --peer <peer-id> --agent <agent-id> --after 0 --timeout-ms 30000
```

Starting through a peer accepts a registered workspace id, never a caller-supplied remote filesystem path. Sending
input also requires a lease bound to the authenticated caller and its stable client id. See the installed
[`SKILL.md`](../packages/cli/SKILL.md) and `GET /api/v1/openapi.json` for the complete machine-readable contract.

## Security and failure behavior

- Pairing capabilities are 256-bit, expire after five minutes, and are consumed before a durable device token is
  returned. The fragment secret is sent only in the claim request body, never in a request URL.
- A failed setup best-effort revokes any device credential it just claimed, preventing an unnoticed remote orphan.
- `peers.db` is forced to mode 0600 inside the mode-0700 RoamCode data directory. Credentials must remain recoverable
  across restarts, so anyone who can read that local account's data directory can use the stored peer access.
- Peer inventory, audit records, OpenAPI response schemas, and UI state omit the remote origin and credential. Remote
  errors are bounded and sanitized before they cross the local API.
- HTTPS redirects are rejected. Responses, timeouts, workspace inventories, ids, labels, and forwarded paths are
  bounded. There is no arbitrary method, header, or URL forwarding surface.
- Identity, origin, status, action scope, workspace scope, and optimistic revision are all checked before forwarding.
  Credential replacement cannot silently retarget an existing peer to another origin or host identity.
- Suspending a peer stops forwarding without deleting recovery state. Revoking the corresponding device on the
  remote host makes the stored credential unusable immediately.

Operational failures are explicit: `PEER_CREDENTIAL_REJECTED`, `PEER_PAIRING_EXPIRED`, `PEER_SCOPE_DENIED`,
`PEER_IDENTITY_CHANGED`, `PEER_ORIGIN_CHANGED`, `PEER_REVISION_CONFLICT`, and sanitized remote authorization or
rate-limit errors. Retrying a mutation should preserve its idempotency key; never infer success from a timeout alone.
