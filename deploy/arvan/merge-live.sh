#!/usr/bin/env bash
# Merge the current live site's database (NoyanAi, the app before this one)
# into this site, which already holds the ts site's data (import-live.sh):
#
#   OLD_ENV=/home/ubuntu/new/noyanai-back/.env bash merge-live.sh           # preview
#   APPLY=1 OLD_ENV=/home/ubuntu/new/noyanai-back/.env bash merge-live.sh   # write
#
# Only what this site does not have yet is added: a record whose _id is
# already here is left as it is (this site's values win), nothing here is
# changed or deleted. The preview prints, per collection, how many records
# are new and how many are already here, and writes nothing.
# A record a unique index refuses (e.g. a user whose phone already has an
# account here) is not added and is counted as a conflict.
#
# Not merged:
#  - sessions and sign-up leftovers (tokens, pendingusers);
#  - one-document settings this site already has (appconfigs, global*...);
#  - the old directory doctors (doctors): import-old.sh brings them with the
#    duplicate check (Lib/mergeLegacyDoctors.ts);
#  - collections this site does not use (none of its records here).
#
# Env:
#   OLD_ENV / OLD_MONGO_URI   the live Mongo (as in import-old.sh)
#   SRC_DB                    the live database (default NoyanAi)
#   ONLY=a,b                  only these collections
#   SKIP=a,b                  also leave these out
#   SKIP_DUMP=1               use the copy made by the previous run
#   OLD_PUBLIC                the live backend's uploads (default: Public/ next to OLD_ENV)
set -euo pipefail
trap 'echo "!! stopped at line $LINENO: $BASH_COMMAND" >&2' ERR

