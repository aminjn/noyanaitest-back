#!/usr/bin/env bash
# One-shot setup of the whole app (backend + frontend + MongoDB + nginx + SSL)
# on a fresh ArvanCloud server (Ubuntu 22.04 / 24.04), run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/aminjn/noyanaitest-back/master/deploy/arvan/setup.sh -o setup.sh
#   SUPER_ADMIN_PHONES=09121234567 bash setup.sh
#
# Optional env:
#   DOMAIN=ts.noyanai.com     site domain (its DNS A record must point here)
#   SSL=certbot|none          certbot: Let's Encrypt on this server (default)
#                             none: HTTPS is handled by Arvan CDN in front of
#                             the server; the server itself only serves :80
#   BRANCH=master             git branch of both repos
#   FULL=1                    redo everything (apt, npm ci, builds) even when
#                             nothing changed
#   ONLY=back                 urgent server-side fix: update and restart the
#                             backend only (about a minute), leave the site
#   LOCAL_BUILD=1             build the frontend on this server even when
#                             GitHub has a prebuilt one (WAIT_CI=min: how
#                             long to wait for it, default 15)
#   CHECKS=1                  run the TypeScript/ESLint checks inside next
#                             build (they already run before every merge)
#
# Safe to run again: it keeps existing .env files, database and passwords,
# pulls the latest code, rebuilds and restarts. Everything that is blocked or
# slow from Iran (Docker Hub, mongodb.org, sometimes nodejs.org / npm) goes
# through a mirror.
set -euo pipefail

DOMAIN="${DOMAIN:-ts.noyanai.com}"
SSL="${SSL:-certbot}"
BRANCH="${BRANCH:-master}"
APP_DIR=/var/www/noyanai-ts
NODE_MAJOR=22   # mediasoup needs >= 22
STATE=/root/.noyanai-ts   # generated secrets live here (root only)

# every step's duration is kept and printed (and saved to
# /root/noyanai-deploy.log) at the end, so a slow deploy shows its slow step
STEP_NAME= STEP_AT=0 STEP_TIMES=
log() {
  if [ -n "$STEP_NAME" ]; then STEP_TIMES+="$(printf '%4dm%02ds  %s' $(((SECONDS - STEP_AT) / 60)) $(((SECONDS - STEP_AT) % 60)) "$STEP_NAME")"$'\n'; fi
  STEP_NAME="$*" STEP_AT=$SECONDS
  printf '\n\033[1;32m==> %s\033[0m  \033[2m(%dm%02ds)\033[0m\n' "$*" $((SECONDS / 60)) $((SECONDS % 60))
}
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run as root (sudo -i)."

# Keep this file (usually /root/setup.sh) up to date: when the repo holds a
# newer version, replace this copy with it and run that one instead.
if [ -z "${SETUP_UPDATED:-}" ] && [ -d "$APP_DIR/back/.git" ] && [ -f "$0" ]; then
  if git -C "$APP_DIR/back" fetch -q origin "$BRANCH" 2>/dev/null &&
     git -C "$APP_DIR/back" show "origin/$BRANCH:deploy/arvan/setup.sh" > /tmp/noyanai-setup.sh 2>/dev/null &&
     [ -s /tmp/noyanai-setup.sh ] && ! cmp -s /tmp/noyanai-setup.sh "$0"; then
    cp /tmp/noyanai-setup.sh "$0"
    log "setup.sh updated from the repo, running the new version"
    SETUP_UPDATED=1 exec bash "$0" "$@"
  fi
fi
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Only Ubuntu is supported (found ${ID:-unknown})."

mkdir -p "$STATE" && chmod 700 "$STATE"
secret() { # secret <name>: generated once, reused on later runs
  [ -s "$STATE/$1" ] || openssl rand -hex 32 > "$STATE/$1"
  cat "$STATE/$1"
}

