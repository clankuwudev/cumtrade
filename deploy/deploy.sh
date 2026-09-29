#!/usr/bin/env bash
# Build a release and put it live (public-release H1; the gateway, X18). Runs
# on the operator's machine, never on the server: the build needs the
# repository, and the server must not hold src/self/.
#
#   deploy/deploy.sh [gateway] clank-deploy@host [--ref <ref>] [--tarball <file>]
#   deploy/deploy.sh [gateway] clank-deploy@host rollback
#   deploy/deploy.sh [gateway] clank-deploy@host status
#
# Without `gateway` it is the site (release-hosted.mjs, clank-activate). With
# it, the gateway (release-gateway.mjs, clank-gateway-activate); the other
# service is never touched. With --local instead of a host, the server is this
# machine (a rehearsal run as root): activate runs as clank-deploy through
# sudo instead of ssh.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
usage() { sed -n '2,15p' "$0"; exit 2; }

service=hosted
activate=/usr/local/bin/clank-activate
if [ "${1:-}" = gateway ]; then
  service=gateway
  activate=/usr/local/bin/clank-gateway-activate
  shift
fi

target=${1:-}
[ -n "$target" ] || usage
shift

remote() {
  if [ "$target" = --local ]; then sudo -u clank-deploy "$activate" "$@"
  else ssh "$target" "$activate" "$@"; fi
}

case "${1:-}" in
  rollback | status) remote "$1"; exit ;;
esac

ref=HEAD
tarball=
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref=$2; shift 2 ;;
    --tarball) tarball=$2; shift 2 ;;
    *) usage ;;
  esac
done

if [ -z "$tarball" ]; then
  node "$REPO/scripts/release-$service.mjs" --ref "$ref"
  sha=$(git -C "$REPO" rev-parse "$ref^{commit}")
  tarball="$REPO/releases/$service-$sha.tar.gz"
fi
[ -f "$tarball" ] || { echo "deploy: no tarball at $tarball" >&2; exit 1; }
name=$(basename "$tarball")

if [ "$target" = --local ]; then
  incoming=$(mktemp -d /tmp/clank-incoming.XXXXXX)
  cp "$tarball" "$incoming/$name"
  chown -R clank-deploy "$incoming"
  status=0
  remote "$incoming/$name" || status=$?
  rm -rf "$incoming"
  exit $status
fi

scp -q "$tarball" "$target:/tmp/$name"
status=0
remote "/tmp/$name" || status=$?
ssh "$target" rm -f "/tmp/$name"
exit $status
