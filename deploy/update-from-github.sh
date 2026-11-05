#!/usr/bin/env bash
# Pull the latest wappflow-api, wappflow-admin and wappflow-web from GitHub, build them on the
# server and install with deploy/install.sh (which keeps .env, the database and logins).
#
# First time:  sudo bash update-from-github.sh --install   (also installs the `wappflow-update` command)
# Afterwards:  sudo wappflow-update
#
# Options (environment variables):
#   DOMAIN=wappflow.online       the www./admin./back. domain (remembered in /etc/wappflow-domain)
#   BRANCH=main                  branch to deploy
#   REPO_BASE=https://github.com/Eslamatef1992   where the three repos live
set -euo pipefail

DOMAIN="${DOMAIN:-$(cat /etc/wappflow-domain 2>/dev/null || true)}"
DOMAIN="${DOMAIN:-wappflow.online}"
BRANCH="${BRANCH:-main}"
REPO_BASE="${REPO_BASE:-https://github.com/Eslamatef1992}"
SRC_DIR="${SRC_DIR:-/opt/wappflow-src}"

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '\033[36m→\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run as root: sudo wappflow-update"
command -v git >/dev/null || { apt-get install -y -q git >/dev/null; }

if [ "${1:-}" = "--install" ]; then
  install -m 755 "$(readlink -f "$0")" /usr/local/bin/wappflow-update
  ok "Installed the command: wappflow-update"
fi

echo "$DOMAIN" > /etc/wappflow-domain
mkdir -p "$SRC_DIR"
for repo in wappflow-api wappflow-admin wappflow-web; do
  dir="$SRC_DIR/$repo"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch -q origin "$BRANCH" || die "Could not fetch $repo. Check the GitHub token (see README) and that the repo exists."
    git -C "$dir" reset -q --hard "origin/$BRANCH"
  else
    info "Cloning $repo"
    git clone -q --branch "$BRANCH" "$REPO_BASE/$repo.git" "$dir" || die "Could not clone $REPO_BASE/$repo. If the repo is private, set up the GitHub token first (see README)."
  fi
  ok "$repo at $(git -C "$dir" log -1 --format='%h %s' | cut -c1-70)"
done

info "Building the dashboard (wappflow-admin)"
(cd "$SRC_DIR/wappflow-admin" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent) >/tmp/wappflow-build-admin.log 2>&1 \
  || { tail -30 /tmp/wappflow-build-admin.log; die "Dashboard build failed (log: /tmp/wappflow-build-admin.log)"; }
ok "Dashboard built"

info "Building the website (wappflow-web)"
(cd "$SRC_DIR/wappflow-web" && npm ci --no-audit --no-fund --loglevel=error \
  && VITE_APP_URL="https://admin.$DOMAIN" VITE_API_URL="https://back.$DOMAIN" npm run build --silent) >/tmp/wappflow-build-web.log 2>&1 \
  || { tail -30 /tmp/wappflow-build-web.log; die "Website build failed (log: /tmp/wappflow-build-web.log)"; }
ok "Website built"

# Assemble the same layout as the deploy package and hand over to install.sh
PKG="$SRC_DIR/package"
rm -rf "$PKG" && mkdir -p "$PKG/api"
git -C "$SRC_DIR/wappflow-api" archive "$BRANCH" | tar -x -C "$PKG/api"
cp -r "$SRC_DIR/wappflow-admin/dist" "$PKG/admin"
cp -r "$SRC_DIR/wappflow-web/dist" "$PKG/web"
cp "$PKG/api/deploy/install.sh" "$PKG/install.sh"

# keep this command up to date with the version in the repo
install -m 755 "$SRC_DIR/wappflow-api/deploy/update-from-github.sh" /usr/local/bin/wappflow-update 2>/dev/null || true

DOMAIN="$DOMAIN" bash "$PKG/install.sh"