if [ ! -s "$APP_DIR/back/.env" ] && [ -z "${SUPER_ADMIN_PHONES:-}" ]; then
  die "Set SUPER_ADMIN_PHONES (e.g. SUPER_ADMIN_PHONES=09121234567 bash setup.sh)."
fi

# ---------------------------------------------------------------- packages
log "APT packages (Arvan mirror)"
if ! grep -rqs "mirror.arvancloud.ir" /etc/apt/sources.list /etc/apt/sources.list.d/; then
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    [ -f "$f" ] && sed -i -E 's#https?://([a-z]{2}\.)?(archive|security)\.ubuntu\.com/ubuntu/?#http://mirror.arvancloud.ir/ubuntu/#g' "$f"
  done
fi
export DEBIAN_FRONTEND=noninteractive
APT_PKGS="git curl ca-certificates openssl nginx build-essential python3 python3-pip ffmpeg docker.io ufw certbot python3-certbot-nginx"
# Re-runs skip apt when every package is already installed.
if [ -n "${FULL:-}" ] || ! dpkg -s $APT_PKGS >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -yq $APT_PKGS
else
  echo "already installed (FULL=1 to refresh)"
fi

# Next.js build needs ~2-3 GB; small servers get swap.
if [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 3800 ] && ! swapon --show | grep -q .; then
  log "Adding 4G swap"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- docker
log "Docker (Arvan registry mirror)"
mkdir -p /etc/docker
docker_config_changed=
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{ "registry-mirrors": ["https://docker.arvancloud.ir"] }' > /etc/docker/daemon.json
  docker_config_changed=1
fi
systemctl enable --now docker
# Restarting Docker also restarts MongoDB, so only do it when its config changed.
[ -n "$docker_config_changed" ] && systemctl restart docker
pull() { # pull <image:tag> -> prints the local name that worked
  local ref
  for ref in "docker.arvancloud.ir/$1" "$1"; do
    docker pull -q "$ref" >/dev/null 2>&1 && { echo "$ref"; return 0; }
  done
  return 1
}

# ---------------------------------------------------------------- node
# nodejs.org / npmjs are often unreachable from Iranian servers. Order:
# nodejs.org, npmmirror, then copy node out of the official Docker image
# (pulled through the Arvan registry mirror).
# A broken npm (e.g. left half-overwritten by an older install) also
# triggers a clean reinstall.
# Only a Node this script installed cleanly (marker file) is trusted; `npm -v`
# still works with a half-mixed npm, while `npm ci` does not.
NODE_MARKER=/usr/local/.noyanai-node-$NODE_MAJOR
if [ ! -f "$NODE_MARKER" ] || ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\." || ! npm -v >/dev/null 2>&1; then
  # Remove any previous Node first: extracting over an older npm mixes
  # files of two versions ("Class extends value undefined").
  rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/include/node
  log "Node.js $NODE_MAJOR"
  node_reinstalled=1
  installed=
  for base in https://nodejs.org/dist https://npmmirror.com/mirrors/node; do
    version=$(curl -fsS --max-time 10 "$base/latest-v$NODE_MAJOR.x/SHASUMS256.txt" 2>/dev/null \
      | grep -o "node-v[0-9.]*-linux-x64.tar.xz" | head -1) || continue
    [ -n "$version" ] || continue
    if curl -fsSL --max-time 300 "$base/latest-v$NODE_MAJOR.x/$version" -o /tmp/node.tar.xz; then
      tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && installed=1
      rm -f /tmp/node.tar.xz
      break
    fi
  done
  if [ -z "$installed" ]; then
    image=$(pull "node:$NODE_MAJOR-bookworm-slim") || die "Could not get Node.js (nodejs.org, npmmirror and the Docker mirror all failed)."
    cid=$(docker create "$image")
    docker cp "$cid:/usr/local/bin/node" /usr/local/bin/node
    rm -rf /usr/local/lib/node_modules/npm
    mkdir -p /usr/local/lib/node_modules
    docker cp "$cid:/usr/local/lib/node_modules/npm" /usr/local/lib/node_modules/npm
    docker rm "$cid" >/dev/null
    ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
    ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
  fi
