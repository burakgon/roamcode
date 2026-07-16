#!/bin/sh
set -eu

CONFIG=${1:-./cloud.env}
if [ ! -r "$CONFIG" ]; then
  echo "Pass the reviewed cloud.env path as the first argument" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

validate_domain() {
  if ! printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'; then
    echo "Cloud hostnames must be lowercase DNS names without a scheme or path" >&2
    exit 1
  fi
}

validate_domain "${ROAMCODE_APP_DOMAIN:?public app hostname is required}"
validate_domain "${ROAMCODE_RELAY_DOMAIN:?public relay hostname is required}"
command -v curl >/dev/null

umask 077
work=$(mktemp -d)
cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

header_value() {
  name=$1
  file=$2
  awk -v name="$name" '
    tolower($1) == tolower(name) ":" {
      sub(/^[^:]+:[[:space:]]*/, "")
      sub(/\r$/, "")
      value=$0
    }
    END { print value }
  ' "$file"
}

require_header_contains() {
  file=$1
  name=$2
  expected=$3
  value=$(header_value "$name" "$file")
  case "$value" in
    *"$expected"*) ;;
    *)
      echo "Public response is missing required $name policy" >&2
      exit 1
      ;;
  esac
}

assert_redirect() {
  host=$1
  path=$2
  expected="https://${host}${path}"
  headers="$work/redirect-$3.headers"
  code=$(curl --silent --show-error --max-time 15 --proto '=http' --head --dump-header "$headers" \
    --output /dev/null --write-out '%{http_code}' "http://${host}${path}")
  if [ "$code" != 308 ]; then
    echo "Plain HTTP must return the reviewed 308 redirect before deployment is accepted" >&2
    exit 1
  fi
  location=$(header_value location "$headers")
  if [ "$location" != "$expected" ]; then
    echo "HTTPS redirect did not preserve host, path, and query" >&2
    exit 1
  fi
}

probe="$(date -u +%s)-$$"
assert_redirect "$ROAMCODE_APP_DOMAIN" "/roamcode-https-check-${probe}?probe=${probe}" app
assert_redirect "$ROAMCODE_RELAY_DOMAIN" "/roamcode-https-check-${probe}?probe=${probe}" relay

app_headers="$work/app.headers"
app_body="$work/app.body"
app_code=$(curl --silent --show-error --fail-with-body --max-time 15 --proto '=https' --tlsv1.2 \
  --dump-header "$app_headers" --output "$app_body" --write-out '%{http_code}' "https://${ROAMCODE_APP_DOMAIN}/")
test "$app_code" = 200
grep -Fq '<div id="root"></div>' "$app_body"
require_header_contains "$app_headers" cache-control no-store
require_header_contains "$app_headers" strict-transport-security max-age=
require_header_contains "$app_headers" content-security-policy "default-src 'self'"
require_header_contains "$app_headers" x-content-type-options nosniff
require_header_contains "$app_headers" x-frame-options DENY
require_header_contains "$app_headers" referrer-policy no-referrer
require_header_contains "$app_headers" permissions-policy 'camera=()'

asset=$(grep -Eo '/assets/[A-Za-z0-9._/-]+' "$app_body" | head -1 || true)
if [ -z "$asset" ]; then
  echo "PWA shell did not reference a versioned asset" >&2
  exit 1
fi
asset_headers="$work/asset.headers"
asset_code=$(curl --silent --show-error --fail --max-time 15 --proto '=https' --tlsv1.2 \
  --dump-header "$asset_headers" --output /dev/null --write-out '%{http_code}' \
  "https://${ROAMCODE_APP_DOMAIN}${asset}")
test "$asset_code" = 200
require_header_contains "$asset_headers" cache-control immutable

spa_body="$work/spa.body"
spa_code=$(curl --silent --show-error --fail-with-body --max-time 15 --proto '=https' --tlsv1.2 \
  --output "$spa_body" --write-out '%{http_code}' "https://${ROAMCODE_APP_DOMAIN}/workspaces")
test "$spa_code" = 200
grep -Fq '<div id="root"></div>' "$spa_body"

missing_asset_headers="$work/missing-asset.headers"
missing_asset_body="$work/missing-asset.body"
missing_asset_code=$(curl --silent --show-error --max-time 15 --proto '=https' --tlsv1.2 \
  --dump-header "$missing_asset_headers" --output "$missing_asset_body" --write-out '%{http_code}' \
  "https://${ROAMCODE_APP_DOMAIN}/assets/roamcode-missing-smoke.js")
test "$missing_asset_code" = 404
if grep -Fq '<div id="root"></div>' "$missing_asset_body"; then
  echo "A missing PWA asset must not fall back to the HTML shell" >&2
  exit 1
fi
require_header_contains "$missing_asset_headers" cache-control no-store

missing_file_body="$work/missing-file.body"
missing_file_code=$(curl --silent --show-error --max-time 15 --proto '=https' --tlsv1.2 \
  --output "$missing_file_body" --write-out '%{http_code}' \
  "https://${ROAMCODE_APP_DOMAIN}/roamcode-missing-smoke.css")
test "$missing_file_code" = 404
if grep -Fq '<div id="root"></div>' "$missing_file_body"; then
  echo "A missing static file must not fall back to the HTML shell" >&2
  exit 1
fi

relay_headers="$work/relay.headers"
relay_body="$work/relay.body"
relay_code=$(curl --silent --show-error --fail-with-body --max-time 15 --proto '=https' --tlsv1.2 \
  --dump-header "$relay_headers" --output "$relay_body" --write-out '%{http_code}' \
  "https://${ROAMCODE_RELAY_DOMAIN}/ready")
test "$relay_code" = 200
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' "$relay_body"
require_header_contains "$relay_headers" cache-control no-store
require_header_contains "$relay_headers" strict-transport-security max-age=
require_header_contains "$relay_headers" content-security-policy "default-src 'none'"
require_header_contains "$relay_headers" x-content-type-options nosniff

unknown_code=$(curl --silent --show-error --max-time 15 --proto '=https' --tlsv1.2 \
  --output /dev/null --write-out '%{http_code}' "https://${ROAMCODE_RELAY_DOMAIN}/not-a-relay-route")
test "$unknown_code" = 404

printf '%s\n' "RoamCode cloud public TLS, redirect, cache, and response-policy verification passed"
