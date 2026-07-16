#!/bin/sh
set -eu

CONFIG=/etc/roamcode-cloud/cloud.env
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

docker run --rm \
  --user 10001:10001 \
  --network bridge \
  --read-only \
  --tmpfs /tmp:size=16m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 256m \
  --log-driver none \
  --env "ROAMCODE_APP_DOMAIN=${ROAMCODE_APP_DOMAIN}" \
  --env "ROAMCODE_RELAY_DOMAIN=${ROAMCODE_RELAY_DOMAIN}" \
  --env ROAMCODE_RELAY_ROOT_TOKEN_FILE=/run/secrets/relay-root-token \
  --mount type=bind,source="$ROOT_TOKEN",target=/run/secrets/relay-root-token,readonly \
  --mount type=bind,source="$SMOKE_SCRIPT",target=/run/roamcode-public-wss-smoke.mjs,readonly \
  --entrypoint node \
  "$ROAMCODE_RELAY_IMAGE" /run/roamcode-public-wss-smoke.mjs
