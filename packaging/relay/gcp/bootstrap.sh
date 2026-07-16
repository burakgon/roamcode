#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl jq sqlite3 util-linux gnupg
install -m 0755 -d /etc/apt/keyrings
if [ ! -s /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
fi
chmod a+r /etc/apt/keyrings/docker.gpg
# Debian guarantees this system metadata path.
# shellcheck disable=SC1091
. /etc/os-release
printf '%s\n' \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
  >/etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

install -d -m 755 /etc/roamcode-cloud /usr/local/lib/roamcode-cloud
install -d -m 755 /var/lib/roamcode-cloud
if [ "$(findmnt -n -o TARGET --target /var/lib/roamcode-cloud 2>/dev/null || true)" != /var/lib/roamcode-cloud ]; then
  echo "Mount the dedicated RoamCode data disk at /var/lib/roamcode-cloud before bootstrapping" >&2
  exit 1
fi
install -d -m 700 /etc/roamcode-cloud/secrets /var/lib/roamcode-cloud/backups
install -d -m 700 -o 10001 -g 10001 /etc/roamcode-cloud/secrets/previous-root-tokens
install -d -m 750 -o 10001 -g 10001 /var/lib/roamcode-cloud/relay
install -d -m 750 -o 10002 -g 10002 /var/lib/roamcode-cloud/caddy-data /var/lib/roamcode-cloud/caddy-config

install -m 755 /tmp/roamcode-cloud/fetch-secrets.sh /usr/local/lib/roamcode-cloud/fetch-secrets.sh
install -m 755 /tmp/roamcode-cloud/healthcheck.sh /usr/local/lib/roamcode-cloud/healthcheck.sh
install -m 755 /tmp/roamcode-cloud/backup.sh /usr/local/lib/roamcode-cloud/backup.sh
install -m 755 /tmp/roamcode-cloud/restore-check.sh /usr/local/lib/roamcode-cloud/restore-check.sh
install -m 755 /tmp/roamcode-cloud/verify.sh /usr/local/lib/roamcode-cloud/verify.sh
install -m 755 /tmp/roamcode-cloud/verify-public.sh /usr/local/lib/roamcode-cloud/verify-public.sh
install -m 755 /tmp/roamcode-cloud/verify-public-wss.sh /usr/local/lib/roamcode-cloud/verify-public-wss.sh
install -m 644 /tmp/roamcode-cloud/public-wss-smoke.mjs /usr/local/lib/roamcode-cloud/public-wss-smoke.mjs
install -m 644 /tmp/roamcode-cloud/compose.yaml /etc/roamcode-cloud/compose.yaml
install -m 600 /tmp/roamcode-cloud/cloud.env /etc/roamcode-cloud/cloud.env
install -m 644 /tmp/roamcode-cloud/roamcode-cloud.service /etc/systemd/system/roamcode-cloud.service
install -m 644 /tmp/roamcode-cloud/roamcode-cloud-backup.service /etc/systemd/system/roamcode-cloud-backup.service
install -m 644 /tmp/roamcode-cloud/roamcode-cloud-backup.timer /etc/systemd/system/roamcode-cloud-backup.timer

systemctl daemon-reload
systemctl enable roamcode-cloud.service
systemctl enable --now roamcode-cloud-backup.timer
