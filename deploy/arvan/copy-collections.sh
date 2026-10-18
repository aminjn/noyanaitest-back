#!/usr/bin/env bash
# Put a few collections back from a dump, leaving everything else as it is:
#
#   bash copy-collections.sh /root/before-import-XXXX.archive.gz advertisements staticimages
#
# e.g. the ts site's banners (advertisements) after the database was
# rebuilt from the old site. The named collections here are replaced by the
# dump's; the ones replaced are first saved to /root/before-copy-*.archive.gz.
# Env: SRC_DB = the database inside the dump (default NoyanAiTs).
set -euo pipefail
trap 'echo "!! stopped at line $LINENO: $BASH_COMMAND" >&2' ERR

ARCHIVE="${1:?usage: bash copy-collections.sh <dump.archive.gz> <collection>...}"
shift
[ "$#" -gt 0 ] || { echo "name at least one collection" >&2; exit 1; }
[ -s "$ARCHIVE" ] || { echo "No such file: $ARCHIVE" >&2; exit 1; }
SRC_DB="${SRC_DB:-NoyanAiTs}"
APP_DIR=/var/www/noyanai-ts
DST_DB="$(grep -E '^DB_NAME=' "$APP_DIR/back/.env" | cut -d= -f2 | tr -d '\r')"
DST_DB="${DST_DB:-NoyanAiTs}"
PASSWORD="$(cat /root/.noyanai-ts/mongo_password)"
TMP_DB=CopyCollectionsSource
auth=(-u noyanai -p "$PASSWORD" --authenticationDatabase admin)

includes=(); for c in "$@"; do includes+=(--nsInclude "$SRC_DB.$c"); done

BACKUP="/root/before-copy-$(date +%Y%m%d-%H%M%S).archive.gz"
echo "==> Backup of $* in $DST_DB -> $BACKUP"
for c in "$@"; do
  docker exec noyanai-mongo mongodump --quiet "${auth[@]}" --db "$DST_DB" --collection "$c" --gzip --archive="/tmp/before-$c.gz"
  docker cp "noyanai-mongo:/tmp/before-$c.gz" "${BACKUP%.archive.gz}-$c.archive.gz" >/dev/null
  docker exec noyanai-mongo rm -f "/tmp/before-$c.gz"
done

echo "==> Reading $* from $ARCHIVE"
docker cp "$ARCHIVE" noyanai-mongo:/tmp/copy.archive.gz
docker exec noyanai-mongo mongorestore --quiet --noIndexRestore "${auth[@]}" --gzip --archive=/tmp/copy.archive.gz \
  "${includes[@]}" --nsFrom "$SRC_DB.*" --nsTo "$TMP_DB.*" --drop
docker exec noyanai-mongo rm -f /tmp/copy.archive.gz

echo "==> Replacing them in $DST_DB"
docker exec -e C_LIST="$*" -e C_SRC="$TMP_DB" -e C_DST="$DST_DB" noyanai-mongo mongosh --quiet "${auth[@]}" --eval '
const src = db.getSiblingDB(process.env.C_SRC), dst = db.getSiblingDB(process.env.C_DST);
for (const c of process.env.C_LIST.split(" ")) {
  const docs = src[c].find().toArray();
  dst[c].deleteMany({});
  if (docs.length) dst[c].insertMany(docs);
  print("  " + c + ": " + docs.length);
}
src.dropDatabase();'

pm2 restart noyanai-ts-back --update-env >/dev/null 2>&1 || true
echo "Done. Undo one: SRC_DB=$DST_DB bash $0 ${BACKUP%.archive.gz}-<collection>.archive.gz <collection>"
