#!/usr/bin/env bash
# Remove a hosted install from this machine (public-release H1; the gateway,
# X18). Run as root.
#
#   deploy/uninstall.sh --gateway  the gateway alone: its service, user, releases, config and Caddy block
#   deploy/uninstall.sh            the gateway, then the site: services, users, releases, history and config
#   deploy/uninstall.sh --all      also Caddy (with its apt source) and /opt/node22
#
# The gateway's ledger (accounts, keys, balances) goes only if you type
# "delete ledger" at the prompt. Without a terminal it is always kept.
# It never touches a system Node or anything else it did not install.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "uninstall: run as root" >&2; exit 1; }
case "${1:-}" in "" | --gateway | --all) ;; *) sed -n '2,11p' "$0" >&2; exit 2 ;; esac

remove_gateway() {
  # X24's timers first, so nothing starts a backup or a watch halfway through.
  systemctl disable --now clank-gateway-backup.timer clank-watch.timer 2>/dev/null || true
  systemctl disable --now clank-gateway 2>/dev/null || true
  rm -f /etc/systemd/system/clank-gateway.service \
    /etc/systemd/system/clank-gateway-backup.service /etc/systemd/system/clank-gateway-backup.timer \
    /etc/systemd/system/clank-gateway-predeploy-backup.service \
    /etc/systemd/system/clank-watch.service /etc/systemd/system/clank-watch.timer
  systemctl daemon-reload
  rm -f /usr/local/bin/clank-gateway-activate /usr/local/bin/clank-gateway-backup /usr/local/bin/clank-watch-run
  # The copies already in the bucket stay there: the bucket is not this machine's to empty.
  rm -rf /srv/clank-gateway /etc/clank/gateway.env /etc/clank/backup.env /etc/clank/watch.env /etc/clank/gateway.d /etc/clank/api.d
  rm -f /var/log/caddy/clank-gateway-access.log*
  # Caddy drops the api host once the block is gone. API_HOST in its drop-in
  # (systemctl edit caddy) is then unused and harmless.
  if systemctl is-active --quiet caddy 2>/dev/null; then systemctl reload caddy || echo "uninstall: reload Caddy yourself" >&2; fi

  local ledger=/var/lib/clank-gateway answer=
  if [ -d "$ledger" ]; then
    if [ -t 0 ]; then
      echo "uninstall: $ledger holds the credit ledger (every account, key and balance) and its local backup copies. There is no undo."
      read -r -p 'uninstall: type "delete ledger" to delete it, anything else to keep it: ' answer || true
    fi
    if [ "$answer" = "delete ledger" ]; then
      rm -rf "$ledger"
      echo "uninstall: the ledger is deleted"
    else
      echo "uninstall: the ledger is kept in $ledger"
    fi
  fi
  id clank-gw >/dev/null 2>&1 && userdel clank-gw
  echo "uninstall: clank-gateway, its user and its files are gone"
}

remove_gateway
[ "${1:-}" = --gateway ] && exit 0

systemctl disable --now clank-hosted 2>/dev/null || true
rm -f /etc/systemd/system/clank-hosted.service
systemctl daemon-reload
rm -f /etc/sudoers.d/clank-deploy /usr/local/bin/clank-activate
rm -rf /srv/clank /var/lib/clank /etc/clank
rm -f /var/log/caddy/clank-access.log*
id clank-web >/dev/null 2>&1 && userdel clank-web
id clank-deploy >/dev/null 2>&1 && userdel -r clank-deploy 2>/dev/null || true
echo "uninstall: clank-hosted, its users and its files are gone"

if [ "${1:-}" = --all ]; then
  if dpkg -s caddy >/dev/null 2>&1; then
    systemctl disable --now caddy 2>/dev/null || true
    apt-get purge -y caddy
    rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    rm -rf /etc/caddy /var/lib/caddy /var/log/caddy
  fi
  rm -rf /opt/node22
  echo "uninstall: Caddy and /opt/node22 are gone"
fi
