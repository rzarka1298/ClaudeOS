#!/bin/sh
# Static check of scripts/presence/test-custody.sh (FIX6B). That script cannot be run by an agent (it writes a
# Keychain item), and since the helper records its own code-directory hash in the pin, ANY helper binary other than
# the one that enrolled reads the pin as stale (exit 3 before the prompt). So the sequence must use ONE binary for
# every enrol, check, prove and unenrol, with the single exception of the deliberately foreign copy of the stale case.
# This script parses the sequence and asserts that, and that every case expecting exit 4 (a cancelled prompt) runs
# on the enrolling binary. It runs nothing from test-custody.sh and touches no Keychain.
# Usage: sh scripts/presence/test-custody-fixture.sh [path to test-custody.sh]
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
TARGET="${1:-${HERE}/test-custody.sh}"
FAIL=0

check() {
  if [ "$1" = ok ]; then echo "ok - $2"; else echo "not ok - $2"; FAIL=1; fi
}

# The enrolling binary: the first `"${WORK}/<name>" enrol`.
ENROL=$(sed -n 's/.*"\${WORK}\/\([A-Za-z0-9_-]*\)" enrol[ );].*/\1/p' "${TARGET}" | sed -n 1p)
[ -n "${ENROL}" ] && check ok "the sequence enrols with one binary (${ENROL})" || { check no "the sequence has an enrol step"; exit 1; }

# Every helper invocation (enrol, unenrol, check, prove) must use the enrolling binary, except the foreign copy.
BAD=$(sed -En 's/.*"\$\{WORK\}\/([A-Za-z0-9_-]*)" (enrol|unenrol|check|prove)[ );].*/\1 \2/p' "${TARGET}" | while read -r bin sub; do
  [ "${bin}" = "${ENROL}" ] || [ "${bin}" = foreign ] || echo "${bin} ${sub}"
done)
[ -z "${BAD}" ] && check ok "every enrol, unenrol, check and prove runs on the enrolling binary (or the foreign stale copy)" || check no "binaries other than the enrolling one run helper subcommands: $(echo "${BAD}" | tr '\n' ';')"

# The foreign copy is only ever asked check and prove (the stale case), never to change the item.
FOREIGN_WRITES=$(grep -Ec '"\$\{WORK\}/foreign" (enrol|unenrol)' "${TARGET}")
[ "${FOREIGN_WRITES}" -eq 0 ] && check ok "the foreign copy never enrols or unenrols" || check no "the foreign copy enrols or unenrols"

# Every case that expects exit 4 (a cancelled prompt) runs on the enrolling binary.
CANCEL_BINS=$(awk '
  /OUT=\$\(.*"\$\{WORK\}\// { match($0, /"\$\{WORK\}\/[A-Za-z0-9_-]+"/); bin = substr($0, RSTART + 9, RLENGTH - 10); next_line = 1; held = bin; next }
  next_line == 1 { if ($0 ~ /-eq 4/) print held; next_line = 0 }
' "${TARGET}")
if [ -z "${CANCEL_BINS}" ]; then
  check no "the sequence has a cancelled-prompt case (exit 4)"
else
  WRONG=$(echo "${CANCEL_BINS}" | while read -r bin; do [ "${bin}" = "${ENROL}" ] || echo "${bin}"; done)
  [ -z "${WRONG}" ] && check ok "every exit-4 (cancel) case runs on the enrolling binary" || check no "an exit-4 case runs on a binary that did not enrol: $(echo "${WRONG}" | tr '\n' ' ')"
fi

exit "${FAIL}"