fi
touch "$NODE_MARKER"
node -v

# npm registry: the one that worked last time if it still answers, else the
# first one that answers.
registry=
last_registry="$(cat "$STATE/npm_registry" 2>/dev/null || true)"
for r in $last_registry https://registry.npmjs.org https://mirror-npm.runflare.com \
         https://package-mirror.liara.ir/repository/npm https://registry.npmmirror.com; do
  if curl -fsS --max-time 8 "$r/pm2" -o /dev/null 2>/dev/null; then registry=$r; break; fi
done
[ -n "$registry" ] || die "No npm registry reachable."
echo "$registry" > "$STATE/npm_registry"
log "npm registry: $registry"
npm config set registry "$registry/"
command -v pm2 >/dev/null || npm install -g pm2
# A pm2 daemon started by the previous Node binary must move to the new one.
[ -n "${node_reinstalled:-}" ] && { pm2 update >/dev/null 2>&1 || true; }

# mediasoup builds its worker with pip/meson when GitHub's prebuilt binary
# can't be fetched; point pip at a reachable index. Only needed when the
# backend's packages are reinstalled, so it runs lazily from deps().
pip_index() {
[ -n "${PIP_INDEX_URL:-}" ] && return 0
if ! curl -fsS --max-time 10 https://pypi.org/simple/pip/ -o /dev/null 2>/dev/null; then
  for r in https://mirror-pypi.runflare.com/simple https://package-mirror.liara.ir/repository/pypi/simple; do
    if curl -fsS --max-time 10 "$r/pip/" -o /dev/null 2>/dev/null; then
      export PIP_INDEX_URL=$r
      log "pip index: $r"
      break
    fi
  done
fi
}

