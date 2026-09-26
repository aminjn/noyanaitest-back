#!/usr/bin/env bash
# Copy the live site's data into this server (after setup.sh):
#
#   bash import-live.sh /root/noyanai.archive.gz [/root/public-files.tar.gz]
#
# 1st argument: `mongodump --gzip --archive=...` of the live database.
# 2nd argument (optional): tar.gz of the live backend's Public/ folder
#                          (uploaded images/files).
# Env: SRC_DB = database name inside the dump (default NoyanAi).
#
# Collections in the dump replace the ones here; data that only exists here
# (e.g. translations made on this server) is kept. The super admin from
# SUPER_ADMIN_PHONES is re-applied on the restart at the end.
set -euo pipefail

ARCHIVE="${1:?usage: bash import-live.sh <dump.archive.gz> [public-files.tar.gz]}"
FILES="${2:-}"
SRC_DB="${SRC_DB:-NoyanAi}"
APP_DIR=/var/www/noyanai-ts
DST_DB="$(grep -E '^DB_NAME=' "$APP_DIR/back/.env" | cut -d= -f2)"
PASSWORD="$(cat /root/.noyanai-ts/mongo_password)"

[ -s "$ARCHIVE" ] || { echo "No such file: $ARCHIVE" >&2; exit 1; }

echo "==> Restoring $SRC_DB -> ${DST_DB:-NoyanAiTs}"
docker cp "$ARCHIVE" noyanai-mongo:/tmp/live.archive.gz
docker exec noyanai-mongo mongorestore --quiet \
  -u noyanai -p "$PASSWORD" --authenticationDatabase admin \
  --gzip --archive=/tmp/live.archive.gz \
  --nsFrom "$SRC_DB.*" --nsTo "${DST_DB:-NoyanAiTs}.*" --drop
docker exec noyanai-mongo rm -f /tmp/live.archive.gz

if [ -n "$FILES" ]; then
  echo "==> Uploaded files"
  mkdir -p "$APP_DIR/back/Public"
  tar -xzf "$FILES" -C "$APP_DIR/back/Public"
fi

echo "==> Restarting backend"
pm2 restart noyanai-ts-back --update-env >/dev/null
sleep 5
pm2 logs noyanai-ts-back --lines 20 --nostream | grep -E "superAdmin|i18n|DB" || true
echo "Done."
