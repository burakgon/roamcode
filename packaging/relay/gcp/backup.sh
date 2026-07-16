#!/bin/sh
set -eu

DATA_DIR=/var/lib/roamcode-cloud/relay
BACKUP_DIR=/var/lib/roamcode-cloud/backups
LOCK_FILE=/run/lock/roamcode-cloud-backup.lock

install -d -m 700 "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

timestamp=$(date -u +%Y%m%dT%H%M%S%NZ)
work="$BACKUP_DIR/.${timestamp}.new"
destination="$BACKUP_DIR/$timestamp"
install -d -m 700 "$work"

cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

for database in routes accounts; do
  source="$DATA_DIR/${database}.db"
  if [ -f "$source" ]; then
    sqlite3 "$source" ".timeout 10000" ".backup '$work/${database}.db'"
    test "$(sqlite3 "$work/${database}.db" 'PRAGMA integrity_check;')" = ok
  fi
done

test -f "$work/routes.db"
test -f "$work/accounts.db"
(
  cd "$work"
  sha256sum ./*.db >SHA256SUMS
)
mv "$work" "$destination"
sync -f "$destination"
trap - EXIT INT TERM
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mmin +10080 -exec rm -rf -- {} +