APP_DIR=/var/www/noyanai-ts
STATE=/root/.noyanai-ts
CONTAINER=noyanai-mongo
COPY_DB=LiveMergeSource
SRC_DB="${SRC_DB:-NoyanAi}"
log() { printf '\n==> %s\n' "$*"; }
die() { echo "!! $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -d "$APP_DIR/back" ] || die "$APP_DIR/back not found: run setup.sh first"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || die "container $CONTAINER is not running"
PASSWORD="$(cat "$STATE/mongo_password")"
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
DST_DB="$(grep -E '^DB_NAME=' "$APP_DIR/back/.env" | cut -d= -f2 | tr -d '\r')"
DST_DB="${DST_DB:-NoyanAiTs}"
. "$(dirname "$0")/old-uri.sh"

if [ "${SKIP_DUMP:-}" != 1 ]; then
  [ -n "${OLD_MONGO_URI:-}" ] || die "set OLD_ENV (the live backend's .env) or OLD_MONGO_URI"
  export OLD_URI="$OLD_MONGO_URI"
  WORK="$(mktemp -d /root/noyan-live.XXXXXX)"
  chmod 700 "$WORK"
  trap 'rm -rf "$WORK"' EXIT
  printf 'uri: "%s"\n' "$(printf '%s' "$OLD_URI" | sed 's/\\/\\\\/g; s/"/\\"/g')" > "$WORK/src.yaml"
  chmod 600 "$WORK/src.yaml"
  log "mongodump $SRC_DB from the live Mongo (read only)"
  docker run --rm --network host --entrypoint mongodump -v "$WORK:/work" "$IMAGE" \
    --config=/work/src.yaml --db="$SRC_DB" --gzip --archive=/work/live.archive.gz
  ARCHIVE="/root/noyan-live-$(date +%Y%m%d-%H%M%S).archive.gz"
  mv "$WORK/live.archive.gz" "$ARCHIVE"
  chmod 600 "$ARCHIVE"
  echo "dump: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
  log "Copy into the local Mongo as $COPY_DB (this site's database is not touched)"
  docker cp "$ARCHIVE" "$CONTAINER:/tmp/live.archive.gz"
  docker exec "$CONTAINER" mongorestore --numParallelCollections=1 --numInsertionWorkersPerCollection=1 -u noyanai -p "$PASSWORD" --authenticationDatabase admin \
    --gzip --archive=/tmp/live.archive.gz --nsFrom="$SRC_DB.*" --nsTo="$COPY_DB.*" --drop 2>&1 \
    | { grep -vE "(reading metadata|restoring|finished restoring|no indexes|index: |preparing collections|using [0-9]+ insertion)" || true; }
  docker exec "$CONTAINER" rm -f /tmp/live.archive.gz
fi

if [ "${APPLY:-}" = 1 ]; then log "Merge $SRC_DB into $DST_DB"; else log "Preview: what would be added to $DST_DB (nothing is written)"; fi
cat > "$STATE/merge-live.js" <<'JS'
const env = process.env;
const src = db.getSiblingDB(env.M_COPY), dst = db.getSiblingDB(env.M_DST);
const apply = env.M_APPLY === "1";
const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const only = list(env.M_ONLY), skip = list(env.M_SKIP);
const never = ["tokens", "pendingusers", "doctors", "sitesettings", "status"];
const single = (n) => /^global/.test(n) || ["appconfigs", "textcontents", "staticimages", "botinstructions", "modeloptions", "smspatterns"].includes(n);
const have = new Set(dst.getCollectionNames());
const row = (...c) => print(c[0].padEnd(34) + c.slice(1).map((x, i) => String(x).padStart(i === 4 ? 9 : 8)).join(""));
row("collection", "live", "new", "here", ...(apply ? ["added", "refused"] : []));
let sumNew = 0, sumAdded = 0, sumRefused = 0;
for (const name of src.getCollectionNames().sort()) {
  if (name.startsWith("system.")) continue;
  const total = src[name].estimatedDocumentCount();
  if (!total) continue;
  if (only.length && !only.includes(name)) continue;
  let why = "";
  if (skip.includes(name)) why = "skipped (SKIP)";
  else if (!only.includes(name) && never.includes(name)) why = "not merged";
  else if (!only.includes(name) && !have.has(name)) why = "not used here";
  else if (single(name) && dst[name].estimatedDocumentCount() > 0) why = "kept this site's";
  if (why) { print(name.padEnd(34) + String(total).padStart(8) + "   " + why); continue; }
  let fresh = 0, here = 0, added = 0, refused = 0, batch = [];
  const flush = () => {
    if (!batch.length) return;
    const exists = new Set(dst[name].find({ _id: { $in: batch.map((d) => d._id) } }, { _id: 1 }).toArray().map((d) => String(d._id)));
    const todo = batch.filter((d) => !exists.has(String(d._id)));
    here += batch.length - todo.length;
    fresh += todo.length;
    if (apply && todo.length) {
      try {
        added += Object.keys(dst[name].insertMany(todo, { ordered: false }).insertedIds).length;
      } catch (e) {
        const n = e.insertedCount ?? e.result?.insertedCount ?? 0;
        added += n;
        refused += todo.length - n;
      }
    }
    batch = [];
  };
  src[name].find().forEach((d) => { batch.push(d); if (batch.length === 500) flush(); });
  flush();
  sumNew += fresh; sumAdded += added; sumRefused += refused;
  row(name, total, fresh, here, ...(apply ? [added, refused] : []));
}
print("");
print(apply ? `added ${sumAdded} record(s), ${sumRefused} refused by a unique index (already here under another id)` : `${sumNew} record(s) would be added. Nothing was written; run again with APPLY=1 to add them.`);
JS
docker cp "$STATE/merge-live.js" "$CONTAINER:/tmp/merge-live.js"
docker exec -e M_COPY="$COPY_DB" -e M_DST="$DST_DB" -e M_APPLY="${APPLY:-}" -e M_ONLY="${ONLY:-}" -e M_SKIP="${SKIP:-}" "$CONTAINER" \
  mongosh --quiet -u noyanai -p "$PASSWORD" --authenticationDatabase admin --file /tmp/merge-live.js
docker exec "$CONTAINER" rm -f /tmp/merge-live.js

# the live site's uploads (avatars, blog images...): only files not here yet
OLD_PUBLIC="${OLD_PUBLIC:-$(dirname "${OLD_ENV:-/nonexistent/.env}")/Public}"
if [ -d "$OLD_PUBLIC" ]; then
  missing=$(cd "$OLD_PUBLIC" && find . -type f | while IFS= read -r f; do [ -e "$APP_DIR/back/Public/$f" ] || echo x; done | wc -l)
  if [ "${APPLY:-}" = 1 ]; then
    mkdir -p "$APP_DIR/back/Public"
    cp -an "$OLD_PUBLIC/." "$APP_DIR/back/Public/"
    echo "uploaded files: $missing copied from $OLD_PUBLIC (none here replaced)"
  else
    echo "uploaded files: $missing in $OLD_PUBLIC would be copied (none here replaced)"
  fi
fi

if [ "${APPLY:-}" = 1 ]; then
  pm2 restart noyanai-ts-back --update-env >/dev/null 2>&1 || true
  echo "Backend restarted. The copy $COPY_DB stays for a re-run (SKIP_DUMP=1)."
fi
