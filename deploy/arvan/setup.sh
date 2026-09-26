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

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run as root (sudo -i)."
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
apt-get update -q
apt-get install -yq git curl ca-certificates openssl nginx build-essential \
  python3 python3-pip ffmpeg docker.io ufw certbot python3-certbot-nginx

# Next.js build needs ~2-3 GB; small servers get swap.
if [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 3800 ] && ! swapon --show | grep -q .; then
  log "Adding 4G swap"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- docker
log "Docker (Arvan registry mirror)"
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{ "registry-mirrors": ["https://docker.arvancloud.ir"] }' > /etc/docker/daemon.json
fi
systemctl enable --now docker
systemctl restart docker
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
if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  log "Node.js $NODE_MAJOR"
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
node -v

# npm registry: first one that answers.
registry=
for r in https://registry.npmjs.org https://mirror-npm.runflare.com \
         https://package-mirror.liara.ir/repository/npm https://registry.npmmirror.com; do
  if curl -fsS --max-time 10 "$r/pm2" -o /dev/null 2>/dev/null; then registry=$r; break; fi
done
[ -n "$registry" ] || die "No npm registry reachable."
log "npm registry: $registry"
npm config set registry "$registry/"
command -v pm2 >/dev/null || npm install -g pm2

# mediasoup builds its worker with pip/meson when GitHub's prebuilt binary
# can't be fetched; point pip at a reachable index.
if ! curl -fsS --max-time 10 https://pypi.org/simple/pip/ -o /dev/null 2>/dev/null; then
  for r in https://mirror-pypi.runflare.com/simple https://package-mirror.liara.ir/repository/pypi/simple; do
    if curl -fsS --max-time 10 "$r/pip/" -o /dev/null 2>/dev/null; then
      export PIP_INDEX_URL=$r
      log "pip index: $r"
      break
    fi
  done
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
clone noyanaitest front

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
npm ci --no-audit --no-fund
npm run build
pm2 startOrRestart deploy/ecosystem.config.js --update-env

# ---------------------------------------------------------------- frontend
log "Frontend (next build takes a few minutes)"
cd "$APP_DIR/front"
if [ ! -s .env.local ]; then
  cp deploy/env.ts.noyanai.com .env.local
  sed -i \
    -e "s#^DOMAIN=.*#DOMAIN=$SCHEME://$DOMAIN#" \
    -e "s#^FILE_PATH=.*#FILE_PATH=$SCHEME://$DOMAIN/files#" \
    .env.local
fi
npm ci --no-audit --no-fund
NODE_OPTIONS=--max-old-space-size=3072 npm run build
pm2 startOrRestart deploy/ecosystem.config.js --update-env
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
cat <<EOF
Site:         $SCHEME://$DOMAIN
Super admin:  $SCHEME://$DOMAIN/notadmin   (log in with $([ -n "${SUPER_ADMIN_PHONES:-}" ] && echo "$SUPER_ADMIN_PHONES" || echo "SUPER_ADMIN_PHONES from back/.env"))
Status:       pm2 status   |   logs: pm2 logs noyanai-ts-back
Secrets:      $STATE (Mongo password, JWT secret)

Still to fill in $APP_DIR/back/.env (then: pm2 restart noyanai-ts-back):
  SMS_* (login OTP is sent by SMS), OTP_PATTERN, VAPID_* , ANTHROPIC_API_KEY
  (or TRANSLATION_OLLAMA_MODEL) for machine translation of content.
In the Arvan panel also open ports 80, 443 and 50000-50999 (UDP+TCP) in the
server's security group.
EOF
