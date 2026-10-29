#!/bin/sh
# Validation/outcome tests for scripts/presence/ccc-presence.m that NEVER call
# LocalAuthentication's evaluatePolicy. Three TEST-ONLY harness copies of the
# source are built in a mktemp dir, each with the evaluatePolicy call replaced
# by a stub that reports an outcome without prompting:
#   accept  - stub replies success   (prove reaching it prints "proved")
#   cancel  - stub replies failure -2 (a user cancel)
#   silent  - stub never replies, prove ceiling shrunk to 1 s (the timeout path)
# The same copies also stub the two Keychain calls of the K-ATTR custody (the pin
# lookup and the signing), and point the pin at a harness-only service name, so
# nothing here reads or writes any Keychain item. The real custody path is
# covered by scripts/presence/test-custody.sh (test-only service, cleaned up).
# The real, production binary is only ever run with `check` and with messages
# that fail validation (exit 2 before any OS call). The production source has no
# switch that skips the prompt; the stubbing happens only in this script's copies.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="${HERE}/ccc-presence.m"
FAIL=0
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT INT TERM

check() {
  if [ "$1" = ok ]; then echo "ok - $2"; else echo "not ok - $2"; FAIL=1; fi
}

stub_build() { # name, stub body, ceiling seconds
  perl -0pe 's/\[context evaluatePolicy:.*?\];\n/'"$2"'\n/s; s/kProveCeilingSeconds = 60;/kProveCeilingSeconds = '"$3"';/; s/pinIsEnrolled\(\)/YES/g; s/signWithPinnedKey\(raw, &signature\)/(signature = \@"c3R1YnN0dWJzdHVi", YES)/; s/(kPinService = )\@"[^"]*"/$1\@"com.claude-command-center.uat-harness-unused"/; s/(kPinAccount = )\@"[^"]*"/$1\@"ccc-uat-harness-unused"/' "${SRC}" > "${WORK}/$1.m"
  if grep -q 'evaluatePolicy:LAPolicyDeviceOwnerAuthentication$\|\[context evaluatePolicy' "${WORK}/$1.m"; then
    echo "FATAL: stub for $1 did not remove the evaluatePolicy call" >&2; exit 1
  fi
  if grep -q 'signWithPinnedKey(raw\|pinIsEnrolled()\|"approval-presence-pin"\|kPinService = @"com.claude-command-center"' "${WORK}/$1.m"; then
    echo "FATAL: stub for $1 left a real Keychain call or the product pin name in place" >&2; exit 1
  fi
  xcrun clang -fobjc-arc -O2 -framework Foundation -framework LocalAuthentication -framework Security \
    -o "${WORK}/$1" "${WORK}/$1.m" 2>"${WORK}/$1.log" || { echo "FATAL: harness $1 failed to compile" >&2; cat "${WORK}/$1.log" >&2; exit 1; }
}

stub_build accept 'success = YES; dispatch_semaphore_signal(done);' 60
stub_build cancel 'success = NO; failureCode = -2; dispatch_semaphore_signal(done);' 60
stub_build silent '(void)0;' 1

PID=$(printf 'a%.0s' $(seq 25))
HASH=$(printf 'b%.0s' $(seq 64))
msg() { # approvedAt
  printf '{"v":1,"proposalId":"%s","operation":"diagnostic.test","payloadHash":"%s","decision":"approve","approvedAt":"%s"}' "${PID}" "${HASH}" "$1" | base64 | tr -d '\n'
}

# F3: accepted instants reach the (stubbed) prompt and report proved.
for t in 2026-10-28T12:00:00Z 2024-02-29T12:00:00Z 1970-01-01T00:00:00Z 2026-01-01T00:00:00+14:00 2026-01-01T00:00:00-12:00 \
         2026-12-31T23:59:59.123456789Z 2026-06-30T23:59:59+05:30 2000-02-29T00:00:00Z; do
  OUT=$("${WORK}/accept" prove --message "$(msg "$t")"); RC=$?
  [ "${RC}" -eq 0 ] && [ "${OUT}" = '{"v":1,"result":"proved","scheme":"p256","signature":"c3R1YnN0dWJzdHVi"}' ] && check ok "accepts ${t}" || check no "accepts ${t} (rc ${RC}: ${OUT})"
