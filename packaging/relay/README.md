# RoamCode gateway and blind-relay component

This package is the public edge of the portable RoamCode stack. One Caddy process owns ports 80/443 and one
canonical domain:

- `/`, `/app/*`, and `/terminal/*` serve the built website, account shell, and unchanged terminal PWA;
- `/api/auth/*` and `/api/v1/*` reach the account API on the private Docker network;
- the explicitly allowlisted `/v1/*`, `/health`, and `/ready` routes reach the blind relay;
- every internal, root-capability, metrics, and unknown API/relay path returns 404 at the gateway.

No external edge runtime or cloud-provider service is required. Caddy obtains and renews TLS certificates directly.
The relay routes bounded opaque frames and cannot decrypt API, terminal, prompt, source-file, or provider-credential
payloads. Coding agents continue to run on each user's own RoamCode Node.

## Run this component profile

This directory's Compose file is a component and gateway integration profile, not the complete account control
plane. It starts the public gateway and relay only; account API requests require an `api:4400` service supplied by
the complete standalone release on the same private network. Do not present this two-service profile as a complete
production installation.

For relay/gateway development, use Docker Compose v2, one stable DNS name whose A/AAAA record points at the VM, and
inbound TCP 80/443. Copy the example configuration and create the ignored relay capability without printing it:

```sh
cd packaging/relay
cp .env.example .env
install -d -m 700 secrets
sudo install -d -o 10001 -g 10001 -m 0700 secrets/previous-root-tokens
node -e 'process.stdout.write("rrp_"+require("node:crypto").randomBytes(32).toString("base64url"))' \
  > secrets/relay-root-token.operator
chmod 600 secrets/relay-root-token.operator
sudo install -o 10001 -g 10001 -m 0400 \
  secrets/relay-root-token.operator secrets/relay-root-token.container
```

Keep the operator copy owned by the administrator for `roamcode cloud account-*` commands. Only the uid-10001,
mode-0400 container copy is mounted into the non-root relay. Docker Compose file mounts do not remap uid, gid, or
mode, so this explicit second copy is intentional.

Set `ROAMCODE_DOMAIN` and `ROAMCODE_RELAY_ALLOWED_ORIGINS` to the same HTTPS origin. Then validate and start the
component profile:

```sh
docker compose config --quiet
docker compose up --detach --build
curl --fail --silent "https://${ROAMCODE_DOMAIN}/ready"
```

Complete production deployments must use the standalone release set, which adds the account API, PostgreSQL,
workers, role-scoped secrets, backup/restore, and atomic update tooling. It pins `ROAMCODE_RELAY_IMAGE` and
`ROAMCODE_EDGE_IMAGE` to reviewed immutable digests from a stable release's `roamcode-cloud-images.json`. The root
capability remains a read-only file, never an environment value. During a planned rotation, install up to three former
capabilities as separate uid-10001 mode-0400 files under `secrets/previous-root-tokens`, recreate only the relay, then
remove those files after operators have moved to the new capability.

`ROAMCODE_RELAY_ACCOUNTS_ENABLED=1` enables durable relay accounts and per-account route/device quotas. Management
handlers must remain private. The gateway deliberately rebuilds all forwarding headers and ignores caller-provided
`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, and former edge-signature headers.

The relay is bound to host loopback on port 4281 for local administration. Public traffic must always enter through
the gateway, otherwise the gateway's deny rules can be bypassed.

## Connect a Node

The application and relay now use the same canonical origin:

```sh
roamcode cloud connect \
  --url https://roamcode.example.com \
  --app-url https://roamcode.example.com \
  --account-token-file /secure/path/account-token \
  --label "Workstation"
roamcode cloud pair
```

The account-token file must be an owned, non-symlink regular file with mode 0600. Equivalent host settings are:

```text
ROAMCODE_RELAY_URL=wss://roamcode.example.com/v1/connect
ROAMCODE_RELAY_ROUTE_ID=<opaque route id>
ROAMCODE_RELAY_HOST_CREDENTIAL=<route-specific host capability>
ROAMCODE_RELAY_APP_URL=https://roamcode.example.com
ROAMCODE_RELAY_HOST_LABEL=<user-visible machine label>
```

Never place these values in a repository, image, issue, shell transcript, or pairing URL. Browser pairing carries only
a five-minute bootstrap in a URL fragment; durable routing and device credentials are stored independently and can be
revoked.

See [the protocol contract](../../docs/relay-protocol.md) and [relay operations](../../docs/cloud-relay.md) before
operating a shared installation.
