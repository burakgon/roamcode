#!/bin/sh
set -eu

CONFIG=/etc/roamcode-cloud/cloud.env
COMPOSE=/etc/roamcode-cloud/compose.yaml
SECRETS_DIR=/etc/roamcode-cloud/secrets

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this verification as root" >&2
  exit 1
fi

test -r "$CONFIG"
test -r "$COMPOSE"
test "$(findmnt -n -o TARGET --target /var/lib/roamcode-cloud)" = /var/lib/roamcode-cloud

set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

compose() {
  docker compose --env-file "$CONFIG" -f "$COMPOSE" "$@"
}

assert_container() {
  service=$1
  expected_user=$2
  expected_image=$3
  container=$(compose ps -q "$service")
  test -n "$container"
  test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
  test "$(docker inspect --format '{{.Config.User}}' "$container")" = "$expected_user"
  test "$(docker inspect --format '{{.Config.Image}}' "$container")" = "$expected_image"
  docker inspect "$container" | jq -e '
    .[0].HostConfig.ReadonlyRootfs == true and
    (.[0].HostConfig.CapDrop | index("ALL") != null) and
    (.[0].HostConfig.SecurityOpt | index("no-new-privileges:true") != null) and
    .[0].HostConfig.PidsLimit > 0 and
    .[0].HostConfig.Memory > 0 and
    .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
    .[0].HostConfig.LogConfig.Type == "local" and
    ((.[0].HostConfig.PortBindings // {}) | length == 0)
  ' >/dev/null
}

assert_container relay 10001:10001 "$ROAMCODE_RELAY_IMAGE"
assert_container edge 10002:10002 "$ROAMCODE_EDGE_IMAGE"
assert_container tunnel 65532:65532 "$CLOUDFLARED_IMAGE"

relay_container=$(compose ps -q relay)
edge_container=$(compose ps -q edge)
tunnel_container=$(compose ps -q tunnel)
test "$(docker inspect --format '{{.State.Health.Status}}' "$relay_container")" = healthy
docker inspect "$relay_container" | jq -e '
  ([.[0].Config.Env[] | select(startswith("ROAMCODE_RELAY_ROOT_TOKEN="))] | length == 0) and
  ([.[0].Config.Env[] | select(startswith("ROAMCODE_RELAY_PREVIOUS_ROOT_TOKENS="))] | length == 0) and
  ([.[0].Mounts[] | select(.Destination == "/run/secrets/relay-root-token" and .RW == false)] | length == 1) and
  ([.[0].Mounts[] | select(.Destination == "/run/secrets/previous-root-tokens" and .RW == false)] | length == 1)
' >/dev/null
docker inspect "$tunnel_container" | jq -e '
  ([.[0].Config.Env[] | select(startswith("TUNNEL_TOKEN=") or startswith("ROAMCODE_TUNNEL_TOKEN="))] |
    length == 0) and
  ([.[0].Mounts[] | select(.Destination == "/run/secrets/cloudflare-tunnel-token" and .RW == false)] | length == 1)
' >/dev/null

relay_networks=$(docker inspect "$relay_container" | jq -c '.[0].NetworkSettings.Networks')
edge_networks=$(docker inspect "$edge_container" | jq -c '.[0].NetworkSettings.Networks')
tunnel_networks=$(docker inspect "$tunnel_container" | jq -c '.[0].NetworkSettings.Networks')
test "$(printf '%s' "$relay_networks" | jq 'length')" = 1
test "$(printf '%s' "$edge_networks" | jq 'length')" = 1
test "$(printf '%s' "$tunnel_networks" | jq 'length')" = 2
private_network=$(printf '%s' "$relay_networks" | jq -r 'to_entries[0].value.NetworkID')
test "$(printf '%s' "$edge_networks" | jq -r --arg id "$private_network" '[.[] | select(.NetworkID == $id)] | length')" = 1
test "$(printf '%s' "$tunnel_networks" | jq -r --arg id "$private_network" '[.[] | select(.NetworkID == $id)] | length')" = 1
egress_network=$(printf '%s' "$tunnel_networks" | jq -r --arg id "$private_network" '.[] | select(.NetworkID != $id) | .NetworkID')
test "$(docker network inspect --format '{{.Internal}}' "$private_network")" = true
test "$(docker network inspect --format '{{.Internal}}' "$egress_network")" = false

test "$(stat -c '%a:%u:%g' "$SECRETS_DIR/relay-root-token")" = 400:10001:10001
test "$(stat -c '%a:%u:%g' "$SECRETS_DIR/previous-root-tokens")" = 700:10001:10001
previous_entries=$(find "$SECRETS_DIR/previous-root-tokens" -mindepth 1 -maxdepth 1 -printf . | wc -c)
previous_files=$(find "$SECRETS_DIR/previous-root-tokens" -mindepth 1 -maxdepth 1 -type f -printf . | wc -c)
test "$previous_entries" -eq "$previous_files"
test "$previous_files" -le 3
find "$SECRETS_DIR/previous-root-tokens" -mindepth 1 -maxdepth 1 -type f -exec sh -c '
  for file do
    test "$(stat -c "%a:%u:%g" "$file")" = 400:10001:10001
  done
' sh {} +
test "$(stat -c '%a:%u:%g' "$SECRETS_DIR/cloudflare-tunnel-token")" = 400:65532:65532
test "$(stat -c '%a:%u:%g' /var/lib/roamcode-cloud/relay)" = 750:10001:10001
test "$(stat -c '%a:%u:%g' /var/lib/roamcode-cloud/caddy-data)" = 750:10002:10002
test "$(stat -c '%a:%u:%g' /var/lib/roamcode-cloud/caddy-config)" = 750:10002:10002

systemctl is-enabled roamcode-cloud.service >/dev/null
systemctl is-active roamcode-cloud.service >/dev/null
systemctl is-enabled roamcode-cloud-backup.timer >/dev/null
systemctl is-active roamcode-cloud-backup.timer >/dev/null

/usr/local/lib/roamcode-cloud/healthcheck.sh
printf '%s\n' "RoamCode cloud local verification passed"