# deps: npm ci only when package-lock.json (or the Node version) changed
# since the last successful install in this directory. Keeping node_modules
# also keeps mediasoup's compiled worker, which takes minutes to rebuild.
deps() {
  local stamp=node_modules/.noyanai-lock hash
  hash=$( { sha256sum package-lock.json; node -v; } | sha256sum | cut -c1-64)
  if [ -z "${FULL:-}" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$hash" ]; then
    echo "packages unchanged, skipping npm ci"
    return 0
  fi
  pip_index
  npm ci --no-audit --no-fund
  echo "$hash" > "$stamp"
}

# ---------------------------------------------------------------- swap
# A safety net so a build never gets killed for memory: 4 GB of swap, made
# once, only when the server has none.
if [ -z "$(swapon --noheadings 2>/dev/null)" ] && [ ! -f /swapfile ]; then
  log "Swap (4 GB, one time)"
  fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10; grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

# ---------------------------------------------------------------- mongodb
log "MongoDB 7 (Docker)"
MONGO_PASSWORD="$(secret mongo_password)"
if ! docker ps -a --format '{{.Names}}' | grep -qx noyanai-mongo; then
  image=$(pull mongo:7) || die "Could not pull mongo:7 from the Docker mirror."
  docker run -d --name noyanai-mongo --restart unless-stopped \
    -p 127.0.0.1:27017:27017 \
    -v /var/lib/noyanai-mongo:/data/db \
    -e MONGO_INITDB_ROOT_USERNAME=noyanai \
    -e MONGO_INITDB_ROOT_PASSWORD="$MONGO_PASSWORD" \
    "$image"
fi
for _ in $(seq 30); do
  docker exec noyanai-mongo mongosh --quiet -u noyanai -p "$MONGO_PASSWORD" --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1 && break
  sleep 2
done

# pm2_up <name>: restart the app when it changed, or start it if it is not running.
pm2_up() {
  if [ -n "$2" ] || ! pm2 describe "$1" >/dev/null 2>&1; then
    pm2 startOrRestart deploy/ecosystem.config.js --update-env
  else
    echo "$1 unchanged and running, not restarted"
  fi
}

# ---------------------------------------------------------------- code
log "Code ($BRANCH)"
mkdir -p "$APP_DIR"
clone() { # clone <repo> <dir>
  if [ -d "$APP_DIR/$2/.git" ]; then
    git -C "$APP_DIR/$2" fetch -q origin "$BRANCH"
    git -C "$APP_DIR/$2" checkout -q -B "$BRANCH" "origin/$BRANCH"
  else
    git clone -q -b "$BRANCH" "https://github.com/aminjn/$1.git" "$APP_DIR/$2"
  fi
}
clone noyanaitest-back back

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
SCHEME=https   # visitors always use HTTPS (here or at Arvan CDN)

# ---------------------------------------------------------------- backend
log "Backend"
cd "$APP_DIR/back"
if [ ! -s .env ]; then
  cp deploy/env.ts.noyanai.com .env
  sed -i \
    -e "s#^JWT_SECRET=.*#JWT_SECRET=$(secret jwt_secret)#" \
    -e "s#^SUPER_ADMIN_PHONES=.*#SUPER_ADMIN_PHONES=$SUPER_ADMIN_PHONES#" \
    -e "s#^DB_USERNAME=.*#DB_USERNAME=noyanai#" \
    -e "s#^DB_PASSWORD=.*#DB_PASSWORD=$MONGO_PASSWORD#" \
    -e "s#^ANNOUNCED_ADDRESS=.*#ANNOUNCED_ADDRESS=$PUBLIC_IP#" \
    .env
fi
back_commit=$(git rev-parse HEAD)
back_changed=
if [ -z "${FULL:-}" ] && [ -f compile/server.js ] && [ "$(cat "$STATE/back_built" 2>/dev/null)" = "$back_commit" ]; then
  echo "backend unchanged ($back_commit), skipping build"
else
  deps
  npm run build
  echo "$back_commit" > "$STATE/back_built"
  back_changed=1
fi
pm2_up noyanai-ts-back "$back_changed"

# ---------------------------------------------------------------- frontend
# The new version is built in a second directory (front-next) while the old
# one keeps serving, then the two are swapped and the app restarts: the site
# stays up during the build. The previous version is kept as front-prev and
# reused (with its node_modules) for the next build.
log "Frontend"
FRONT="$APP_DIR/front"
NEXT_DIR="$APP_DIR/front-next"
if [ ! -d "$NEXT_DIR/.git" ]; then
  rm -rf "$NEXT_DIR"
  if [ -d "$APP_DIR/front-prev/.git" ]; then
    mv "$APP_DIR/front-prev" "$NEXT_DIR"
  elif [ -d "$FRONT/.git" ]; then
    cp -a "$FRONT" "$NEXT_DIR"   # first run after this change: start from the live copy
  else
    git clone -q -b "$BRANCH" "https://github.com/aminjn/noyanaitest.git" "$NEXT_DIR"
  fi
fi
git -C "$NEXT_DIR" fetch -q origin "$BRANCH"
git -C "$NEXT_DIR" checkout -q -f -B "$BRANCH" "origin/$BRANCH"
front_commit=$(git -C "$NEXT_DIR" rev-parse HEAD)
front_changed=

if [ "${ONLY:-}" = back ] && [ -d "$FRONT/.next" ]; then
  echo "ONLY=back: frontend left as it is"
elif [ -z "${FULL:-}" ] && [ -d "$FRONT/.next" ] && [ "$(cat "$STATE/front_built" 2>/dev/null)" = "$front_commit" ]; then
  echo "frontend unchanged ($front_commit), skipping build"
else
  cd "$NEXT_DIR"
  if [ -s "$FRONT/.env.local" ]; then
    cp "$FRONT/.env.local" .env.local
  elif [ ! -s .env.local ]; then
    cp deploy/env.ts.noyanai.com .env.local
    sed -i \
      -e "s#^DOMAIN=.*#DOMAIN=$SCHEME://$DOMAIN#" \
      -e "s#^FILE_PATH=.*#FILE_PATH=$SCHEME://$DOMAIN/files#" \
      .env.local
  fi
  deps
  # The build itself normally runs on GitHub (the frontend repo's
  # .github/workflows/build.yml publishes build-<commit>/front-next.tar.gz):
  # download it instead of building on this server. Used only when it was
  # built from this exact commit and with this server's .env.local; while
  # CI is still running it waits (WAIT_CI minutes, default 15), and without
  # it this server builds itself as before. LOCAL_BUILD=1 forces that.
  prebuilt=
  if [ -z "${LOCAL_BUILD:-}" ] && [ -z "${CHECKS:-}" ]; then
    env_hash=$(grep -v '^[[:space:]]*#' .env.local | grep '=' | sort | sha256sum | cut -c1-64)
    asset="https://github.com/aminjn/noyanaitest/releases/download/build-${front_commit:0:12}/front-next.tar.gz"
    log "Frontend: prebuilt from GitHub (build-${front_commit:0:12})"
    waited=0 limit=$(( ${WAIT_CI:-15} * 60 ))
    while :; do
      if curl -fsSL --max-time 300 -o /tmp/front-next.tar.gz "$asset" 2>/dev/null; then
        rm -rf .next.dl && mkdir .next.dl && tar -xzf /tmp/front-next.tar.gz -C .next.dl && rm -f /tmp/front-next.tar.gz
        if [ "$(cat .next.dl/.next/ENV_HASH 2>/dev/null)" = "$env_hash" ] && [ "$(cat .next.dl/.next/BUILD_COMMIT 2>/dev/null)" = "$front_commit" ]; then
          rm -rf .next && mv .next.dl/.next .next && rm -rf .next.dl && prebuilt=1
          echo "prebuilt build installed"
        else
          echo "prebuilt build was made with other settings (.env.local differs); building here instead"
          rm -rf .next.dl
        fi
        break
      fi
      [ "$waited" -ge "$limit" ] && { echo "no prebuilt build after ${WAIT_CI:-15} min; building here"; break; }
      [ "$waited" -eq 0 ] && echo "waiting for the GitHub build to finish..."
      sleep 20; waited=$(( waited + 20 ))
    done
  fi
  if [ -z "$prebuilt" ]; then
  # Reuse the live build's webpack cache so only what changed is recompiled.
  # It is MOVED, not copied: it grows by every build (several GB), and
  # copying it was most of a deploy's time and disk. The live site does not
  # read it (only .next/cache/images, which stays where it is). Over 3 GB it
  # is dropped once - one slower build, then small again.
  rm -rf .next/cache && mkdir -p .next/cache
  if [ -d "$FRONT/.next/cache/webpack" ]; then
    cache_mb=$(du -sm "$FRONT/.next/cache/webpack" | cut -f1)
    if [ "$cache_mb" -gt 3072 ]; then
      echo "webpack cache ${cache_mb} MB, starting a fresh one"
      rm -rf "$FRONT/.next/cache/webpack"
    else
      mv "$FRONT/.next/cache/webpack" .next/cache/webpack
    fi
  fi
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  # The live site, MongoDB and the backend share this RAM with the build:
  # on 8 GB or less the build gets less heap and 2 workers so it never
  # swaps (swapping is what made a deploy take half an hour).
  if [ "$mem_mb" -le 9000 ]; then
    heap=$(( mem_mb * 40 / 100 )); build_cpus=2
  else
    heap=$(( mem_mb * 60 / 100 )); build_cpus=$(( $(nproc) - 1 ))
  fi
  [ "$heap" -lt 2560 ] && heap=2560; [ "$heap" -gt 8192 ] && heap=8192
  log "Frontend build on this server (heap ${heap} MB, ${build_cpus} workers$([ -n "${CHECKS:-}" ] && echo ", with type/lint checks"))"
  SKIP_BUILD_CHECKS=$([ -n "${CHECKS:-}" ] && echo 0 || echo 1) \
    NEXT_BUILD_CPUS=$build_cpus NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=$heap npm run build
  fi
  mkdir -p .next/cache
  # keep the optimised-image cache the live site built up
  [ -d "$FRONT/.next/cache/images" ] && mv "$FRONT/.next/cache/images" .next/cache/images
  cd "$APP_DIR"
  rm -rf "$APP_DIR/front-prev"
  [ -d "$FRONT" ] && mv "$FRONT" "$APP_DIR/front-prev"
  # the old copy is kept only for its node_modules: no second build cache
  rm -rf "$APP_DIR/front-prev/.next/cache"
  mv "$NEXT_DIR" "$FRONT"
  echo "$front_commit" > "$STATE/front_built"
  front_changed=1
fi
cd "$FRONT"
pm2_up noyanai-ts-front "$front_changed"
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null

# ---------------------------------------------------------------- nginx
log "nginx"
conf=/etc/nginx/sites-available/$DOMAIN.conf
sed "s/ts\.noyanai\.com/$DOMAIN/g" "$APP_DIR/back/deploy/nginx/ts.noyanai.com.conf" > "$conf"
ln -sf "$conf" /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/html

http_only() { # serve the app on :80 only until a certificate exists
  sed -i -e '/listen 443/d' -e '/ssl_certificate/d' "$conf"
}

if [ "$SSL" = certbot ] && [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  http_only
  nginx -t && systemctl reload nginx
  log "SSL certificate for $DOMAIN"
  if certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos \
       --register-unsafely-without-email; then
    sed "s/ts\.noyanai\.com/$DOMAIN/g" "$APP_DIR/back/deploy/nginx/ts.noyanai.com.conf" > "$conf"
  else
    echo "!! certbot failed (DNS not pointing here yet?). Site stays on HTTP; run this script again later."
  fi
elif [ "$SSL" = none ]; then
  http_only
fi
nginx -t && systemctl reload nginx

# ---------------------------------------------------------------- firewall
log "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80,443/tcp >/dev/null
ufw allow 50000:50999/udp >/dev/null
ufw allow 50000:50999/tcp >/dev/null
ufw --force enable >/dev/null

log "Done"
{
  echo "deploy $(date '+%F %T') - total $((SECONDS / 60))m$((SECONDS % 60))s - $(nproc) CPU, $(awk '/MemTotal/ {print int($2/1048576)}' /proc/meminfo) GB RAM"
  printf '%s' "$STEP_TIMES"
} | tee -a /root/noyanai-deploy.log
cat <<EOF
Site:         $SCHEME://$DOMAIN
Super admin:  $SCHEME://$DOMAIN/notadmin   (log in with $([ -n "${SUPER_ADMIN_PHONES:-}" ] && echo "$SUPER_ADMIN_PHONES" || echo "SUPER_ADMIN_PHONES from back/.env"))
Status:       pm2 status   |   logs: pm2 logs noyanai-ts-back
Secrets:      $STATE (Mongo password, JWT secret)

Still to fill in $APP_DIR/back/.env (then: pm2 restart noyanai-ts-back):
  SMS_* (login OTP is sent by SMS), OTP_PATTERN, VAPID_* , ANTHROPIC_API_KEY
  (or TRANSLATION_OLLAMA_MODEL) for machine translation of content,
  CLINICAL_OLLAMA_MODEL (pre-visit summary + visit note drafts) and STT_URL
  (speech-to-text for the scribe; any OpenAI-compatible whisper server).
In the Arvan panel also open ports 80, 443 and 50000-50999 (UDP+TCP) in the
server's security group.

Data of the old site (noyanai.com): with a read-only Mongo user on the live
server, one command copies and imports it (safe to run again):
  OLD_MONGO_URI='mongodb://reader:PASS@LIVE_IP:27017/?authSource=admin' \
  OLD_FILES_BASE_URL='https://noyanai.com/files' \
  bash $APP_DIR/back/deploy/arvan/import-old.sh
EOF
