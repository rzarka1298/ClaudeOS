#!/bin/sh
# Validation/outcome tests for scripts/presence/ccc-presence.m that NEVER call
# LocalAuthentication's evaluatePolicy and NEVER read or write a Keychain item.
# TEST-ONLY harness copies of the source are built in a mktemp dir:
#   - the evaluatePolicy call is replaced by a stub that reports an outcome without prompting
#       accept (success), cancel (failure -2), silent (never replies, ceiling shrunk to 1 s);
#   - every block the source marks HARNESS-SEAM-BEGIN/END (the pin lookup, the signing, the delete, the add and
#     the helper's own code-directory hash) is replaced: the lookup answers present-and-current,
#     present-and-stale, present-but-malformed, absent or a lookup error; delete and add only write a marker
#     file next to the copy so the test can see whether they were reached;
#   - the pin's service and account are rewritten to unused test names.
# One extra copy (lookup) keeps the REAL attribute-only lookup but with the renamed pin, so the real
# SecItemCopyMatching path (login-keychain scoped) is exercised against an item that does not exist; it has no
# add, delete or signing code that can run. The real Keychain custody (enrol, sign, unenrol) is covered only by
# scripts/presence/test-custody.sh, which an owner runs against a test-only service and account.
# The production binary built by build.sh is only ever run with messages or arguments that fail before any OS
# call (usage exit 2, or exit 5 on an unwritable stdout); it is never asked to `check`, because `check` reads the
# product pin item's attributes. The production source has no switch that skips the prompt or the Keychain;
# the stubbing happens only in this script's copies.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="${HERE}/ccc-presence.m"
FAIL=0
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT INT TERM

check() {
  if [ "$1" = ok ]; then echo "ok - $2"; else echo "not ok - $2"; FAIL=1; fi
}

SPKI=$(perl -e 'print pack("H*", "3059301306072a8648ce3d020106082a8648ce3d030107034200" . "04" . ("11" x 64))' | base64 | tr -d '\n')
HASH11=$(printf '0x11,%.0s' $(seq 20))
HASH22=$(printf '0x22,%.0s' $(seq 20))

seam() { # file name replacement
  SEAM_NAME="$2" SEAM_STUB="$3" perl -0pi -e 's{(// HARNESS-SEAM-BEGIN \Q$ENV{SEAM_NAME}\E\n).*?(// HARNESS-SEAM-END \Q$ENV{SEAM_NAME}\E)}{$1$ENV{SEAM_STUB}\n$2}s' "$1"
  grep -q "HARNESS-SEAM-BEGIN $2" "$1" || { echo "FATAL: seam $2 missing from the source" >&2; exit 1; }
}

lookup_stub() { # kind
  case "$1" in
    current) printf 'static OSStatus pinLookup(NSDictionary *__autoreleasing *o) { static const uint8_t c[20] = {%s}; *o = @{ (id)kSecAttrComment : @"%s", (id)kSecAttrGeneric : [NSData dataWithBytes:c length:20] }; return errSecSuccess; }' "${HASH11}" "${SPKI}" ;;
    stale) printf 'static OSStatus pinLookup(NSDictionary *__autoreleasing *o) { static const uint8_t c[20] = {%s}; *o = @{ (id)kSecAttrComment : @"%s", (id)kSecAttrGeneric : [NSData dataWithBytes:c length:20] }; return errSecSuccess; }' "${HASH22}" "${SPKI}" ;;
    nogeneric) printf 'static OSStatus pinLookup(NSDictionary *__autoreleasing *o) { *o = @{ (id)kSecAttrComment : @"%s" }; return errSecSuccess; }' "${SPKI}" ;;
    malformed) printf 'static OSStatus pinLookup(NSDictionary *__autoreleasing *o) { static const uint8_t c[20] = {%s}; *o = @{ (id)kSecAttrComment : @"junk", (id)kSecAttrGeneric : [NSData dataWithBytes:c length:20] }; return errSecSuccess; }' "${HASH11}" ;;
    absent) printf 'static OSStatus pinLookup(NSDictionary *__autoreleasing *o) { (void)o; return errSecItemNotFound; }' ;;
    error) printf 'static OSStatus pinLookup(NSDictionary *__autoreleasing *o) { (void)o; return -25308; }' ;;
  esac
}

