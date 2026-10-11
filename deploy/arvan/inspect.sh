#!/usr/bin/env bash
# Read-only snapshot of a server before moving the new app onto it
# (2026-10, the noyanai.com migration). It changes nothing and prints no
# secrets: no .env values, passwords, keys or database contents - only what
# runs, on which ports and where the data lives, so the move can be planned.
#
#   curl -fsSL https://raw.githubusercontent.com/aminjn/noyanaitest-back/master/deploy/arvan/inspect.sh -o inspect.sh
#   bash inspect.sh > inspect.txt 2>&1; cat inspect.txt
set -u

sec() { printf '\n===== %s =====\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

sec "system"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
uname -r
nproc 2>/dev/null | sed 's/^/cpus: /'
free -h 2>/dev/null | sed -n '1,2p'
df -h / /var /var/lib 2>/dev/null | awk 'NR==1 || !seen[$0]++'
uptime

sec "public IP / hostname"
hostname
curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "(no outbound check)"
echo

sec "listening ports (process names only)"
if have ss; then ss -tlnpH 2>/dev/null | awk '{print $4, $6}' | sed 's/users:((\("[^"]*"\).*/\1/' | sort -u; fi

sec "web server"
for s in nginx apache2 httpd caddy; do systemctl is-active --quiet "$s" 2>/dev/null && echo "$s: active"; done
if [ -d /etc/nginx ]; then
  echo "-- nginx sites (server_name / root / proxy_pass):"
  grep -RhoE '^\s*(server_name|root|proxy_pass|listen)\s+[^;]+' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sed 's/^\s*//' | sort -u
fi
ls /etc/letsencrypt/live 2>/dev/null | sed 's/^/cert: /'

sec "node / pm2"
have node && node -v
if have pm2; then pm2 jlist 2>/dev/null | python3 -c '
import json,sys
try: apps=json.load(sys.stdin)
except Exception: apps=[]
for a in apps:
  e=a.get("pm2_env",{})
  print(a.get("name"), e.get("status"), "cwd="+str(e.get("pm_cwd")), "script="+str(e.get("pm_exec_path")))
' 2>/dev/null || pm2 ls; fi

sec "docker"
if have docker; then docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null; else echo "no docker"; fi

sec "databases"
for s in mongod mongodb mysql mariadb postgresql redis-server redis; do systemctl is-active --quiet "$s" 2>/dev/null && echo "$s: active"; done
for d in /var/lib/mongodb /var/lib/noyanai-mongo /var/lib/mysql /var/lib/postgresql; do
  [ -d "$d" ] && du -sh "$d" 2>/dev/null
done
have mongosh && echo "mongosh present"
have mongo && echo "mongo shell present"
have mongodump && echo "mongodump present"

sec "app folders"
for d in /var/www /home/*/ /root /opt /srv; do
  [ -d "$d" ] || continue
  find "$d" -maxdepth 3 \( -name package.json -o -name .git \) -not -path '*/node_modules/*' 2>/dev/null | sed 's#/package.json$##; s#/.git$##' | sort -u | while read -r p; do
    br="$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null)"; url="$(git -C "$p" config --get remote.origin.url 2>/dev/null | sed -E 's#://[^@]*@#://#')"
    echo "$p ${br:+branch=$br} ${url:+remote=$url}"
  done
done | sort -u
for p in /var/www/*/Public /var/www/*/*/Public /var/www/*/files; do [ -d "$p" ] && du -sh "$p" 2>/dev/null; done

sec "env files present (names only, no values)"
find /var/www /root /opt /srv /home -maxdepth 4 -name '.env*' -not -path '*/node_modules/*' 2>/dev/null | while read -r f; do
  printf '%s: ' "$f"; grep -oE '^[A-Z0-9_]+=' "$f" 2>/dev/null | tr -d '=' | tr '\n' ' '; echo
done

sec "firewall"
have ufw && ufw status 2>/dev/null | head -20

sec "cron"
crontab -l 2>/dev/null | grep -v '^#' | sed -E 's#://[^@ ]*@#://<hidden>@#g; s/=[^ ]+/=<hidden>/g; s/(-p|--password)[ =][^ ]+/\1 <hidden>/g'

sec "done"
echo "Nothing was changed. Send this output back."
