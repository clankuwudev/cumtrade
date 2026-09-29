#!/usr/bin/env bash
# Activate a hosted release on this server (public-release H1). Installed as
# /usr/local/bin/clank-activate. It runs as clank-deploy, which owns
# /srv/clank and may restart clank-hosted through one sudoers line.
#
#   clank-activate <tarball>   unpack, switch, restart and check; switch back if it fails
#   clank-activate rollback    switch to the release deployed before the current one
#   clank-activate status      the current release and the deploy history
#
# A release is up when /healthz answers 200 within 30s of the restart.
set -euo pipefail

ROOT=${CLANK_ROOT:-/srv/clank}
RELEASES=$ROOT/releases
DEPLOYED=$ROOT/deployed # one sha per line, newest last
HEALTH_URL=${CLANK_HEALTH_URL:-http://127.0.0.1:8787/healthz}
KEEP=5

say() { printf 'clank-activate: %s\n' "$*"; }
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
restart() { sudo -n /usr/bin/systemctl restart clank-hosted || say "systemctl restart failed" >&2; }

healthy() {
  local i
  for i in $(seq 1 60); do
    if curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Keep the current release and the last $KEEP deployed. Old pages still ask for
# their own /v/<sha>/ files for a while after a deploy.
prune() {
  local keep sha dir
  keep=$( (current; tail -n "$KEEP" "$DEPLOYED" 2>/dev/null) | sort -u)
  for dir in "$RELEASES"/*/; do
    sha=$(basename "$dir")
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || continue
    grep -qx "$sha" <<<"$keep" || { rm -rf "$dir"; say "removed old release ${sha:0:12}"; }
  done
}

activate() {
  local tarball=$1 tmp sha previous
  [ -f "$tarball" ] || fail "no such tarball: $tarball"
  mkdir -p "$RELEASES"
  tmp=$(mktemp -d "$RELEASES/.incoming.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  tar -xzf "$tarball" -C "$tmp" --no-same-owner

  sha=$(sed -n 's/.*"sha": *"\([0-9a-f]\{40\}\)".*/\1/p' "$tmp/RELEASE.json" 2>/dev/null)
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || fail "the tarball has no RELEASE.json naming a commit"
  # The build refuses these too. This is the server's own look.
  if find "$tmp" -path '*/src/self/*' -print -quit | grep -q .; then fail "the release contains src/self/"; fi
  if find "$tmp" -name '.env*' -print -quit | grep -q .; then fail "the release contains an .env file"; fi
  [ -f "$tmp/src/entry/hosted.js" ] || fail "the release has no src/entry/hosted.js"
  # Caddy serves the page and its policy from these (H1.2). Caddy answers 503
  # without a policy file; an empty one would be a page with no policy at all.
  [ -s "$tmp/page/index.html" ] || fail "the release has no page/index.html"
  [ -s "$tmp/page/policy.txt" ] || fail "the release has no page policy (page/policy.txt)"
  [ -s "$tmp/release-manifest.json" ] || fail "the release has no release-manifest.json"
  if [ -e "$tmp/src/web/public/app.html" ]; then fail "the release serves app.html under /v/, with no policy"; fi

  if [ -d "$RELEASES/$sha" ]; then
    say "release ${sha:0:12} is already unpacked"
    rm -rf "$tmp"
  else
    # Readable by clank-web, writable by clank-deploy only.
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

case "${1:-}" in
  rollback) rollback ;;
  status) status ;;
  "" | -h | --help) sed -n '2,11p' "$0" ;;
  *) activate "$1" ;;
esac