# stub_build name eval_body ceiling lookup_kind [sign=ok|fail] [delete_status=0]
stub_build() {
  _n=$1; _eval=$2; _ceil=$3; _kind=$4; _sign=${5:-ok}; _del=${6:-0}
  cp "${SRC}" "${WORK}/${_n}.m"
  [ "$(grep -c '\[context evaluatePolicy:' "${WORK}/${_n}.m")" = 1 ] || { echo "FATAL: expected exactly one evaluatePolicy call" >&2; exit 1; }
  perl -0pi -e 's/\[context evaluatePolicy:.*?\];\n/'"${_eval}"'\n/s; s/kProveCeilingSeconds = 60;/kProveCeilingSeconds = '"${_ceil}"';/; s/(kPinService = )\@"[^"]*"/$1\@"com.claude-command-center.uat-harness-unused"/; s/(kPinAccount = )\@"[^"]*"/$1\@"ccc-uat-harness-unused"/' "${WORK}/${_n}.m"
  seam "${WORK}/${_n}.m" own-cdhash "static NSData *ownCdhash(void) { static const uint8_t c[20] = {${HASH11}}; return [NSData dataWithBytes:c length:20]; }"
  seam "${WORK}/${_n}.m" pin-lookup "$(lookup_stub "${_kind}")"
  if [ "${_sign}" = ok ]; then
    seam "${WORK}/${_n}.m" pin-sign 'static BOOL signWithPinnedKey(NSData *m, NSString *__autoreleasing *o) { (void)m; *o = @"c3R1YnN0dWJzdHVi"; return YES; }'
  else
    seam "${WORK}/${_n}.m" pin-sign 'static BOOL signWithPinnedKey(NSData *m, NSString *__autoreleasing *o) { (void)m; (void)o; return NO; }'
  fi
  seam "${WORK}/${_n}.m" pin-delete "static OSStatus deletePinItem(void) { fclose(fopen(\"${WORK}/${_n}.deleted\", \"w\")); return ${_del}; }"
  seam "${WORK}/${_n}.m" pin-add "static OSStatus addPinItem(NSString *m, NSData *s, NSData *h, SecAccessRef a) { (void)m; (void)s; (void)h; (void)a; fclose(fopen(\"${WORK}/${_n}.added\", \"w\")); return errSecSuccess; }"
  guard "${_n}"
  compile_copy "${_n}"
}

guard() {
  if grep -q '\[context evaluatePolicy' "${WORK}/$1.m"; then
    echo "FATAL: stub for $1 did not remove the evaluatePolicy call" >&2; exit 1
  fi
  if grep -Eq 'SecItem(CopyMatching|Add|Delete)|SecKeyCreateWithData' "${WORK}/$1.m"; then
    echo "FATAL: stub for $1 left a real Keychain call in place" >&2; exit 1
  fi
  guard_names "$1"
}

guard_names() {
  if grep -q '"approval-presence-pin"\|kPinService = @"com.claude-command-center"' "${WORK}/$1.m"; then
    echo "FATAL: stub for $1 left the product pin name in place" >&2; exit 1
  fi
}

compile_copy() {
  xcrun clang -fobjc-arc -O2 -framework Foundation -framework LocalAuthentication -framework Security \
    -o "${WORK}/$1" "${WORK}/$1.m" 2>"${WORK}/$1.log" || { echo "FATAL: harness $1 failed to compile" >&2; cat "${WORK}/$1.log" >&2; exit 1; }
}

ACCEPT='success = YES; dispatch_semaphore_signal(done);'
CANCEL='success = NO; failureCode = -2; dispatch_semaphore_signal(done);'
SILENT='(void)0;'

