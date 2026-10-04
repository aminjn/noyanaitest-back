#!/usr/bin/env bash
# Bring the old site's data (noyanai.com) onto this server, in one command:
#
#   OLD_MONGO_URI='mongodb://reader:PASS@LIVE_IP:27017/?authSource=admin' \
#   OLD_FILES_BASE_URL='https://noyanai.com/files' \
#   bash /var/www/noyanai-ts/back/deploy/arvan/import-old.sh
#
# 1. mongodump of the old database from the live server (read only: the
#    live server is never written to; give it a user with the "read" role).
# 2. mongorestore of that dump into the local Mongo as "Noyan" (the local
#    copy is dropped first). The dump stays in /root/noyan-old-*.archive.gz.
# 3. The import (Services/oldSiteImport.ts, the same as the admin's
#    «انتقال همه‌ی داده‌های سایت قدیم» button): every old collection into
#    the current models, in order, without duplicates. Prints the counts.
#
# Env:
#   OLD_MONGO_URI       (required unless SKIP_DUMP=1) the live server's Mongo
#   OLD_DB              the old database's name (default: detected, "Noyan")
#   OLD_FILES_BASE_URL  where the old site serves its uploads; relative image
#                       paths are downloaded from <base>/<path> into Public/
#   SKIP_DUMP=1         keep the local "Noyan" copy, only run the import again
# Extra arguments go to the import: --only=doctor,blog   --no-files
#
# Safe to run again: re-running refreshes what changed on the old site and
# never duplicates; an edit made here on an imported record is kept.
set -euo pipefail

APP_DIR=/var/www/noyanai-ts
STATE=/root/.noyanai-ts
CONTAINER=noyanai-mongo
LOCAL_DB=Noyan
log() { printf '\n==> %s\n' "$*"; }
die() { echo "!! $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -d "$APP_DIR/back" ] || die "$APP_DIR/back not found: run setup.sh first"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || die "container $CONTAINER is not running"
PASSWORD="$(cat "$STATE/mongo_password")"
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
local_mongosh() {
  docker exec "$CONTAINER" mongosh --quiet -u noyanai -p "$PASSWORD" --authenticationDatabase admin "$@"
}

if [ "${SKIP_DUMP:-}" != 1 ]; then
  [ -n "${OLD_MONGO_URI:-}" ] || die "set OLD_MONGO_URI (a read-only user on the live server), or SKIP_DUMP=1"
  # the source must not be this server's own Mongo: its "Noyan" is dropped below
  if printf '%s' "$OLD_MONGO_URI" | grep -Eq '^mongodb://([^@/]*@)?(localhost|127\.0\.0\.1)(:27017)?([/?,]|$)'; then
    die "OLD_MONGO_URI points at this server's own Mongo; use the live server's address (or an SSH tunnel on another port)"
  fi
  # mongodump takes the database by --db and refuses a URI that names
  # another one: move a database in the path into authSource
  URI="$OLD_MONGO_URI"
  PATH_DB="$(printf '%s' "$URI" | sed -nE 's#^mongodb(\+srv)?://[^/]+/([^?]+).*#\2#p')"
  if [ -n "$PATH_DB" ]; then
    URI="$(printf '%s' "$URI" | sed -E 's#^(mongodb(\+srv)?://[^/]+)/[^?]*#\1/#')"
    case "$URI" in
      *authSource=*) ;;
      *\?*) URI="$URI&authSource=$PATH_DB" ;;
      *) URI="$URI?authSource=$PATH_DB" ;;
    esac
    OLD_DB="${OLD_DB:-$PATH_DB}"
  fi
  export OLD_URI="$URI"
  WORK="$(mktemp -d /root/noyan-old.XXXXXX)"
  chmod 700 "$WORK"
  trap 'rm -rf "$WORK"' EXIT
  # the URI (with its password) goes in a file, not on a command line
  printf 'uri: "%s"\n' "$(printf '%s' "$OLD_URI" | sed 's/\\/\\\\/g; s/"/\\"/g')" > "$WORK/src.yaml"
  chmod 600 "$WORK/src.yaml"
  # a throwaway container of the same image, on the host network (reaches the
  # live server and any SSH tunnel on this host)
  # (--entrypoint: the image's entrypoint would run mongo* tools as the
  # mongodb user, who cannot write the root-only work folder)
  tools() {
    local bin="$1"; shift
    docker run --rm --network host --entrypoint "$bin" -e OLD_URI -v "$WORK:/work" "$IMAGE" "$@"
  }

  log "Old database on the live server"
  SRC="${OLD_DB:-}"
  if [ -z "$SRC" ]; then
    SRC="$(tools mongosh --nodb --quiet --eval '
      const c = new Mongo(process.env.OLD_URI);
      const dbs = c.getDB("admin").adminCommand({ listDatabases: 1, nameOnly: true, authorizedDatabases: true }).databases.map((d) => d.name)
        .filter((n) => !["admin", "local", "config"].includes(n));
      const looksOld = (n) => { const cs = c.getDB(n).getCollectionNames(); return cs.includes("doctors") && !cs.includes("doctorprofiles"); };
      const newer = dbs.filter((n) => c.getDB(n).getCollectionNames().includes("doctorprofiles"));
      if (newer.length) print("NOTE " + newer.join(",") + " already use the new models: copy those with import-live.sh instead");
      const pick = dbs.includes("Noyan") ? "Noyan" : dbs.filter(looksOld)[0] || "";
      print("PICK " + pick);
    ' | tee /dev/stderr | sed -n 's/^PICK //p')" || die "cannot reach the live Mongo with OLD_MONGO_URI"
  fi
  [ -n "$SRC" ] || die "no old database found on the live server; set OLD_DB=<name>"
  echo "source database: $SRC"

  log "mongodump $SRC (read only)"
  ARCHIVE="/root/noyan-old-$(date +%Y%m%d-%H%M%S).archive.gz"
  tools mongodump --config=/work/src.yaml --db="$SRC" --gzip --archive=/work/old.archive.gz
  mv "$WORK/old.archive.gz" "$ARCHIVE"
  chmod 600 "$ARCHIVE"
  echo "dump: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

  log "Restore into the local Mongo as $LOCAL_DB (the local copy is replaced)"
  local_mongosh --eval "db.getSiblingDB('$LOCAL_DB').dropDatabase().ok" >/dev/null
  docker cp "$ARCHIVE" "$CONTAINER:/tmp/old.archive.gz"
  docker exec "$CONTAINER" mongorestore --quiet -u noyanai -p "$PASSWORD" --authenticationDatabase admin \
    --gzip --archive=/tmp/old.archive.gz --nsFrom="$SRC.*" --nsTo="$LOCAL_DB.*" --drop
  docker exec "$CONTAINER" rm -f /tmp/old.archive.gz
  local_mongosh --eval "const d=db.getSiblingDB('$LOCAL_DB'); d.getCollectionNames().sort().forEach(c => print('  ' + c + ': ' + d[c].estimatedDocumentCount()))"
fi

log "Import into the new site"
cd "$APP_DIR/back"
[ -f compile/Scripts/importOld.js ] || npm run build
OLD_FILES_BASE_URL="${OLD_FILES_BASE_URL:-}" node compile/Scripts/importOld.js "$@"

# the running site caches directory pages and makes missing slugs at boot
pm2 restart noyanai-ts-back --update-env >/dev/null 2>&1 || true

cat <<EOF

Done. The counts are also on the super admin's page «ابزار توسعه و دیتابیس قدیم»
(/notadmin/cold/migrate). Run this script again any time to bring over what
changed on the old site (SKIP_DUMP=1 re-runs only the import).
EOF
