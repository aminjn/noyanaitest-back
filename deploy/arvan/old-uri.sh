# Sourced by import-old.sh and merge-live.sh: OLD_MONGO_URI from OLD_ENV.
# OLD_ENV=<the old backend's .env>: the URI is built from its DB_* lines, so
# no password is typed or shown (the old site on this same server)
if [ -z "${OLD_MONGO_URI:-}" ] && [ -n "${OLD_ENV:-}" ]; then
  [ -r "$OLD_ENV" ] || die "cannot read $OLD_ENV"
  envval() { { grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$OLD_ENV" || true; } | tail -1 | cut -d= -f2- | tr -d '\r' | sed -E "s/^[[:space:]]+//; s/[[:space:]]+\$//; s/^[\"']//; s/[\"']\$//"; }
  enc() { V="$1" python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["V"], safe=""))'; }
  u="$(envval DB_USERNAME)"; p="$(envval DB_PASSWORD)"
  h="$(envval DB_HOST)"; h="${h:-127.0.0.1}"
  port="$(envval DB_PORT)"; port="${port:-27017}"
  # the old app authenticates against "admin" (OLD_AUTH_DB to change it)
  if [ -n "$u" ] && [ -n "$p" ]; then OLD_MONGO_URI="mongodb://$(enc "$u"):$(enc "$p")@$h:$port/?authSource=${OLD_AUTH_DB:-admin}"
  else OLD_MONGO_URI="mongodb://$h:$port/"; fi
  unset u p
  # the old app's own dotenv, when it is there: the values exactly as the old
  # site reads them (inline comments, escapes, a %-escaped password)
  old_dir="$(dirname "$OLD_ENV")"
  if command -v node >/dev/null && [ -d "$old_dir/node_modules/dotenv" ]; then
    uri="$(cd "$old_dir" && OLD_ENV="$OLD_ENV" OLD_AUTH_DB="${OLD_AUTH_DB:-admin}" node -e '
      const e = require("dotenv").parse(require("fs").readFileSync(process.env.OLD_ENV));
      // the driver decodes the user info; mongodump needs it encoded
      const enc = (v) => { try { return encodeURIComponent(decodeURIComponent(v)); } catch { return encodeURIComponent(v); } };
      const host = e.DB_HOST || "127.0.0.1", port = Number(e.DB_PORT) || 27017;
      const auth = e.DB_USERNAME && e.DB_PASSWORD ? `${enc(e.DB_USERNAME)}:${enc(e.DB_PASSWORD)}@` : "";
      process.stdout.write(`mongodb://${auth}${host}:${port}/` + (auth ? `?authSource=${process.env.OLD_AUTH_DB}` : ""));
    ' 2>/dev/null)" && [ -n "$uri" ] && OLD_MONGO_URI="$uri"
    unset uri
  fi
fi
