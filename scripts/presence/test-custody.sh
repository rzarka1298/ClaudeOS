#!/bin/sh
# Live custody test for scripts/presence/ccc-presence.m (plan 09-15, K-ATTR): enrol, check, prove, unenrol
# against a REAL Keychain item, but never the product's item and never a real prompt.
#
# ONE TEST-ONLY harness copy of the source is built in a mktemp dir, with the LocalAuthentication evaluatePolicy
# call replaced by a stub that replies success, or failure -2 (a user cancel) when CCC_HARNESS_PROMPT=cancel is set
# (an environment read that exists only in the harness copy). One binary, because the pin records the enrolling
# binary's code-directory hash. The stubbed gesture also stands in for the owner when enrol replaces and unenrol
# removes the item. The copy points the pin at a unique test service and account (com.claude-command-center.uat-<random>,
# ccc-uat-<random>), so the owner's approval-presence-pin item is never read, written or deleted. The
# item is created and deleted by the same ad-hoc-signed binary that the access list trusts, which is the
# silent path (spike: acl_item, attr_read_silent); the script never deletes it with `security`, which could
# raise a Keychain sheet (a foreign delete is unmeasured). A trap removes the test item on any exit. NOT run by CI or the agents'
# default gates: it writes one temporary Keychain item. Run it from a Terminal.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="${HERE}/ccc-presence.m"
SUFFIX=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
SERVICE="com.claude-command-center.uat-${SUFFIX}"
ACCOUNT="ccc-uat-${SUFFIX}"
FAIL=0
WORK=$(mktemp -d)
echo "service: ${SERVICE}"
echo "account: ${ACCOUNT}"

cleanup() {
  if [ -x "${WORK}/harness" ]; then "${WORK}/harness" unenrol >/dev/null 2>&1 || true; fi
  rm -rf "${WORK}"
}
trap cleanup EXIT INT TERM

check() {
  if [ "$1" = ok ]; then echo "ok - $2"; else echo "not ok - $2"; FAIL=1; fi
}

stub_build() { # name, stub body
  perl -0pe 's/\[context evaluatePolicy:.*?\];\n/'"$2"'\n/s; s/(kPinService = )\@"[^"]*"/$1\@"'"${SERVICE}"'"/; s/(kPinAccount = )\@"[^"]*"/$1\@"'"${ACCOUNT}"'"/' "${SRC}" > "${WORK}/$1.m"
  if grep -q '\[context evaluatePolicy' "${WORK}/$1.m"; then echo "FATAL: stub for $1 kept evaluatePolicy" >&2; exit 1; fi
  if grep -q '"approval-presence-pin"' "${WORK}/$1.m"; then echo "FATAL: harness $1 still names the product pin account" >&2; exit 1; fi
  xcrun clang -fobjc-arc -O2 -framework Foundation -framework LocalAuthentication -framework Security \
    -o "${WORK}/$1" "${WORK}/$1.m" 2>"${WORK}/$1.log" || { echo "FATAL: harness $1 failed to compile" >&2; cat "${WORK}/$1.log" >&2; exit 1; }
  codesign -f -s - "${WORK}/$1" >/dev/null 2>&1 || { echo "FATAL: harness $1 failed to sign" >&2; exit 1; }
}

# ONE harness binary for the whole sequence. The pin records the enrolling binary's code-directory hash, so any
# other binary (such as a separately compiled "cancel" copy) reads it as stale and exits 3 before its prompt. The
# prompt outcome is therefore selected by CCC_HARNESS_PROMPT, an environment read that exists ONLY in this harness
# copy (the production source consults no environment variable). scripts/presence/test-custody-fixture.sh checks
# this sequence statically.
stub_build harness 'success = !(getenv("CCC_HARNESS_PROMPT") != NULL \&\& strcmp(getenv("CCC_HARNESS_PROMPT"), "cancel") == 0); failureCode = success ? 0 : -2; dispatch_semaphore_signal(done);'

PID=$(printf 'a%.0s' $(seq 25))
HASH=$(printf 'b%.0s' $(seq 64))
MSG=$(printf '{"v":1,"proposalId":"%s","operation":"diagnostic.test","payloadHash":"%s","decision":"approve","approvedAt":"2026-10-28T12:00:00Z"}' "${PID}" "${HASH}")
MSG_B64=$(printf '%s' "${MSG}" | base64 | tr -d '\n')

# Before enrolment: check says not enrolled, prove exits 3 before any prompt.
OUT=$("${WORK}/harness" check); RC=$?
[ "${RC}" -eq 0 ] && printf '%s' "${OUT}" | grep -q '"enrolled":false' && check ok "check before enrol: enrolled false" || check no "check before enrol: enrolled false (rc ${RC}: ${OUT})"
OUT=$("${WORK}/harness" prove --message "${MSG_B64}"); RC=$?
[ "${RC}" -eq 3 ] && [ "${OUT}" = '{"v":1,"canEvaluate":true,"enrolled":false}' ] && check ok "prove before enrol: unavailable (exit 3), no signature" || check no "prove before enrol: unavailable (rc ${RC}: ${OUT})"

# Enrol.
OUT=$("${WORK}/harness" enrol); RC=$?
[ "${RC}" -eq 0 ] && [ "${OUT}" = '{"v":1,"enrolled":true}' ] && check ok "enrol: exit 0" || check no "enrol: exit 0 (rc ${RC}: ${OUT})"
OUT=$("${WORK}/harness" check); RC=$?
[ "${RC}" -eq 0 ] && printf '%s' "${OUT}" | grep -q '"enrolled":true' && check ok "check after enrol: enrolled true" || check no "check after enrol: enrolled true (rc ${RC}: ${OUT})"

