#!/usr/bin/env bash
# WappFlow installer / updater for an Ubuntu server that already runs Nginx.
#
#   www.<DOMAIN>    → public website       (static files)
#   admin.<DOMAIN>  → dashboard + admin     (static files, /api and /socket.io proxied to the API)
#   back.<DOMAIN>   → API, Meta webhooks, public REST API
# DOMAIN defaults to wappflow.online. The website in web/ is built for that domain.
#
# First run installs everything. Running it again with a newer package updates the code and keeps
# your .env, database and admin login. It never edits or removes other Nginx sites; if a domain or
# the port is already used by something else it stops and tells you.
#
# Usage:   sudo bash install.sh
# Options (environment variables):
#   ADMIN_EMAIL=you@x.com     super-admin login (default eslam@teknulugy.com)
#   PORT=4100                 internal port for the API (default 4100)
#   MYSQL_ROOT_PASSWORD=...   only if MySQL/MariaDB root needs a password
#   INCLUDE_APEX=1            also serve the bare domain (without www) as the website
#   SKIP_SSL=1                skip Let's Encrypt (e.g. DNS not ready yet)
set -euo pipefail

DOMAIN="${DOMAIN:-wappflow.online}"
WEB_DOMAIN="www.$DOMAIN"
APEX_DOMAIN="$DOMAIN"
ADMIN_DOMAIN="admin.$DOMAIN"
API_DOMAIN="back.$DOMAIN"
APP_DIR="/var/www/wappflow"
PORT="${PORT:-4100}"
ADMIN_EMAIL="${ADMIN_EMAIL:-eslam@teknulugy.com}"
SRC="$(cd "$(dirname "$0")" && pwd)"
PM2_NAME="wappflow"

