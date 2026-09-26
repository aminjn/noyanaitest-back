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
NODE_VERSION=20.18.1
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

# ---------------------------------------------------------------- node
if ! node -v 2>/dev/null | grep -q "^v20\."; then
  log "Node.js $NODE_VERSION"
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  for base in https://nodejs.org/dist https://npmmirror.com/mirrors/node; do
    curl -fsSL --retry 2 "$base/v$NODE_VERSION/$tarball" -o /tmp/$tarball && break
  done
  [ -s /tmp/$tarball ] || die "Could not download Node.js."
  tar -xJf /tmp/$tarball -C /usr/local --strip-components=1
  rm -f /tmp/$tarball
fi
if ! timeout 20 npm ping >/dev/null 2>&1; then
  log "registry.npmjs.org unreachable - using npmmirror"
  npm config set registry https://registry.npmmirror.com
fi
command -v pm2 >/dev/null || npm install -g pm2

# ---------------------------------------------------------------- mongodb
log "MongoDB (Docker, Arvan registry mirror)"
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{ "registry-mirrors": ["https://docker.arvancloud.ir"] }' > /etc/docker/daemon.json
fi
systemctl enable --now docker
systemctl restart docker
MONGO_PASSWORD="$(secret mongo_password)"
if ! docker ps -a --format '{{.Names}}' | grep -qx noyanai-mongo; then
  docker pull docker.arvancloud.ir/mongo:7 || docker pull mongo:7
  image=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -m1 'mongo:7')
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

http_only() { # serve the app on :80 until a certificate exists
  python3 - "$conf" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
redirect, app = s.split("server {", 2)[1:]
app = "server {" + app
app = re.sub(r"listen 443 ssl http2;", "listen 80;", app)
app = re.sub(r"\n\s*ssl_certificate[^\n]*", "", app)
app = app.replace("location / {", "location /.well-known/acme-challenge/ { root /var/www/html; }\n\n    location / {", 1)
head = s.split("server {", 1)[0]
open(p, "w").write(head + app)
PY
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