done
# F3: impossible or out-of-range instants are a usage error (exit 2) and never reach the prompt.
for t in 2026-02-30T00:00:00Z 2025-02-29T00:00:00Z 2026-04-31T00:00:00Z 2100-02-29T00:00:00Z 2026-01-01T24:00:00Z 2026-01-01T00:00:00+99:99 \
         2026-01-01T00:00:00+14:01 2026-01-01T00:00:00+15:00 2026-01-01T00:00:00-15:00 2026-01-01T00:00:00+05:60 \
         0000-01-01T00:00:00Z 1969-12-31T23:59:59Z 2026-13-01T00:00:00Z 2026-00-10T00:00:00Z 2026-01-00T00:00:00Z \
         2026-01-01T25:00:00Z 2026-01-01T00:60:00Z 2026-01-01T00:00:60Z 2026-01-01T00:00:00 2026-01-01T00:00:00.Z; do
  OUT=$("${WORK}/accept" prove --message "$(msg "$t")"); RC=$?
  [ "${RC}" -eq 2 ] && [ "${OUT}" = '{"v":1,"error":"usage"}' ] && check ok "rejects ${t}" || check no "rejects ${t} (rc ${RC}: ${OUT})"
done

# F5: a user cancel keeps its LAError code and has no cause; a timeout is denied, exit 4, with cause timeout.
OUT=$("${WORK}/cancel" prove --message "$(msg 2026-10-28T12:00:00Z)"); RC=$?
[ "${RC}" -eq 4 ] && [ "${OUT}" = '{"v":1,"result":"denied","error":-2}' ] && check ok "cancel: denied, LAError code, no cause" || check no "cancel: denied, LAError code, no cause (rc ${RC}: ${OUT})"
OUT=$("${WORK}/silent" prove --message "$(msg 2026-10-28T12:00:00Z)"); RC=$?
[ "${RC}" -eq 4 ] && [ "${OUT}" = '{"v":1,"result":"denied","error":-9,"cause":"timeout"}' ] && check ok "timeout: denied, exit 4, cause timeout" || check no "timeout: denied, exit 4, cause timeout (rc ${RC}: ${OUT})"

# F4: exit 5 is reachable - a stdout the helper cannot write to is an internal failure (real binary, check never prompts).
RT="${WORK}/rt"
CCC_RUNTIME_DIR="${RT}" sh "${HERE}/build.sh" >/dev/null 2>&1 || { echo "FATAL: real build failed" >&2; exit 1; }
REAL="${RT}/bin/ccc-presence"
"${REAL}" check >&- 2>/dev/null; RC=$?
[ "${RC}" -eq 5 ] && check ok "check with unwritable stdout exits 5" || check no "check with unwritable stdout exits 5 (rc ${RC})"
"${REAL}" prove --message '!!!not-base64' >&- 2>/dev/null; RC=$?
[ "${RC}" -eq 5 ] && check ok "malformed prove with unwritable stdout exits 5" || check no "malformed prove with unwritable stdout exits 5 (rc ${RC})"
# The closed set otherwise holds on the real binary (malformed input only; never a message that validates).
OUT=$("${REAL}" prove --message '!!!not-base64'); RC=$?
[ "${RC}" -eq 2 ] && [ "${OUT}" = '{"v":1,"error":"usage"}' ] && check ok "malformed prove: usage exit 2" || check no "malformed prove: usage exit 2 (rc ${RC}: ${OUT})"
# 09-15: the non-prompting check reports whether the pin exists (an attribute-only lookup; reads no secret).
OUT=$("${REAL}" check); RC=$?
# (A machine that cannot evaluate the policy exits 3 with canEvaluate false, which is also a closed answer.)
if [ "${RC}" -eq 3 ]; then
  printf '%s' "${OUT}" | grep -Eq '^\{"v":1,"canEvaluate":false,"error":-?[0-9]+\}$' && check ok "check on a machine that cannot evaluate: canEvaluate false, exit 3" || check no "check on a machine that cannot evaluate (rc ${RC}: ${OUT})"
else
  printf '%s' "${OUT}" | grep -Eq '^\{"v":1,"canEvaluate":true,"biometry":"(touch-id|none)","enrolled":(true|false)\}$' && [ "${RC}" -eq 0 ] && check ok "check reports canEvaluate, biometry and enrolled" || check no "check reports canEvaluate, biometry and enrolled (rc ${RC}: ${OUT})"
fi
OUT=$("${REAL}" enrol extra); RC=$?
[ "${RC}" -eq 2 ] && [ "${OUT}" = '{"v":1,"error":"usage"}' ] && check ok "enrol with an extra argument is a usage error (nothing is created)" || check no "enrol with an extra argument is a usage error (rc ${RC}: ${OUT})"
OUT=$("${REAL}" bogus); RC=$?
[ "${RC}" -eq 2 ] && check ok "unknown subcommand: exit 2" || check no "unknown subcommand: exit 2 (rc ${RC})"

exit "${FAIL}"
