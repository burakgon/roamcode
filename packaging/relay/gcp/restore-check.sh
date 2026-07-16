#!/bin/sh
set -eu

CONFIG=/etc/roamcode-cloud/cloud.env
BACKUP_DIR=/var/lib/roamcode-cloud/backups
ROOT_TOKEN=/etc/roamcode-cloud/secrets/relay-root-token
container="roamcode-restore-check-$$"
work=

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap cleanup EXIT INT TERM

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this restore check as root" >&2
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

/usr/local/lib/roamcode-cloud/backup.sh
latest=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -print | sort | tail -1)
test -n "$latest"
(
  cd "$latest"
  sha256sum --check SHA256SUMS >/dev/null
)

work=$(mktemp -d /var/lib/roamcode-cloud/.restore-check.XXXXXX)
cp -a "$latest/." "$work/"
for database in routes accounts; do
  test -f "$work/${database}.db"
  test "$(sqlite3 "$work/${database}.db" 'PRAGMA integrity_check;')" = ok
done
chown -R 10001:10001 "$work"

docker run --detach --name "$container" \
  --user 10001:10001 \
  --network none \
  --read-only \
  --tmpfs /tmp:size=16m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --memory 768m \
  --log-driver none \
  --env NODE_ENV=production \
  --env ROAMCODE_RELAY_ROOT_TOKEN_FILE=/run/secrets/relay-root-token \
  --env ROAMCODE_RELAY_DATA_DIR=/var/lib/roamcode-relay \
  --env ROAMCODE_RELAY_ACCOUNTS_ENABLED=1 \
  --env "ROAMCODE_RELAY_ALLOWED_ORIGINS=https://${ROAMCODE_APP_DOMAIN}" \
  --mount type=bind,source="$work",target=/var/lib/roamcode-relay \
  --mount type=bind,source="$ROOT_TOKEN",target=/run/secrets/relay-root-token,readonly \
  "$ROAMCODE_RELAY_IMAGE" >/dev/null

attempt=0
until docker exec "$container" node -e \
  'fetch("http://127.0.0.1:4281/ready", { signal: AbortSignal.timeout(5000) }).then(response => {
    if (!response.ok) process.exit(1);
  }).catch(() => process.exit(1))'
do
  if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
    echo "Restored relay exited before becoming ready" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -ge 30 ] && exit 1
  sleep 1
done

docker stop --time 5 "$container" >/dev/null
for database in routes accounts; do
  test -f "$work/${database}.db"
  test "$(sqlite3 "$work/${database}.db" 'PRAGMA integrity_check;')" = ok
done
printf '%s\n' "RoamCode relay backup restore check passed"
