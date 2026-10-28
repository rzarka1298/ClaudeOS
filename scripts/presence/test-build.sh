#!/bin/sh
# Build-script checks for scripts/presence/build.sh. Builds only into mktemp
# directories; never runs `prove`, never touches the owner's runtime dir.
# Covers FIX1 F2 (stable code identifier) and F6 (closed error line on
# runtime-dir failure, clang diagnostics on stderr, concurrent builds).
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
BUILD="${HERE}/build.sh"
EXPECTED_ID="com.claude-command-center.presence"
FAIL=0
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT INT TERM

check() {
  if [ "$1" = ok ]; then echo "ok - $2"; else echo "not ok - $2"; FAIL=1; fi
}

# F2: the installed binary's code identifier is stable and meaningful.
RT="${WORK}/rt1"
CCC_RUNTIME_DIR="${RT}" sh "${BUILD}" >"${WORK}/b1.out" 2>"${WORK}/b1.err"
ID=$(codesign -dv "${RT}/bin/ccc-presence" 2>&1 | sed -n 's/^Identifier=//p')
[ "${ID}" = "${EXPECTED_ID}" ] && check ok "code identifier is ${EXPECTED_ID} (got ${ID})" || check no "code identifier is ${EXPECTED_ID} (got ${ID})"
codesign --verify "${RT}/bin/ccc-presence" >/dev/null 2>&1 && check ok "signature verifies" || check no "signature verifies"
[ ! -e "${RT}/bin/ccc-presence.tmp" ] && check ok "no fixed .tmp leftover" || check no "no fixed .tmp leftover"
[ -z "$(ls -A "${RT}/bin" | grep -v '^ccc-presence$')" ] && check ok "only the helper in bin/" || check no "only the helper in bin/"

# F6a: runtime dir that cannot be created -> closed error line.
: > "${WORK}/afile"
CCC_RUNTIME_DIR="${WORK}/afile/sub" sh "${BUILD}" >"${WORK}/b2.out" 2>"${WORK}/b2.err"
RC=$?
grep -q '^ERROR: helper-build-failed: runtime-dir$' "${WORK}/b2.err" && [ "${RC}" -ne 0 ] && check ok "mkdir failure prints the closed runtime-dir line" || check no "mkdir failure prints the closed runtime-dir line (rc ${RC}: $(cat "${WORK}/b2.err"))"

# F6b: clang diagnostics are kept (stderr) after the closed line.
BAD="${WORK}/bad"
mkdir -p "${BAD}"
cp "${BUILD}" "${BAD}/build.sh"
printf 'this is not objective-c;\n' > "${BAD}/ccc-presence.m"
CCC_RUNTIME_DIR="${WORK}/rt3" sh "${BAD}/build.sh" >"${WORK}/b3.out" 2>"${WORK}/b3.err"
RC=$?
FIRST=$(sed -n 1p "${WORK}/b3.err")
[ "${RC}" -ne 0 ] && [ "${FIRST}" = "ERROR: helper-build-failed: compile" ] && check ok "compile failure: closed line first" || check no "compile failure: closed line first (got: ${FIRST})"
[ "$(wc -l < "${WORK}/b3.err")" -gt 1 ] && check ok "compile failure: clang diagnostics follow on stderr" || check no "compile failure: clang diagnostics follow on stderr"
[ ! -e "${WORK}/rt3/bin/ccc-presence" ] && check ok "compile failure leaves no helper" || check no "compile failure leaves no helper"

# F6c: concurrent builds into one runtime dir do not collide.
RT4="${WORK}/rt4"
CCC_RUNTIME_DIR="${RT4}" sh "${BUILD}" >/dev/null 2>"${WORK}/c1.err" &
P1=$!
CCC_RUNTIME_DIR="${RT4}" sh "${BUILD}" >/dev/null 2>"${WORK}/c2.err" &
P2=$!
wait ${P1}; R1=$?
wait ${P2}; R2=$?
[ "${R1}" -eq 0 ] && [ "${R2}" -eq 0 ] && [ -x "${RT4}/bin/ccc-presence" ] && check ok "two concurrent builds both succeed" || check no "two concurrent builds both succeed (${R1}/${R2}: $(cat "${WORK}/c1.err" "${WORK}/c2.err"))"
[ -z "$(ls -A "${RT4}/bin" | grep -v '^ccc-presence$')" ] && check ok "concurrent builds leave no private dirs behind" || check no "concurrent builds leave no private dirs behind"

exit "${FAIL}"
