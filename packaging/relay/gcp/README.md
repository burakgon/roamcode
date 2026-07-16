# GCP + Cloudflare Tunnel reference deployment

This directory runs the immutable RoamCode relay and PWA images on a dedicated Google Compute Engine VM with no
public address or inbound application ports. A remotely managed Cloudflare Tunnel is the only public path:

- `app.roamcode.ai` routes to `http://edge:80`;
- `relay.roamcode.ai` routes to `http://edge:80` so the same edge enforces transport and response policy before
  proxying WebSockets and HTTP to the private relay;
- the catch-all Tunnel rule returns HTTP 404.

The edge treats `X-Forwarded-Proto: http` from the private Tunnel as an explicit request for a same-host HTTPS 308,
preserving path and query. Keep Cloudflare's equivalent Dynamic Redirect as defense in depth when the zone policy is
available. Run `./verify-public.sh cloud.env` from an external workstation; deployment is incomplete if either public
hostname serves content over plain HTTP.

The VM service account can read only the two deployment secrets. Root and Tunnel capabilities are fetched from Secret
Manager into mode-0400 files owned by the exact non-root container users at service start; neither value is stored in
instance metadata, Compose environment variables, images, command arguments, or this repository. Relay data lives on
a dedicated persistent disk. A verified SQLite backup runs daily before a GCP crash-consistent disk snapshot; both
have bounded retention.

For a planned root-capability rotation, copy the current private file without printing it into
`/etc/roamcode-cloud/secrets/previous-root-tokens`, owned by uid/gid 10001 with mode 0400, before adding the new Secret
Manager version. Reload recreates the relay with both capabilities. Delete the overlap file and reload again as soon
as the administering client has moved; at most three previous files are accepted.

`cloud.env.example` requires the exact relay and edge references from a stable release manifest and pins the reviewed
Cloudflare connector by digest. Service startup rejects every unpinned image reference. `compose.yaml` keeps the relay
and edge on an internal Docker network, gives outbound access only to the Tunnel connector, publishes no origin or
diagnostics ports on the host, drops capabilities, uses read-only container roots, and bounds memory, process count,
and logs. Local health checks execute inside the isolated network through Docker rather than opening a host listener.

## Installation order

1. Create a dedicated VPC/subnet, Cloud NAT, least-privilege service account, Secret Manager entries, persistent disk,
   and daily snapshot policy. Attach, format, and mount the data disk at `/var/lib/roamcode-cloud` before bootstrapping;
   the installer refuses to place relay state on the boot disk.
2. Create a remotely managed Cloudflare Tunnel and configure the three ingress rules above. Store its connector token
   as a new Secret Manager version without printing it.
3. Copy this directory to a temporary directory on the VM. Copy `cloud.env.example` to `cloud.env`, replace the image
   owner/repository placeholders from the release manifest, review every immutable digest and secret resource
   name, then run `bootstrap.sh` as root.
4. Start `roamcode-cloud.service` and `roamcode-cloud-backup.timer`.
5. From an authenticated administration workstation, set `ROAMCODE_GCP_PROJECT` and run
   `./configure-monitoring.sh cloud.env`. This idempotently creates one-minute, TLS-validating, three-region PWA and
   relay readiness checks plus two-minute majority-failure alert policies. Attach the organization-approved
   notification channels in Cloud Monitoring; the script deliberately never guesses an email, pager, or webhook.
6. Run `/usr/local/lib/roamcode-cloud/verify.sh` on the VM and
   `/usr/local/lib/roamcode-cloud/verify-public.sh /etc/roamcode-cloud/cloud.env` from the VM or `./verify-public.sh
   cloud.env` from an external workstation. Run `/usr/local/lib/roamcode-cloud/verify-public-wss.sh` on the VM to
   provision a transient route,
   prove a real public WSS upgrade and bidirectional opaque-frame flow through Cloudflare and Caddy, and remove the
   route. Then verify account isolation, route/device quotas, credential rotation, revocation, container restart
   recovery, VM reboot recovery, backup integrity, and a restore drill before onboarding users.

`/usr/local/lib/roamcode-cloud/restore-check.sh` creates a fresh verified backup and boots the pinned relay image
against a disposable restored copy on a network-disabled container. It never modifies the live databases.

## First operator and device access

Use a reviewed administration workstation with Secret Manager access. Export the non-secret project, secret-name,
and public-domain variables from the reviewed deployment configuration. Then fetch the root capability straight into
a short-lived owner-only file; never print or paste it:

```sh
umask 077
root_file=$(mktemp)
trap 'rm -f "$root_file"' EXIT INT TERM
gcloud secrets versions access latest \
  --project "$ROAMCODE_GCP_PROJECT" \
  --secret "$ROAMCODE_RELAY_ROOT_SECRET" \
  --out-file "$root_file"
chmod 600 "$root_file"

roamcode cloud account-create \
  --url "https://${ROAMCODE_RELAY_DOMAIN}" \
  --root-token-file "$root_file" \
  --output /secure/path/roamcode-account-token \
  --label "Primary account" \
  --plan team
```

Transfer that account file through the organization's approved secret channel to the RoamCode host, keep it mode
0600, and connect the host. The host can then create the first remote enrollment itself—no inbound port or existing
browser session is required:

```sh
roamcode cloud connect \
  --url "https://${ROAMCODE_RELAY_DOMAIN}" \
  --app-url "https://${ROAMCODE_APP_DOMAIN}" \
  --account-token-file /secure/path/roamcode-account-token \
  --label "Workstation"
roamcode cloud pair
```

Open the printed one-use link or scan its QR on the new device. Subsequent browsers can use the same command or
**Settings → Devices → Pair remotely**. Remove the short-lived root file when the operator command finishes; keep the
account file for route lifecycle operations and rotate it through `roamcode cloud account-rotate`.

Never test this deployment by modifying a developer's installed RoamCode service. Use a temporary data directory and
an isolated CLI/package install for host/device acceptance tests.
