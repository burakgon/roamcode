#!/bin/sh
set -eu

CONFIG=/etc/roamcode-cloud/cloud.env
COMPOSE=/etc/roamcode-cloud/compose.yaml
set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

compose() {
  docker compose --env-file "$CONFIG" -f "$COMPOSE" "$@"
}

compose exec -T relay node -e \
  'fetch("http://127.0.0.1:4281/ready", { signal: AbortSignal.timeout(5000) }).then(async response => {
    const body = await response.json();
    if (!response.ok || body.status !== "ready") process.exit(1);
  }).catch(() => process.exit(1))'

edge_body=$(compose exec -T edge wget -T 5 -qO- --header="Host: ${ROAMCODE_APP_DOMAIN}" http://127.0.0.1/)
printf '%s' "$edge_body" | grep -q '<div id="root"></div>'

compose exec -T edge wget -T 5 -qO /dev/null http://tunnel:20241/ready
