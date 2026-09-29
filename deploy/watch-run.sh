#!/usr/bin/env bash
# Run clank-watch once, and tell its healthchecks.io check (X24 B8, B9).
# Installed as /usr/local/bin/clank-watch-run; run by clank-watch.service as
# clank-gw.
#
# One check (HC_WATCH_URL) carries both whether watch ran and what it found.
# healthchecks.io emails on each change between up and down, with the last
# ping's body:
#   - down (/fail): watch could not run or could not send, or it found
#     something (a new alarm or event, or one still standing). The body is
#     the alarm's text;
#   - up: it ran, and nothing stands;
#   - no ping at all past the grace: down, as for any stopped job.
# While one alarm stands the check stays down, so a second alarm raised
# meanwhile sends no email of its own. With Telegram set (TELEGRAM_*), watch
# also sends every alarm there itself. Nothing it prints holds a key or a
# token (watch.js cleans them).
set -uo pipefail
out=$(/opt/node22/bin/node --no-warnings src/gateway/cli/watch.js 2>&1)
code=$?
printf '%s\n' "$out"
[ -n "${HC_WATCH_URL:-}" ] || exit "$code"

alarms=$(grep -E '^clank-watch, .*(🔴|⚠️)' <<<"$out" || true)
standing=$(sed -n 's/^watch: .*, \([0-9][0-9]*\) standing.*/\1/p' <<<"$out")
if [ "$code" != 0 ]; then
  suffix=/fail; body=$(tail -n 5 <<<"$out")
elif [ -n "$alarms" ] || [ "${standing:-0}" != 0 ]; then
  suffix=/fail; body=${alarms:-"clank-watch: ${standing} alarm(s) still standing; nothing new this hour."}
else
  suffix=""; body=$(tail -n 3 <<<"$out")
fi
curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$body" "$HC_WATCH_URL$suffix" \
  || echo "clank-watch-run: the heartbeat did not answer" >&2
exit "$code"