c_ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m→\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()    { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run as root: sudo bash install.sh"
command -v nginx >/dev/null || die "Nginx is not installed. This script expects an existing Nginx."
[ -d "$SRC/api" ] && [ -d "$SRC/admin" ] && [ -d "$SRC/web" ] || die "Run this from the extracted wappflow-deploy folder."

DOMAINS=("$WEB_DOMAIN" "$ADMIN_DOMAIN" "$API_DOMAIN")
[ "${INCLUDE_APEX:-0}" = 1 ] && DOMAINS+=("$APEX_DOMAIN")

# Where this Nginx keeps site configs
if [ -d /etc/nginx/sites-available ] && grep -q "sites-enabled" /etc/nginx/nginx.conf; then
  NGX_AVAIL=/etc/nginx/sites-available; NGX_ENABLED=/etc/nginx/sites-enabled
else
  NGX_AVAIL=/etc/nginx/conf.d; NGX_ENABLED=""
fi
ngx_file() { echo "$NGX_AVAIL/wappflow-$1.conf"; }


# ---------------------------------------------------------------- 1. safety checks
c_info "Checking that nothing else on this server already uses these domains"
for d in "${DOMAINS[@]}"; do
  hits=$(grep -rlE "server_name[^;]*[[:space:]]${d//./\\.}([[:space:];]|$)" /etc/nginx/ 2>/dev/null | grep -v '/wappflow-' || true)
  if [ -n "$hits" ]; then
    die "$d is already configured in: $hits
   Remove or rename that site first (or tell me and I'll adapt). Nothing was changed."
  fi
done
c_ok "Domains are free in Nginx"

if ss -ltnp 2>/dev/null | grep -q ":$PORT "; then
  if ! (command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | grep -q "\"name\":\"$PM2_NAME\""); then
    die "Port $PORT is already used by another program. Re-run with PORT=<free port>, e.g. PORT=4200 bash install.sh"
  fi
fi
c_ok "Port $PORT is available"

SERVER_IPS="$(hostname -I 2>/dev/null) $(curl -s --max-time 5 https://api.ipify.org || true)"
SSL_DOMAINS=()
for d in "${DOMAINS[@]}"; do
  ip=$(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1; exit}' || true)
  if [ -n "$ip" ] && echo "$SERVER_IPS" | grep -qw "$ip"; then SSL_DOMAINS+=("$d"); c_ok "$d points to this server ($ip)"
  else c_warn "$d does not point to this server yet (DNS: ${ip:-none}). It will work over http once DNS is set; re-run for SSL."; fi
done

# ---------------------------------------------------------------- 2. software
export DEBIAN_FRONTEND=noninteractive
need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 20 ] && need_node=0
fi
if [ $need_node = 1 ]; then
  c_info "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -q nodejs >/dev/null
fi
c_ok "Node $(node -v)"
command -v pm2 >/dev/null || { c_info "Installing PM2"; npm i -g pm2 >/dev/null 2>&1; }
c_ok "PM2 $(pm2 -v 2>/dev/null | tail -1)"
if ! command -v mysql >/dev/null; then
  c_info "Installing MariaDB"
  apt-get install -y -q mariadb-server >/dev/null
  systemctl enable --now mariadb >/dev/null 2>&1 || true
fi
c_ok "Database server: $(mysql --version | awk '{print $3,$4,$5}')"
if [ "${SKIP_SSL:-0}" != 1 ] && ! command -v certbot >/dev/null; then
  c_info "Installing Certbot"
  apt-get install -y -q certbot python3-certbot-nginx >/dev/null
fi

# ---------------------------------------------------------------- 3. files
mkdir -p "$APP_DIR"
ENV_FILE="$APP_DIR/api/.env"
FIRST_RUN=1; [ -f "$ENV_FILE" ] && FIRST_RUN=0
if [ $FIRST_RUN = 0 ]; then cp "$ENV_FILE" /tmp/wappflow.env.keep; fi
c_info "Copying files to $APP_DIR"
rm -rf "$APP_DIR/web.new" "$APP_DIR/admin.new" "$APP_DIR/api.new"
cp -a "$SRC/web" "$APP_DIR/web.new"; cp -a "$SRC/admin" "$APP_DIR/admin.new"; cp -a "$SRC/api" "$APP_DIR/api.new"
if [ -d "$APP_DIR/api/node_modules" ]; then mv "$APP_DIR/api/node_modules" "$APP_DIR/api.new/node_modules"; fi
for x in web admin api; do rm -rf "$APP_DIR/$x.old"; [ -d "$APP_DIR/$x" ] && mv "$APP_DIR/$x" "$APP_DIR/$x.old"; mv "$APP_DIR/$x.new" "$APP_DIR/$x"; done
[ $FIRST_RUN = 0 ] && mv /tmp/wappflow.env.keep "$ENV_FILE"
rm -rf "$APP_DIR"/*.old

c_info "Installing API dependencies"
(cd "$APP_DIR/api" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1) || (cd "$APP_DIR/api" && npm ci --omit=dev --no-audit --no-fund)
c_ok "Dependencies installed"

# ---------------------------------------------------------------- 4. database + .env (first run only)
LOGIN_FILE=/root/wappflow-admin-login.txt
if [ $FIRST_RUN = 1 ]; then
  c_info "Creating database and configuration"
  rnd() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-40}"; }
  DB_PASS=$(rnd 32)
  MYSQL=(mysql); [ -n "${MYSQL_ROOT_PASSWORD:-}" ] && MYSQL=(mysql -uroot "-p$MYSQL_ROOT_PASSWORD")
  "${MYSQL[@]}" -e "CREATE DATABASE IF NOT EXISTS wappflow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER IF NOT EXISTS 'wappflow'@'localhost' IDENTIFIED BY '$DB_PASS';
    ALTER USER 'wappflow'@'localhost' IDENTIFIED BY '$DB_PASS';
    GRANT ALL PRIVILEGES ON wappflow.* TO 'wappflow'@'localhost'; FLUSH PRIVILEGES;" \
    || die "Could not create the database. If MySQL root has a password, re-run with MYSQL_ROOT_PASSWORD=..."
  ADMIN_PASS=$(rnd 16)
  VERIFY=$(rnd 24)
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=$PORT
BRAND_NAME=WappFlow
APP_URL=https://$ADMIN_DOMAIN
API_URL=https://$API_DOMAIN
SITE_URL=https://$WEB_DOMAIN,https://$APEX_DOMAIN
JWT_SECRET=$(rnd 64)
# Encrypts stored WhatsApp tokens. Never change it after go-live.
APP_KEY=$(rnd 64)

DB_CLIENT=mysql2
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=wappflow
DB_PASSWORD=$DB_PASS
DB_NAME=wappflow

META_GRAPH_VERSION=v23.0
META_APP_ID=
# Set this to your Meta app secret so webhook signatures are verified
META_APP_SECRET=
META_VERIFY_TOKEN=$VERIFY
META_ES_CONFIG_ID=

TRIAL_DAYS=14
# days a workspace keeps working after its plan ends unpaid (0 = locked until paid)
GRACE_DAYS=0
# PayPal (developer.paypal.com → Apps & Credentials). Leave empty to hide PayPal.
PAYPAL_CLIENT_ID=
PAYPAL_SECRET=
PAYPAL_MODE=live
PAYPAL_CURRENCY=USD
# 1 KWD in PAYPAL_CURRENCY (PayPal cannot charge in KWD)
PAYPAL_FX_RATE=3.26
TAP_SECRET_KEY=
BANK_DETAILS=

ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASS
SEND_RATE_PER_SEC=20
ALLOW_SIGNUP=true
WORKER=true
EOF
  chmod 600 "$ENV_FILE"
  (cd "$APP_DIR/api" && npm run seed >/dev/null)
  # don't keep the admin password in .env after seeding
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=/" "$ENV_FILE"
  printf 'WappFlow super admin\nURL:      https://%s/login\nEmail:    %s\nPassword: %s\n' "$ADMIN_DOMAIN" "$ADMIN_EMAIL" "$ADMIN_PASS" > "$LOGIN_FILE"
  chmod 600 "$LOGIN_FILE"
  c_ok "Database 'wappflow' ready, plans and super admin created"
else
  sed -i "s#^APP_URL=.*#APP_URL=https://$ADMIN_DOMAIN#; s#^API_URL=.*#API_URL=https://$API_DOMAIN#; s#^SITE_URL=.*#SITE_URL=https://$WEB_DOMAIN,https://$APEX_DOMAIN#" "$ENV_FILE"
  if [ -f "$LOGIN_FILE" ]; then sed -i "s#^URL: .*#URL:      https://$ADMIN_DOMAIN/login#" "$LOGIN_FILE"; fi
  if ! grep -q '^PAYPAL_CLIENT_ID=' "$ENV_FILE"; then
    printf '\n# PayPal (developer.paypal.com → Apps & Credentials). Leave empty to hide PayPal.\nPAYPAL_CLIENT_ID=\nPAYPAL_SECRET=\nPAYPAL_MODE=live\nPAYPAL_CURRENCY=USD\n# 1 KWD in PAYPAL_CURRENCY (PayPal cannot charge in KWD)\nPAYPAL_FX_RATE=3.26\n' >> "$ENV_FILE"
    c_ok "Added PayPal settings to $ENV_FILE (empty until you fill them in)"
  fi
  # old installs had a 5-day grace period; plans now lock as soon as they end unpaid
  if grep -q '^GRACE_DAYS=5$' "$ENV_FILE"; then sed -i 's/^GRACE_DAYS=5$/GRACE_DAYS=0/' "$ENV_FILE"; c_ok "Expired plans now lock the workspace until paid (GRACE_DAYS=0)"; fi
  # the old placeholder bank text
  sed -i '/^BANK_DETAILS=.*edit BANK_DETAILS/d' "$ENV_FILE"
  c_ok "Keeping existing configuration ($ENV_FILE), addresses set to $DOMAIN"
fi
chown -R www-data:www-data "$APP_DIR/web" "$APP_DIR/admin" 2>/dev/null || true

# ---------------------------------------------------------------- 5. run the API with PM2
c_info "Starting the API"
cd "$APP_DIR/api"
if pm2 jlist 2>/dev/null | grep -q "\"name\":\"$PM2_NAME\""; then
  pm2 reload "$PM2_NAME" --update-env >/dev/null
else
  pm2 start deploy/ecosystem.config.cjs >/dev/null
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
fi
pm2 save >/dev/null
for i in $(seq 1 20); do curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
curl -fs "http://127.0.0.1:$PORT/health" >/dev/null || { pm2 logs "$PM2_NAME" --lines 40 --nostream; die "The API did not start (see logs above)."; }
c_ok "API running on 127.0.0.1:$PORT"

# ---------------------------------------------------------------- 6. Nginx sites
# Our own site files from an earlier install with a different domain are replaced (only wappflow-* files).
for f in "$NGX_AVAIL"/wappflow-*.conf; do
  [ -f "$f" ] || continue
  if ! grep -q "$ADMIN_DOMAIN\|$API_DOMAIN\|$WEB_DOMAIN" "$f"; then
    c_info "Removing old WappFlow site for another domain: $(basename "$f")"
    OLD_NAMES=$(grep -hoE 'server_name[^;]+' "$f" | sed 's/server_name//' | tr ' ' '\n' | grep -v '^$' | sort -u)
    rm -f "$f"; if [ -n "$NGX_ENABLED" ]; then rm -f "$NGX_ENABLED/$(basename "$f")"; fi
    # and its SSL certificates, so the old domain is fully gone
    for n in $OLD_NAMES; do
      if [ -d "/etc/letsencrypt/live/$n" ]; then certbot delete --non-interactive --cert-name "$n" >/dev/null 2>&1 && c_ok "Removed SSL certificate for $n" || true; fi
    done
  fi
done
c_info "Writing Nginx sites"
WEB_NAMES="$WEB_DOMAIN"; [ "${INCLUDE_APEX:-0}" = 1 ] && WEB_NAMES="$WEB_DOMAIN $APEX_DOMAIN"
write_site() { # name, content — keeps SSL lines certbot added earlier
  local f; f=$(ngx_file "$1")
  if [ -f "$f" ] && grep -q "managed by Certbot" "$f"; then c_ok "$(basename "$f") already has SSL; left as is"; return; fi
  printf '%s\n' "$2" > "$f"
  if [ -n "$NGX_ENABLED" ]; then ln -sf "$f" "$NGX_ENABLED/$(basename "$f")"; fi
  return 0
}
PROXY='proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;'

write_site web "server {
    listen 80;
    server_name $WEB_NAMES;
    root $APP_DIR/web;
    index index.html;
    location /assets/ { expires 30d; add_header Cache-Control \"public, immutable\"; }
    location / { try_files \$uri \$uri/ /index.html; }
}"

write_site admin "server {
    listen 80;
    server_name $ADMIN_DOMAIN;
    root $APP_DIR/admin;
    index index.html;
    client_max_body_size 12m;
    location /api/       { proxy_pass http://127.0.0.1:$PORT; $PROXY }
    location /socket.io/ { proxy_pass http://127.0.0.1:$PORT; $PROXY }
    location /assets/ { expires 30d; add_header Cache-Control \"public, immutable\"; }
    location / { try_files \$uri \$uri/ /index.html; }
}"

write_site api "server {
    listen 80;
    server_name $API_DOMAIN;
    client_max_body_size 12m;
    location / { proxy_pass http://127.0.0.1:$PORT; $PROXY }
}"

nginx -t >/dev/null 2>&1 || { nginx -t; die "Nginx config test failed. Your existing sites are untouched; the new files are $(ngx_file web), $(ngx_file admin), $(ngx_file api)."; }
systemctl reload nginx
c_ok "Nginx reloaded"

# ---------------------------------------------------------------- 7. SSL
if [ "${SKIP_SSL:-0}" != 1 ] && [ ${#SSL_DOMAINS[@]} -gt 0 ]; then
  c_info "Requesting SSL certificates"
  for d in "${SSL_DOMAINS[@]}"; do
    certbot --nginx --non-interactive --agree-tos -m "$ADMIN_EMAIL" --redirect --keep-until-expiring --cert-name "$d" -d "$d" >/dev/null 2>&1 \
      && c_ok "SSL for $d" || c_warn "SSL for $d failed — check DNS, then re-run: certbot --nginx -d $d"
  done
fi

# ---------------------------------------------------------------- 8. summary
url_for() { if [ -n "$(ls /etc/letsencrypt/live/"$1"/fullchain.pem 2>/dev/null)" ]; then echo "https://$1"; else echo "http://$1"; fi; }
VERIFY_TOKEN=$(grep '^META_VERIFY_TOKEN=' "$ENV_FILE" | cut -d= -f2)
echo
echo "──────────────────────────── WappFlow is installed ────────────────────────────"
echo " Website      $(url_for "$WEB_DOMAIN")"
echo " Dashboard    $(url_for "$ADMIN_DOMAIN")/login"
echo " API          $(url_for "$API_DOMAIN")/health"
echo
if [ -f "$LOGIN_FILE" ]; then grep -v '^URL:' "$LOGIN_FILE" | sed 's/^/ /'; echo "  (saved in $LOGIN_FILE — change the password, then delete this file)"; echo; fi
echo " Meta → WhatsApp → Configuration → Webhook"
echo "   Callback URL   https://$API_DOMAIN/webhooks/whatsapp"
echo "   Verify token   $VERIFY_TOKEN"
echo
echo " PayPal → Webhooks (optional backup)"
echo "   URL            https://$API_DOMAIN/api/billing/paypal/webhook   events: Checkout order approved, Payment capture completed"
echo
echo " Settings file  $ENV_FILE   (after editing: pm2 reload $PM2_NAME --update-env)"
echo " Logs           pm2 logs $PM2_NAME"
echo " Update later   push to GitHub, then run: wappflow-update"
echo "───────────────────────────────────────────────────────────────────────────────"