stub_build accept "${ACCEPT}" 60 current
stub_build cancel "${CANCEL}" 60 current
stub_build silent "${SILENT}" 1 current
stub_build accept-stale "${ACCEPT}" 60 stale
stub_build accept-nogeneric "${ACCEPT}" 60 nogeneric
stub_build accept-absent "${ACCEPT}" 60 absent
stub_build cancel-absent "${CANCEL}" 60 absent
stub_build accept-malformed "${ACCEPT}" 60 malformed
stub_build cancel-malformed "${CANCEL}" 60 malformed
stub_build accept-signfail "${ACCEPT}" 60 current fail
stub_build accept-delfail "${ACCEPT}" 60 current ok -25244
stub_build accept-lookuperr "${ACCEPT}" 60 error

PID=$(printf 'a%.0s' $(seq 25))
MSGHASH=$(printf 'b%.0s' $(seq 64))
msg() { # approvedAt
  printf '{"v":1,"proposalId":"%s","operation":"diagnostic.test","payloadHash":"%s","decision":"approve","approvedAt":"%s"}' "${PID}" "${MSGHASH}" "$1" | base64 | tr -d '\n'
}
GOOD=$(msg 2026-10-28T12:00:00Z)

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
OUT=$("${WORK}/cancel" prove --message "${GOOD}"); RC=$?
[ "${RC}" -eq 4 ] && [ "${OUT}" = '{"v":1,"result":"denied","error":-2}' ] && check ok "cancel: denied, LAError code, no cause" || check no "cancel: denied, LAError code, no cause (rc ${RC}: ${OUT})"
OUT=$("${WORK}/silent" prove --message "${GOOD}"); RC=$?
[ "${RC}" -eq 4 ] && [ "${OUT}" = '{"v":1,"result":"denied","error":-9,"cause":"timeout"}' ] && check ok "timeout: denied, exit 4, cause timeout" || check no "timeout: denied, exit 4, cause timeout (rc ${RC}: ${OUT})"

# M1 (FIX6B): a pin that a different binary enrolled (a rebuild without re-enrol) is stale: reported before any prompt.
OUT=$("${WORK}/accept-stale" prove --message "${GOOD}"); RC=$?
[ "${RC}" -eq 3 ] && [ "${OUT}" = '{"v":1,"canEvaluate":true,"enrolled":false,"stale":true}' ] && check ok "prove with a stale pin: exit 3, stale line, no prompt (the accepting stub never ran)" || check no "prove with a stale pin (rc ${RC}: ${OUT})"
OUT=$("${WORK}/accept-nogeneric" prove --message "${GOOD}"); RC=$?
[ "${RC}" -eq 3 ] && [ "${OUT}" = '{"v":1,"canEvaluate":true,"enrolled":false,"stale":true}' ] && check ok "prove with a pin that records no enrolling binary (older enrol): stale" || check no "prove with a pin that records no enrolling binary (rc ${RC}: ${OUT})"
OUT=$("${WORK}/accept-absent" prove --message "${GOOD}"); RC=$?
[ "${RC}" -eq 3 ] && [ "${OUT}" = '{"v":1,"canEvaluate":true,"enrolled":false}' ] && check ok "prove with no pin: exit 3, not enrolled, no prompt" || check no "prove with no pin (rc ${RC}: ${OUT})"
OUT=$("${WORK}/accept-malformed" prove --message "${GOOD}"); RC=$?
[ "${RC}" -eq 3 ] && [ "${OUT}" = '{"v":1,"canEvaluate":true,"enrolled":false}' ] && check ok "prove with a malformed pin comment: not enrolled" || check no "prove with a malformed pin comment (rc ${RC}: ${OUT})"
# check never prompts; where the OS can evaluate the policy it reports current, stale and absent pins.
check_line() { # binary expected-enrolled-and-stale-regex description
  OUT=$("${WORK}/$1" check); RC=$?
  if [ "${RC}" -eq 3 ] && printf '%s' "${OUT}" | grep -Eq '^\{"v":1,"canEvaluate":false,"error":-?[0-9]+\}$'; then
    check ok "$3 (this machine cannot evaluate the policy: canEvaluate false, exit 3)"
  elif [ "${RC}" -eq 0 ] && printf '%s' "${OUT}" | grep -Eq "$2"; then
    check ok "$3"
  else
    check no "$3 (rc ${RC}: ${OUT})"
  fi
}
check_line accept '^\{"v":1,"canEvaluate":true,"biometry":"(touch-id|none)","enrolled":true\}$' "check with a current pin: enrolled true, no stale member"
check_line accept-stale '^\{"v":1,"canEvaluate":true,"biometry":"(touch-id|none)","enrolled":false,"stale":true\}$' "check with a stale pin: enrolled false and stale true"
check_line accept-absent '^\{"v":1,"canEvaluate":true,"biometry":"(touch-id|none)","enrolled":false\}$' "check with no pin: enrolled false, no stale member"

