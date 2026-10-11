#!/bin/bash
# Installs or updates «Сад Будущего» on an Ubuntu computer (22.04 or newer). Run as root from
# the unpacked package — deploy/selfhost-deploy.ps1 does that from the owner's computer:
#
#   sudo bash selfhost/setup.sh
#
# What it sets up:
#   /opt/sad-budushego/app      the app (replaced as a whole on every update)
#   /var/lib/sad-budushego      the data: db/ (documents), files/ (photos, documents), backups/
#   /etc/sad-budushego/env      settings and secrets (made once; SERVICE_KEY may be passed in
#                               on stdin as SADB_SERVICE_KEY — the one the Vercel functions use)
#   sad-budushego.service       the server (node), restarted if it stops, started at boot
#   Caddy                       HTTPS for www.sad-budushego.ru and sad-budushego.ru (its own
#                               certificates, renewed by itself), passing everything to the server
#   sadb-admin                  import a backup, set passwords, take a snapshot (selfhost/admin.js)
#   a snapshot of the data every night at 00:30, kept 60 days
#   firewall: only SSH, 80 and 443 open

set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/sad-budushego/app
DATA=/var/lib/sad-budushego
ETC=/etc/sad-budushego
export DEBIAN_FRONTEND=noninteractive
say() { echo "== $*"; }

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)"; exit 1; }

# ---- software ----
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; }
if ! node_ok || ! command -v caddy >/dev/null; then
  say "installing Node.js and Caddy"
  apt-get update -qq
  node_ok || apt-get install -y -qq nodejs || true
  node_ok || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs; }
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq caddy || {
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq && apt-get install -y -qq caddy
    }
  fi
fi
node_ok || { echo "Node.js 18+ could not be installed"; exit 1; }
NODE="$(command -v node)"
say "node $("$NODE" -v), $(caddy version | head -1)"

# ---- user and folders ----
id sadb >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin sadb
mkdir -p "$DATA/db" "$DATA/files" "$DATA/backups" "$ETC" /opt/sad-budushego
chown -R sadb:sadb "$DATA"
chmod 750 "$DATA"

# ---- the app: the new version beside the old, then swapped ----
say "installing the app"
rm -rf "$APP.new"
mkdir -p "$APP.new/yandex/data-api" "$APP.new/yandex/backup"
cp -r "$SRC/service-manager.html" "$SRC/firebase-messaging-sw.js" "$SRC/vendor" "$SRC/novoe" "$SRC/selfhost" "$APP.new/"
cp "$SRC"/yandex/data-api/{api,core,accounts,auth,images}.js "$APP.new/yandex/data-api/"
cp "$SRC/yandex/backup/backup.js" "$APP.new/yandex/backup/"
chown -R root:root "$APP.new"; chmod -R a+rX "$APP.new"
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"; mv "$APP.new" "$APP"

# ---- settings (made once) ----
if [ ! -f "$ETC/env" ]; then
  say "creating settings"
  cat > "$ETC/env" <<EOF
PORT=8080
HOST=127.0.0.1
APP_DIR=$APP
DATA_DIR=$DATA
PUBLIC_ORIGIN=https://www.sad-budushego.ru
API_ORIGIN=https://api.sad-budushego.ru
AUTH_SECRET=$(openssl rand -hex 32)
SERVICE_KEY=$(openssl rand -hex 32)
EOF
fi
if [ -n "${SADB_SERVICE_KEY:-}" ]; then
  [ ${#SADB_SERVICE_KEY} -ge 32 ] || { echo "SADB_SERVICE_KEY too short"; exit 1; }
  grep -v '^SERVICE_KEY=' "$ETC/env" > "$ETC/env.new"; echo "SERVICE_KEY=$SADB_SERVICE_KEY" >> "$ETC/env.new"; mv "$ETC/env.new" "$ETC/env"
  say "service key set (the one the Vercel functions use)"
fi
chown root:sadb "$ETC/env"; chmod 640 "$ETC/env"

# ---- the server ----
cat > /etc/systemd/system/sad-budushego.service <<EOF
[Unit]
Description=Sad Budushego (service-manager)
After=network-online.target
Wants=network-online.target

[Service]
User=sadb
Group=sadb
EnvironmentFile=$ETC/env
ExecStart=$NODE $APP/selfhost/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF

# ---- HTTPS ----
cat > /etc/caddy/Caddyfile <<'EOF'
www.sad-budushego.ru, sad-budushego.ru {
	encode zstd gzip
	request_body {
		max_size 300MB
	}
	reverse_proxy 127.0.0.1:8080 {
		transport http {
			read_timeout 170s
			write_timeout 170s
		}
	}
}
EOF

# ---- the admin command ----
cat > /usr/local/bin/sadb-admin <<EOF
#!/bin/bash
# sadb-admin import|init-credentials|set-password|accounts|snapshot — see $APP/selfhost/admin.js
set -e
set -a; . $ETC/env; set +a
case "\${1:-}" in
  import|init-credentials|set-password)
    # The server keeps the data in memory: stopped while it changes, started again after.
    systemctl stop sad-budushego
    trap 'systemctl start sad-budushego' EXIT
    runuser -u sadb -- env APP_DIR="\$APP_DIR" DATA_DIR="\$DATA_DIR" PUBLIC_ORIGIN="\$PUBLIC_ORIGIN" AUTH_SECRET="\$AUTH_SECRET" $NODE $APP/selfhost/admin.js "\$@" ;;
  *)
    exec runuser -u sadb -- env APP_DIR="\$APP_DIR" DATA_DIR="\$DATA_DIR" PUBLIC_ORIGIN="\$PUBLIC_ORIGIN" AUTH_SECRET="\$AUTH_SECRET" $NODE $APP/selfhost/admin.js "\$@" ;;
esac
EOF
chmod 750 /usr/local/bin/sadb-admin

# ---- nightly snapshot ----
cat > /etc/cron.d/sad-budushego <<'EOF'
30 0 * * * root /usr/local/bin/sadb-admin snapshot >> /var/log/sad-budushego-backup.log 2>&1
EOF

# ---- firewall ----
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

systemctl daemon-reload
systemctl enable --now sad-budushego >/dev/null
systemctl restart sad-budushego
systemctl enable caddy >/dev/null; systemctl restart caddy
sleep 2
say "server: $(systemctl is-active sad-budushego), https: $(systemctl is-active caddy), health: $(curl -s -m 5 http://127.0.0.1:8080/healthz || echo none)"
rm -rf "$APP.old"
