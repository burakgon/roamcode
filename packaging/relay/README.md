# RoamCode cloud edge and blind relay

This package runs two deliberately separate services:

- `edge` serves the immutable RoamCode PWA and terminates TLS;
- `relay` routes bounded opaque frames between a host and its paired devices.

The relay cannot decrypt API, terminal, prompt, source-file, or provider-credential payloads. Coding agents still run
on each user's own RoamCode host. The host application itself remains host-native and must not be placed in this
container.

## Start a self-hosted edge

Requirements: Docker Compose v2, two stable DNS names pointing at this machine, and inbound TCP 80/443. Copy the
example configuration and create the ignored secret file without printing the capability:

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

Keep the operator copy owned by the administering user for `roamcode cloud account-*` commands. The second copy is
the only one mounted into the non-root relay container. This explicit install is required because Docker Compose
file-backed secrets are bind mounts and do not apply requested `uid`, `gid`, or `mode` remapping. Reinstall the
container copy atomically after a planned root-capability rotation; never weaken either file's permissions.

Set `ROAMCODE_APP_DOMAIN`, `ROAMCODE_RELAY_DOMAIN`, and `ROAMCODE_RELAY_ALLOWED_ORIGINS` in `.env`, then start both
services:

```sh
docker compose config --quiet
docker compose up --detach --build
curl --fail --silent "https://${ROAMCODE_RELAY_DOMAIN}/ready"
```

Production deployments should set `ROAMCODE_RELAY_IMAGE` and `ROAMCODE_EDGE_IMAGE` to reviewed immutable image
digests from a stable release's `roamcode-cloud-images.json`, back up the `relay-data` volume, and monitor `/ready`.
The provisioning capability is mounted as a read-only, uid-10001 mode-0400 file, never placed in the container
environment. During a planned rotation, install up to three former capabilities as separate uid-10001 mode-0400
files under `secrets/previous-root-tokens`, recreate the relay, and remove them promptly after the operator has moved
to the new capability. Route and device credentials are independent of this root overlap.

`ROAMCODE_RELAY_ACCOUNTS_ENABLED=1` (the Compose default) enables durable hosted accounts and per-account route/device
quotas. Keep it off for a minimal root-provisioned private relay. On a shared deployment, use the root API only from an
operator network to create or suspend accounts; give each user only their one-time account capability. Hosts provision
their own route id and host capability with `roamcode cloud connect`, so the relay receives only a credential hash.

The relay binds to host loopback on port 4281 as well as its private Compose network. A Cloudflare Tunnel can therefore
publish the relay without opening inbound ports by routing a stable hostname to `http://127.0.0.1:4281`. Publishing
the static PWA through a tunnel requires a second hostname/ingress aimed at the edge service. Do not put an interactive
identity proxy in front of the relay unless both the browser and native host connector can satisfy that proxy; relay
routing credentials and E2E host/device authentication are the protocol's portable access boundary.

## Host configuration

The supported user workflow is:

```sh
roamcode cloud connect \
  --url https://relay.example.com \
  --app-url https://app.example.com \
  --account-token-file /secure/path/account-token \
  --label "Workstation"
roamcode cloud pair
```

The account-token file must be an owned, non-symlink regular file with mode 0600. The CLI persists the following
equivalent host settings atomically and restarts only that host's managed RoamCode service. Infrastructure automation
may still provide all of them through environment variables:

```text
ROAMCODE_RELAY_URL=wss://relay.example.com/v1/connect
ROAMCODE_RELAY_ROUTE_ID=<opaque route id>
ROAMCODE_RELAY_HOST_CREDENTIAL=<route-specific host capability>
ROAMCODE_RELAY_APP_URL=https://app.example.com
ROAMCODE_RELAY_HOST_LABEL=<user-visible machine label>
```

Never put these values in a repository, image, issue, shell transcript, or pairing URL. Browser pairing carries only a
five-minute bootstrap in a URL fragment; durable routing and device credentials are stored independently and can be
revoked.

See [the protocol contract](../../docs/relay-protocol.md) and [cloud operations](../../docs/cloud-relay.md) before
operating a shared relay.

For an outbound-only deployment with no VM public address or inbound application ports, use the immutable-digest GCP
and remotely managed Cloudflare Tunnel profile in [`gcp`](gcp/README.md).