# m5 (FIX6B): the owner authenticated but the key could not be used -> a closed line of its own, exit 3.
OUT=$("${WORK}/accept-signfail" prove --message "${GOOD}"); RC=$?
[ "${RC}" -eq 3 ] && [ "${OUT}" = '{"v":1,"error":"signing-failed"}' ] && check ok "signing failure after the gesture: its own closed line, exit 3 (not 'not enrolled')" || check no "signing failure after the gesture (rc ${RC}: ${OUT})"

# C1 (FIX6B): unenrol needs the owner's gesture; nothing is deleted without it.
rm -f "${WORK}"/*.deleted "${WORK}"/*.added
OUT=$("${WORK}/cancel" unenrol); RC=$?
[ "${RC}" -eq 4 ] && [ "${OUT}" = '{"v":1,"result":"denied","error":-2}' ] && [ ! -e "${WORK}/cancel.deleted" ] && check ok "unenrol, gesture cancelled: exit 4 denied, nothing deleted" || check no "unenrol, gesture cancelled (rc ${RC}: ${OUT}; deleted marker: $([ -e "${WORK}/cancel.deleted" ] && echo yes || echo no))"
OUT=$("${WORK}/silent" unenrol); RC=$?
[ "${RC}" -eq 4 ] && [ "${OUT}" = '{"v":1,"result":"denied","error":-9,"cause":"timeout"}' ] && [ ! -e "${WORK}/silent.deleted" ] && check ok "unenrol, gesture times out: exit 4 denied (cause timeout), nothing deleted" || check no "unenrol, gesture times out (rc ${RC}: ${OUT})"
OUT=$("${WORK}/accept" unenrol); RC=$?
[ "${RC}" -eq 0 ] && [ "${OUT}" = '{"v":1,"enrolled":false}' ] && [ -e "${WORK}/accept.deleted" ] && check ok "unenrol, gesture accepted: deleted, exit 0" || check no "unenrol, gesture accepted (rc ${RC}: ${OUT}; deleted marker: $([ -e "${WORK}/accept.deleted" ] && echo yes || echo no))"
OUT=$("${WORK}/cancel-absent" unenrol); RC=$?
[ "${RC}" -eq 0 ] && [ "${OUT}" = '{"v":1,"enrolled":false}' ] && [ ! -e "${WORK}/cancel-absent.deleted" ] && check ok "unenrol with no item: exit 0, no gesture asked (the cancelling stub never ran), nothing deleted" || check no "unenrol with no item (rc ${RC}: ${OUT})"
OUT=$("${WORK}/accept-stale" unenrol); RC=$?
[ "${RC}" -eq 0 ] && [ -e "${WORK}/accept-stale.deleted" ] && check ok "unenrol removes a stale item too (after the gesture)" || check no "unenrol of a stale item (rc ${RC}: ${OUT})"
OUT=$("${WORK}/accept-delfail" unenrol); RC=$?
[ "${RC}" -eq 3 ] && [ "${OUT}" = '{"v":1,"enrolled":true,"error":-25244}' ] && check ok "unenrol, delete refused by the Keychain: exit 3 with the status, still enrolled" || check no "unenrol, delete refused (rc ${RC}: ${OUT})"
OUT=$("${WORK}/accept-lookuperr" unenrol); RC=$?
[ "${RC}" -eq 3 ] && [ "${OUT}" = '{"v":1,"error":-25308}' ] && [ ! -e "${WORK}/accept-lookuperr.deleted" ] && check ok "unenrol when the lookup itself fails: exit 3, nothing deleted, never reported as removed" || check no "unenrol when the lookup fails (rc ${RC}: ${OUT})"

# C1 / m1 (FIX6B): replacing an existing item (enrol) needs the gesture; a first enrol needs none; a malformed
# leftover is removed (after the gesture) instead of making the add fail for good.
rm -f "${WORK}"/*.deleted "${WORK}"/*.added
OUT=$("${WORK}/cancel" enrol); RC=$?
[ "${RC}" -eq 4 ] && [ ! -e "${WORK}/cancel.deleted" ] && [ ! -e "${WORK}/cancel.added" ] && check ok "enrol over an existing item, gesture cancelled: exit 4, nothing deleted, nothing added" || check no "enrol over an existing item, gesture cancelled (rc ${RC}: ${OUT})"
OUT=$("${WORK}/accept" enrol); RC=$?
[ "${RC}" -eq 0 ] && [ "${OUT}" = '{"v":1,"enrolled":true}' ] && [ -e "${WORK}/accept.deleted" ] && [ -e "${WORK}/accept.added" ] && check ok "enrol over an existing item, gesture accepted: replaced (deleted then added)" || check no "enrol over an existing item, gesture accepted (rc ${RC}: ${OUT})"
OUT=$("${WORK}/cancel-absent" enrol); RC=$?
[ "${RC}" -eq 0 ] && [ "${OUT}" = '{"v":1,"enrolled":true}' ] && [ ! -e "${WORK}/cancel-absent.deleted" ] && [ -e "${WORK}/cancel-absent.added" ] && check ok "first enrol (no item): no gesture, nothing deleted, added" || check no "first enrol (rc ${RC}: ${OUT})"
OUT=$("${WORK}/accept-malformed" enrol); RC=$?
[ "${RC}" -eq 0 ] && [ -e "${WORK}/accept-malformed.deleted" ] && [ -e "${WORK}/accept-malformed.added" ] && check ok "enrol over a malformed leftover: deleted (after the gesture) and re-added" || check no "enrol over a malformed leftover (rc ${RC}: ${OUT})"
OUT=$("${WORK}/cancel-malformed" enrol); RC=$?
[ "${RC}" -eq 4 ] && [ ! -e "${WORK}/cancel-malformed.deleted" ] && [ ! -e "${WORK}/cancel-malformed.added" ] && check ok "enrol over a malformed leftover, gesture cancelled: nothing deleted or added" || check no "enrol over a malformed leftover, cancelled (rc ${RC}: ${OUT})"
OUT=$("${WORK}/accept-delfail" enrol); RC=$?
[ "${RC}" -eq 3 ] && [ ! -e "${WORK}/accept-delfail.added" ] && check ok "enrol whose delete is refused: exit 3, nothing added" || check no "enrol whose delete is refused (rc ${RC}: ${OUT})"

# The REAL attribute-only lookup (login-keychain scoped) against an item that does not exist: no pin, no prompt.
cp "${SRC}" "${WORK}/lookup.m"
perl -0pi -e 's/(kPinService = )\@"[^"]*"/$1\@"com.claude-command-center.uat-harness-unused"/; s/(kPinAccount = )\@"[^"]*"/$1\@"ccc-uat-harness-unused"/' "${WORK}/lookup.m"
seam "${WORK}/lookup.m" pin-sign 'static BOOL signWithPinnedKey(NSData *m, NSString *__autoreleasing *o) { (void)m; (void)o; return NO; }'
seam "${WORK}/lookup.m" pin-delete 'static OSStatus deletePinItem(void) { return errSecItemNotFound; }'
seam "${WORK}/lookup.m" pin-add 'static OSStatus addPinItem(NSString *m, NSData *s, NSData *h, SecAccessRef a) { (void)m; (void)s; (void)h; (void)a; return errSecInternalError; }'
if grep -Eq 'SecItem(Add|Delete)|SecKeyCreateWithData' "${WORK}/lookup.m"; then echo "FATAL: the lookup copy kept a writing Keychain call" >&2; exit 1; fi
guard_names lookup
compile_copy lookup
OUT=$("${WORK}/lookup" check); RC=$?
if [ "${RC}" -eq 3 ]; then
  printf '%s' "${OUT}" | grep -Eq '^\{"v":1,"canEvaluate":false,"error":-?[0-9]+\}$' && check ok "real lookup copy: check on a machine that cannot evaluate: canEvaluate false, exit 3" || check no "real lookup copy: check (rc ${RC}: ${OUT})"
else
  [ "${RC}" -eq 0 ] && [ "${OUT}" = '{"v":1,"canEvaluate":true,"biometry":"touch-id","enrolled":false}' -o "${OUT}" = '{"v":1,"canEvaluate":true,"biometry":"none","enrolled":false}' ] && check ok "real lookup copy: an item that does not exist reads enrolled false (login-keychain scoped attribute lookup works)" || check no "real lookup copy: check (rc ${RC}: ${OUT})"
fi
# F4: exit 5 is reachable - a stdout the helper cannot write to is an internal failure (check never prompts).
"${WORK}/lookup" check >&- 2>/dev/null; RC=$?
[ "${RC}" -eq 5 ] && check ok "check with unwritable stdout exits 5" || check no "check with unwritable stdout exits 5 (rc ${RC})"

# The production binary: only inputs that fail before any OS call (never `check`, never a message that validates).
RT="${WORK}/rt"
CCC_RUNTIME_DIR="${RT}" sh "${HERE}/build.sh" >/dev/null 2>&1 || { echo "FATAL: real build failed" >&2; exit 1; }
REAL="${RT}/bin/ccc-presence"
"${REAL}" prove --message '!!!not-base64' >&- 2>/dev/null; RC=$?
[ "${RC}" -eq 5 ] && check ok "malformed prove with unwritable stdout exits 5" || check no "malformed prove with unwritable stdout exits 5 (rc ${RC})"
OUT=$("${REAL}" prove --message '!!!not-base64'); RC=$?
[ "${RC}" -eq 2 ] && [ "${OUT}" = '{"v":1,"error":"usage"}' ] && check ok "malformed prove: usage exit 2" || check no "malformed prove: usage exit 2 (rc ${RC}: ${OUT})"
OUT=$("${REAL}" enrol extra); RC=$?
[ "${RC}" -eq 2 ] && [ "${OUT}" = '{"v":1,"error":"usage"}' ] && check ok "enrol with an extra argument is a usage error (nothing is created)" || check no "enrol with an extra argument is a usage error (rc ${RC}: ${OUT})"
OUT=$("${REAL}" unenrol extra); RC=$?
[ "${RC}" -eq 2 ] && [ "${OUT}" = '{"v":1,"error":"usage"}' ] && check ok "unenrol with an extra argument is a usage error (nothing is deleted)" || check no "unenrol with an extra argument is a usage error (rc ${RC}: ${OUT})"
OUT=$("${REAL}" bogus); RC=$?
[ "${RC}" -eq 2 ] && check ok "unknown subcommand: exit 2" || check no "unknown subcommand: exit 2 (rc ${RC})"

exit "${FAIL}"
