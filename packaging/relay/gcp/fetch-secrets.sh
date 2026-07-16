#!/bin/sh
set -eu

CONFIG=/etc/roamcode-cloud/cloud.env
SECRETS_DIR=/etc/roamcode-cloud/secrets
METADATA=http://metadata.google.internal/computeMetadata/v1

if [ ! -r "$CONFIG" ]; then
  echo "RoamCode cloud configuration is missing" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

: "${ROAMCODE_RELAY_ROOT_SECRET:?relay root Secret Manager name is required}"
: "${ROAMCODE_TUNNEL_TOKEN_SECRET:?tunnel token Secret Manager name is required}"

validate_secret_name() {
  case "$1" in
    "" | *[!A-Za-z0-9_-]*)
      echo "Secret Manager names may contain only letters, digits, underscores, and hyphens" >&2
      exit 1
      ;;
  esac
}

validate_domain() {
  if ! printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'; then
    echo "Cloud hostnames must be lowercase DNS names without a scheme or path" >&2
    exit 1
  fi
}

validate_image() {
  if ! printf '%s' "$1" | grep -Eq '^.+@sha256:[0-9a-f]{64}$'; then
    echo "Every cloud image must be pinned by sha256 digest" >&2
    exit 1
  fi
}

validate_secret_name "$ROAMCODE_RELAY_ROOT_SECRET"
validate_secret_name "$ROAMCODE_TUNNEL_TOKEN_SECRET"
validate_domain "${ROAMCODE_APP_DOMAIN:?public app hostname is required}"
validate_domain "${ROAMCODE_RELAY_DOMAIN:?public relay hostname is required}"
validate_image "${ROAMCODE_RELAY_IMAGE:?relay image is required}"
validate_image "${ROAMCODE_EDGE_IMAGE:?edge image is required}"
validate_image "${CLOUDFLARED_IMAGE:?cloudflared image is required}"

install -d -m 700 "$SECRETS_DIR"
install -d -m 700 -o 10001 -g 10001 "$SECRETS_DIR/previous-root-tokens"
project_id=$(curl -fsS -H 'Metadata-Flavor: Google' "$METADATA/project/project-id")
case "$project_id" in
  "" | *[!a-z0-9-]*)
    echo "Metadata returned an invalid project id" >&2
    exit 1
    ;;
esac
access_token=$(
  curl -fsS -H 'Metadata-Flavor: Google' "$METADATA/instance/service-accounts/default/token" |
    jq -er '.access_token'
)

fetch_secret() {
  secret_name=$1
  destination=$2
  owner=$3
  temporary="${destination}.new"
  payload="${destination}.payload.new"
  encoded="${destination}.encoded.new"
  umask 077
  rm -f "$temporary" "$payload" "$encoded"
  printf 'header = "Authorization: Bearer %s"\n' "$access_token" |
    curl --config - --fail --silent --show-error --proto '=https' --tlsv1.2 \
      --output "$payload" \
      "https://secretmanager.googleapis.com/v1/projects/${project_id}/secrets/${secret_name}/versions/latest:access"
  jq -er '.payload.data' "$payload" >"$encoded"
  base64 -d "$encoded" >"$temporary"
  rm -f "$payload" "$encoded"
  test -s "$temporary"
  chown "$owner" "$temporary"
  chmod 400 "$temporary"
  mv -f "$temporary" "$destination"
  sync -f "$destination"
  sync -f "$SECRETS_DIR"
}

temporary=
payload=
encoded=
cleanup() {
  for file in "$temporary" "$payload" "$encoded"; do
    if [ -n "$file" ]; then rm -f "$file"; fi
  done
  unset access_token
}
trap cleanup EXIT INT TERM

fetch_secret "$ROAMCODE_RELAY_ROOT_SECRET" "$SECRETS_DIR/relay-root-token" 10001:10001
fetch_secret "$ROAMCODE_TUNNEL_TOKEN_SECRET" "$SECRETS_DIR/cloudflare-tunnel-token" 65532:65532

trap - EXIT INT TERM
unset access_token
