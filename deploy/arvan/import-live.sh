#!/usr/bin/env bash
# Copy the live site's data into this server (after setup.sh):
#
#   bash import-live.sh /root/noyanai.archive.gz [/root/public-files.tar.gz]
#
# 1st argument: `mongodump --gzip --archive=...` of the live database.
# 2nd argument (optional): tar.gz of the live backend's Public/ folder
#                          (uploaded images/files), or that folder itself
#                          (its files are copied, none here replaced).
# Env: SRC_DB = database name inside the dump (default NoyanAi).
#      FRESH=1   this site's database is emptied first (a backup of it is
#                kept in /root/before-import-*.archive.gz): the dump becomes
#                the whole database, nothing of the old one is mixed in.
#      NO_INDEXES=1  restore without the dump's indexes; the backend builds
#                its own at start (a dump from a newer Mongo can carry index
#                versions this one refuses).
#
# Without FRESH, collections in the dump replace the ones here and data that
# only exists here (e.g. translations made on this server) is kept. The super
# admin from SUPER_ADMIN_PHONES is re-applied on the restart at the end.
set -euo pipefail
trap 'echo "!! stopped at line $LINENO: $BASH_COMMAND" >&2' ERR

ARCHIVE="${1:?usage: bash import-live.sh <dump.archive.gz> [public-files.tar.gz]}"
FILES="${2:-}"
SRC_DB="${SRC_DB:-NoyanAi}"
APP_DIR=/var/www/noyanai-ts
DST_DB="$(grep -E '^DB_NAME=' "$APP_DIR/back/.env" | cut -d= -f2)"
PASSWORD="$(cat /root/.noyanai-ts/mongo_password)"

[ -s "$ARCHIVE" ] || { echo "No such file: $ARCHIVE" >&2; exit 1; }

DST_DB="${DST_DB:-NoyanAiTs}"
if [ "${FRESH:-}" = 1 ]; then
  BACKUP="/root/before-import-$(date +%Y%m%d-%H%M%S).archive.gz"
  echo "==> Backup of $DST_DB -> $BACKUP"
  docker exec noyanai-mongo mongodump --quiet -u noyanai -p "$PASSWORD" --authenticationDatabase admin \
    --db "$DST_DB" --gzip --archive=/tmp/before.archive.gz
  docker cp noyanai-mongo:/tmp/before.archive.gz "$BACKUP" >/dev/null
  docker exec noyanai-mongo rm -f /tmp/before.archive.gz
  chmod 600 "$BACKUP"
  echo "   (undo: SRC_DB=$DST_DB FRESH=1 bash $0 $BACKUP)"
  # the backend would recreate collections while the database is replaced
  pm2 stop noyanai-ts-back >/dev/null 2>&1 || true
  docker exec noyanai-mongo mongosh --quiet -u noyanai -p "$PASSWORD" --authenticationDatabase admin \
    --eval "db.getSiblingDB('$DST_DB').dropDatabase().ok" >/dev/null
fi

echo "==> Restoring $SRC_DB -> ${DST_DB:-NoyanAiTs}"
docker cp "$ARCHIVE" noyanai-mongo:/tmp/live.archive.gz
docker exec noyanai-mongo mongorestore ${NO_INDEXES:+--noIndexRestore} --numParallelCollections=1 --numInsertionWorkersPerCollection=1 \
  -u noyanai -p "$PASSWORD" --authenticationDatabase admin \
  --gzip --archive=/tmp/live.archive.gz \
  --nsFrom "$SRC_DB.*" --nsTo "${DST_DB:-NoyanAiTs}.*" --drop 2>&1 \
    | { grep -vE "(reading metadata|restoring|finished restoring|no indexes|index: |preparing collections|using [0-9]+ insertion)" || true; }
docker exec noyanai-mongo rm -f /tmp/live.archive.gz

if [ -n "$FILES" ]; then
  echo "==> Uploaded files"
  mkdir -p "$APP_DIR/back/Public"
  if [ -d "$FILES" ]; then cp -an "$FILES/." "$APP_DIR/back/Public/"
  else tar -xzf "$FILES" -C "$APP_DIR/back/Public"; fi
fi

echo "==> Restarting backend"
pm2 restart noyanai-ts-back --update-env >/dev/null
sleep 15
pm2 logs noyanai-ts-back --lines 20 --nostream | grep -E "superAdmin|i18n|DB" || true
echo "Done."
