#!/usr/bin/env bash
# The ledger's nightly copy, off the box (X24, spec x24-backups-monitoring.md
# B2-B5, B8). Installed as /usr/local/bin/clank-gateway-backup, run as root by
# clank-gateway-backup.service (nightly) and clank-gateway-predeploy-backup.
# service (before each gateway deploy).
#
#   clank-gateway-backup nightly     copy, encrypt, send; retry sends for 30 minutes
#   clank-gateway-backup predeploy   copy and encrypt; one try to send, which may fail
#
# 1. As clank-gw, the release's backup.js takes and checks the copy (B2).
# 2. As root, age encrypts the copy and its manifest to AGE_RECIPIENT (B3). The
#    private key is the operator's and never here.
# 3. curl sends them to the B2 bucket with SigV4, under nightly/ (and monthly/
#    on the 1st), with a key that can put and not delete (B4). Anything not
#    sent stays in the outbox, and the next run sends it too.
# 4. The heartbeat (HC_BACKUP_URL) hears success, or /fail with the reason (B8).
#
# Its settings are /etc/clank/backup.env (root, 0600). Nothing it prints holds
# a key: the B2 key goes to curl in a file, never on its command line.
set -uo pipefail

MODE=${1:-nightly}
LEDGER_DB=${LEDGER_DB:-/var/lib/clank-gateway/ledger.sqlite}
DIR=${CLANK_BACKUP_DIR:-/var/lib/clank-gateway/backups}
OUTBOX=$DIR/outbox
RELEASE=${CLANK_GATEWAY_RELEASE:-/srv/clank-gateway/current}
NODE=${CLANK_NODE:-/opt/node22/bin/node}
KEEP_PLAIN=3
say() { printf 'clank-gateway-backup: %s\n' "$*"; }

ping() { # [suffix] [body]
  [ -n "${HC_BACKUP_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${2:-}" "$HC_BACKUP_URL${1:-}" || say "the heartbeat did not answer" >&2
}
fail() {
  say "$*" >&2
  ping /fail "$MODE: $*"
  exit 1
}

case "$MODE" in nightly | predeploy) ;; *) fail "unknown mode $MODE (nightly or predeploy)" ;; esac
for v in AGE_RECIPIENT B2_ENDPOINT B2_REGION B2_BUCKET B2_KEY_ID B2_APP_KEY; do
  [ -n "${!v:-}" ] || fail "$v is not set (/etc/clank/backup.env)"
done
command -v age >/dev/null || fail "age is not installed (apt install age)"
command -v openssl >/dev/null || fail "openssl is not installed"
[ -f "$RELEASE/src/gateway/cli/backup.js" ] || fail "no backup.js in $RELEASE: deploy a gateway release from X24 on"
ping /start

# 1. The copy, as the ledger's owner (K28).
install -d -o clank-gw -g clank-gw -m 700 "$DIR"
install -d -o root -g root -m 700 "$OUTBOX"
out=$(cd "$RELEASE" && runuser -u clank-gw -- env LEDGER_DB="$LEDGER_DB" "$NODE" --no-warnings src/gateway/cli/backup.js "$DIR" 2>&1) \
  || fail "the copy failed: $(tail -n 1 <<<"$out")"
say "$out"
name=$(sed -n 's/^backup: \(ledger-[0-9TZ-]*\)\.sqlite,.*/\1/p' <<<"$out")
[ -n "$name" ] && [ -f "$DIR/$name.sqlite" ] && [ -f "$DIR/$name.json" ] || fail "backup.js did not say which copy it made"

# 2. Encrypted into the outbox.
for f in "$name.sqlite" "$name.json"; do
  age -r "$AGE_RECIPIENT" -o "$OUTBOX/$f.age.partial" "$DIR/$f" && mv "$OUTBOX/$f.age.partial" "$OUTBOX/$f.age" \
    || fail "age could not encrypt $f"
done
# Plain copies are no more than the live ledger beside them. Keep the last few for a quick local restore.
ls -1t "$DIR"/ledger-*.sqlite 2>/dev/null | tail -n +$((KEEP_PLAIN + 1)) | while read -r old; do
  rm -f "$old" "${old%.sqlite}.json"
done

# 3. Sent: each object once under nightly/, and under monthly/ on the 1st.
auth=$(mktemp); chmod 600 "$auth"; trap 'rm -f "$auth"' EXIT
printf 'user = "%s:%s"\n' "$B2_KEY_ID" "$B2_APP_KEY" >"$auth"
# A bucket with object lock refuses a put without a checksum (B2: "Content-MD5
# OR x-amz-checksum- HTTP header is required"). The SHA-256 is signed too, so
# B2 checks the whole body, not only that the request is ours.
put() { # file key
  local md5 sha
  md5=$(openssl dgst -md5 -binary "$1" | base64)
  sha=$(sha256sum "$1" | cut -d' ' -f1)
  curl -fsS -m 300 -K "$auth" --aws-sigv4 "aws:amz:$B2_REGION:s3" -T "$1" -o /dev/null \
    -H "Content-MD5: $md5" -H "x-amz-content-sha256: $sha" "$B2_ENDPOINT/$B2_BUCKET/$2"
}
send_outbox() {
  local f base stamp ok=0 failed=0
  for f in "$OUTBOX"/*.age; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    stamp=$(sed -n 's/^ledger-\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\)T.*/\1/p' <<<"$base")
    if put "$f" "nightly/$base" && { [ "${stamp:8:2}" != 01 ] || put "$f" "monthly/$base"; }; then
      rm -f "$f"; ok=$((ok + 1))
    else
      failed=$((failed + 1))
    fi
  done
  say "sent $ok, $failed left in the outbox"
  [ "$failed" = 0 ]
}
if [ "$MODE" = predeploy ]; then
  send_outbox || say "not all sent before the deploy: the nightly run sends the rest" >&2
  ping "" "predeploy: $name kept, and encrypted"
  exit 0
fi
for attempt in 1 2 3; do
  send_outbox && { ping "" "nightly: $name sent"; exit 0; }
  [ "$attempt" = 3 ] || sleep "${CLANK_BACKUP_RETRY_SECONDS:-600}"
done
fail "the bucket did not take $(ls -1 "$OUTBOX" | wc -l) files after 3 tries: they stay in $OUTBOX for the next run"
