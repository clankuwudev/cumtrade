#!/usr/bin/env bash
# Activate a gateway release on this server (X18, spec x18-gateway-service.md
# S3). Installed as /usr/local/bin/clank-gateway-activate. It runs as
# clank-deploy, which owns /srv/clank-gateway and may restart clank-gateway
# through one sudoers line. It is activate.sh with the gateway's paths, unit and
# release checks; the site's releases and service are never touched.
#
#   clank-gateway-activate <tarball>   back up the ledger, unpack, switch, restart and check; switch back if it fails
#   clank-gateway-activate --no-backup <tarball>   the same without the backup, when it cannot run
#   clank-gateway-activate rollback    switch to the release deployed before the current one
#   clank-gateway-activate status      the current release and the deploy history
#
# Once X24's backup is installed, a deploy starts with a copy of the ledger
# (clank-gateway-predeploy-backup), so a release that migrates it always has
# one from before; a failed copy stops the deploy.
#
# A release is up when /healthz answers 200 within 30s of the restart. The
# restart itself waits for the old release to drain (up to 45s, TimeoutStopSec).
# The ledger is not in a release, so switching never touches money. An older
# build refuses a ledger a newer one migrated, fails /healthz, and is switched
# back.
set -euo pipefail

ROOT=${CLANK_GATEWAY_ROOT:-/srv/clank-gateway}
RELEASES=$ROOT/releases
DEPLOYED=$ROOT/deployed # one sha per line, newest last
HEALTH_URL=${CLANK_GATEWAY_HEALTH_URL:-http://127.0.0.1:8791/healthz}
KEEP=5

say() { printf 'clank-gateway-activate: %s\n' "$*"; }
fail() { say "$*" >&2; exit 1; }

current() { local t; t=$(readlink "$ROOT/current" 2>/dev/null) || return 0; basename "$t"; }

# Atomic: a new symlink renamed over the old one, so there is no moment
# without a `current`.
switch_to() {
  ln -sfn "releases/$1" "$ROOT/current.next"
  mv -Tf "$ROOT/current.next" "$ROOT/current"
}

# A failed restart is not the end: /healthz decides, and a release that does
# not come up is switched back. Exiting here would skip that.
restart() { sudo -n /usr/bin/systemctl restart clank-gateway || say "systemctl restart failed" >&2; }

healthy() {
  local i
  for i in $(seq 1 60); do
    if curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Keep the current release and the last $KEEP deployed, for rollback.
prune() {
  local keep sha dir
  keep=$( (current; tail -n "$KEEP" "$DEPLOYED" 2>/dev/null) | sort -u)
  for dir in "$RELEASES"/*/; do
    sha=$(basename "$dir")
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || continue
    grep -qx "$sha" <<<"$keep" || { rm -rf "$dir"; say "removed old release ${sha:0:12}"; }
  done
}

# X24 B5: a copy of the ledger before anything changes, once the backup is installed.
backup_first() {
  [ "$NO_BACKUP" = 1 ] && { say "--no-backup: no copy of the ledger before this deploy" >&2; return 0; }
  [ -e /etc/systemd/system/clank-gateway-predeploy-backup.service ] || return 0
  sudo -n /usr/bin/systemctl start clank-gateway-predeploy-backup \
    || fail "the ledger's pre-deploy backup failed, so nothing was deployed. See: journalctl -u clank-gateway-predeploy-backup. To deploy anyway: clank-gateway-activate --no-backup <tarball>"
  say "the ledger is backed up"
}

activate() {
  local tarball=$1 tmp sha previous
  [ -f "$tarball" ] || fail "no such tarball: $tarball"
  backup_first
  mkdir -p "$RELEASES"
  tmp=$(mktemp -d "$RELEASES/.incoming.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  tar -xzf "$tarball" -C "$tmp" --no-same-owner

  sha=$(sed -n 's/.*"sha": *"\([0-9a-f]\{40\}\)".*/\1/p' "$tmp/RELEASE.json" 2>/dev/null)
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || fail "the tarball has no RELEASE.json naming a commit"
  # A site release shipped here by mistake would never answer on :8791; say so now.
  grep -q '"service": *"gateway"' "$tmp/RELEASE.json" || fail "RELEASE.json does not name the gateway: is this a site release?"
  # The build refuses these too. This is the server's own look.
  if find "$tmp" -path '*/src/self/*' -print -quit | grep -q .; then fail "the release contains src/self/"; fi
  if find "$tmp" -path '*/src/web/*' -print -quit | grep -q .; then fail "the release contains src/web/"; fi
  if find "$tmp" -name '.env*' -print -quit | grep -q .; then fail "the release contains an .env file"; fi
  if find "$tmp" -name '.apimart-key' -print -quit | grep -q .; then fail "the release contains an .apimart-key file"; fi
  [ -f "$tmp/src/entry/gateway.js" ] || fail "the release has no src/entry/gateway.js"
  [ -f "$tmp/src/gateway/cli/key.js" ] || fail "the release has no key CLI (src/gateway/cli/key.js)"
  # The gateway reads its price book beside its code and refuses to start without it.
  [ -s "$tmp/pricing/apimart-catalogue.json" ] || fail "the release has no price book (pricing/apimart-catalogue.json)"
  [ -s "$tmp/pricing/price-overrides.json" ] || fail "the release has no price overrides (pricing/price-overrides.json)"

  if [ -d "$RELEASES/$sha" ]; then
    say "release ${sha:0:12} is already unpacked"
    rm -rf "$tmp"
  else
    # Readable by clank-gw, writable by clank-deploy only.
    chmod -R u=rwX,go=rX "$tmp"
    mv "$tmp" "$RELEASES/$sha"
  fi
  trap - EXIT

  previous=$(current)
  if [ "$previous" = "$sha" ]; then say "${sha:0:12} is already current; restarting it"; fi
  switch_to "$sha"
  restart
  if healthy; then
    echo "$sha" >>"$DEPLOYED"
    prune
    say "${sha:0:12} is live"
    return 0
  fi

  say "${sha:0:12} did not answer /healthz within 30s" >&2
  if [ -n "$previous" ] && [ "$previous" != "$sha" ]; then
    switch_to "$previous"
    restart
    if healthy; then say "switched back to ${previous:0:12}, which is live" >&2
    else say "switched back to ${previous:0:12}, but it is not answering either" >&2; fi
    # A release that never ran here goes. One that was live before stays for rollback.
    grep -qx "$sha" "$DEPLOYED" 2>/dev/null || rm -rf "${RELEASES:?}/$sha"
  else
    say "there is no previous release to switch back to" >&2
  fi
  exit 1
}

rollback() {
  local cur prev
  cur=$(current)
  [ -n "$cur" ] || fail "nothing is deployed"
  prev=$(grep -vx "$cur" "$DEPLOYED" 2>/dev/null | tail -n 1 || true)
  [ -n "$prev" ] || fail "no earlier release in $DEPLOYED"
  [ -d "$RELEASES/$prev" ] || fail "release ${prev:0:12} is no longer on disk"
  switch_to "$prev"
  restart
  if ! healthy; then
    say "${prev:0:12} did not answer /healthz; switching back to ${cur:0:12}" >&2
    switch_to "$cur"
    restart
    healthy || say "${cur:0:12} is not answering either" >&2
    exit 1
  fi
  echo "$prev" >>"$DEPLOYED"
  say "rolled back from ${cur:0:12} to ${prev:0:12}"
}

status() {
  say "current: $(current || true)"
  say "deployed, newest last:"
  tail -n 10 "$DEPLOYED" 2>/dev/null | sed 's/^/  /' || true
}

NO_BACKUP=0
if [ "${1:-}" = --no-backup ]; then NO_BACKUP=1; shift; fi
case "${1:-}" in
  rollback) rollback ;;
  status) status ;;
  "" | -h | --help) sed -n '2,20p' "$0" ;;
  *) activate "$1" ;;
esac