# The pin is readable attribute-only (no -w, no -g) and is a 91-byte P-256 SPKI.
ATTRS=$(/usr/bin/security find-generic-password -a "${ACCOUNT}" -s "${SERVICE}" 2>&1); RC=$?
PIN=$(printf '%s\n' "${ATTRS}" | sed -n 's/^ *"icmt"<blob>="\(.*\)"$/\1/p')
printf '%s' "${PIN}" | base64 -D > "${WORK}/pin.der" 2>/dev/null
[ "${RC}" -eq 0 ] && [ "$(wc -c < "${WORK}/pin.der" | tr -d ' ')" = 91 ] && check ok "attribute-only read returns a 91-byte pin" || check no "attribute-only read returns a 91-byte pin (rc ${RC}, ${#PIN} chars)"
printf '%s\n' "${ATTRS}" | grep -q 'password:' && check no "attribute read printed no secret" || check ok "attribute read printed no secret"

# prove signs the exact message; the signature verifies under the pin and not under another message.
OUT=$("${WORK}/harness" prove --message "${MSG_B64}"); RC=$?
SIG=$(printf '%s' "${OUT}" | sed -n 's/^{"v":1,"result":"proved","scheme":"p256","signature":"\([A-Za-z0-9+/=]*\)"}$/\1/p')
[ "${RC}" -eq 0 ] && [ -n "${SIG}" ] && check ok "prove: exit 0, proved line with a signature" || check no "prove: exit 0, proved line with a signature (rc ${RC}: ${OUT})"
printf '%s' "${SIG}" | base64 -D > "${WORK}/sig.der" 2>/dev/null
openssl pkey -pubin -inform DER -in "${WORK}/pin.der" -out "${WORK}/pin.pem" 2>/dev/null
printf '%s' "${MSG}" > "${WORK}/msg.bin"
openssl dgst -sha256 -verify "${WORK}/pin.pem" -signature "${WORK}/sig.der" "${WORK}/msg.bin" >/dev/null 2>&1 && check ok "signature verifies under the pinned key" || check no "signature verifies under the pinned key"
printf '%s ' "${MSG}" > "${WORK}/other.bin"
openssl dgst -sha256 -verify "${WORK}/pin.pem" -signature "${WORK}/sig.der" "${WORK}/other.bin" >/dev/null 2>&1 && check no "signature does not verify for another message" || check ok "signature does not verify for another message"

# A cancel signs nothing.
OUT=$(CCC_HARNESS_PROMPT=cancel "${WORK}/harness" prove --message "${MSG_B64}"); RC=$?
[ "${RC}" -eq 4 ] && [ "${OUT}" = '{"v":1,"result":"denied","error":-2}' ] && check ok "cancel: denied, exit 4, no signature" || check no "cancel: denied, exit 4 (rc ${RC}: ${OUT})"

# Re-enrol replaces the pin with a new key.
"${WORK}/harness" enrol >/dev/null 2>&1; RC=$?
PIN2=$(/usr/bin/security find-generic-password -a "${ACCOUNT}" -s "${SERVICE}" 2>&1 | sed -n 's/^ *"icmt"<blob>="\(.*\)"$/\1/p')
[ "${RC}" -eq 0 ] && [ -n "${PIN2}" ] && [ "${PIN2}" != "${PIN}" ] && check ok "re-enrol: a new key replaces the pin" || check no "re-enrol: a new key replaces the pin (rc ${RC})"

# FIX6B M1: a pin that a DIFFERENT binary enrolled is stale. A copy of the harness binary re-signed under another
# identifier has another code-directory hash, so its attribute-only lookup says stale and `prove` stops before any
# prompt or secret read (it never touches the item's secret, so no Keychain sheet is expected here).
cp "${WORK}/harness" "${WORK}/foreign" && codesign -f -s - -i com.example.ccc-uat-foreign "${WORK}/foreign" >/dev/null 2>&1
OUT=$("${WORK}/foreign" check); RC=$?
[ "${RC}" -eq 0 ] && printf '%s' "${OUT}" | grep -q '"enrolled":false,"stale":true' && check ok "check by a different binary: enrolled false, stale true" || check no "check by a different binary: stale (rc ${RC}: ${OUT})"
OUT=$("${WORK}/foreign" prove --message "${MSG_B64}"); RC=$?
[ "${RC}" -eq 3 ] && [ "${OUT}" = '{"v":1,"canEvaluate":true,"enrolled":false,"stale":true}' ] && check ok "prove by a different binary: unavailable (exit 3), stale, no prompt" || check no "prove by a different binary (rc ${RC}: ${OUT})"

# Unenrol deletes the item; a second unenrol is still success.
OUT=$("${WORK}/harness" unenrol); RC=$?
[ "${RC}" -eq 0 ] && [ "${OUT}" = '{"v":1,"enrolled":false}' ] && check ok "unenrol: exit 0" || check no "unenrol: exit 0 (rc ${RC}: ${OUT})"
/usr/bin/security find-generic-password -a "${ACCOUNT}" -s "${SERVICE}" >/dev/null 2>&1; RC=$?
[ "${RC}" -eq 44 ] && check ok "the test item is gone (security exit 44)" || check no "the test item is gone (security exit ${RC})"
"${WORK}/harness" unenrol >/dev/null 2>&1; RC=$?
[ "${RC}" -eq 0 ] && check ok "unenrol twice: still exit 0" || check no "unenrol twice: still exit 0 (rc ${RC})"

exit "${FAIL}"
