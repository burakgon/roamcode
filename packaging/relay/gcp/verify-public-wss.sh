#!/bin/sh
set -eu

CONFIG=/etc/roamcode-cloud/cloud.env
COMPOSE=/etc/roamcode-cloud/compose.yaml
ROOT_TOKEN=/etc/roamcode-cloud/secrets/relay-root-token
SMOKE_SCRIPT=/usr/local/lib/roamcode-cloud/public-wss-smoke.mjs

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this verification as root" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

if ! printf '%s' "${ROAMCODE_RELAY_IMAGE:-}" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
  echo "Relay image must be pinned by digest" >&2
  exit 1
fi
test -r "$ROOT_TOKEN"
test -r "$SMOKE_SCRIPT"

compose() {
  docker compose --env-file "$CONFIG" -f "$COMPOSE" "$@"
}

tunnel_container=$(compose ps -q tunnel)
relay_container=$(compose ps -q relay)
test -n "$tunnel_container"
test -n "$relay_container"
test "$(docker inspect --format '{{.State.Running}}' "$tunnel_container")" = true
test "$(docker inspect --format '{{.State.Running}}' "$relay_container")" = true
relay_internal_address=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$relay_container")
printf '%s' "$relay_internal_address" | grep -Eq \
  '^(10\.([0-9]{1,3}\.){2}[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})$'

docker run --rm \
  --user 10001:10001 \
  --network "container:${tunnel_container}" \
  --read-only \
  --tmpfs /tmp:size=16m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 256m \
  --log-driver none \
  --env "ROAMCODE_APP_DOMAIN=${ROAMCODE_APP_DOMAIN}" \
  --env "ROAMCODE_RELAY_DOMAIN=${ROAMCODE_RELAY_DOMAIN}" \
  --env "ROAMCODE_RELAY_INTERNAL_ORIGIN=http://${relay_internal_address}:4281" \
  --env ROAMCODE_RELAY_ROOT_TOKEN_FILE=/run/secrets/relay-root-token \
  --mount type=bind,source="$ROOT_TOKEN",target=/run/secrets/relay-root-token,readonly \
  --mount type=bind,source="$SMOKE_SCRIPT",target=/run/roamcode-public-wss-smoke.mjs,readonly \
  --entrypoint node \
  "$ROAMCODE_RELAY_IMAGE" /run/roamcode-public-wss-smoke.mjs
