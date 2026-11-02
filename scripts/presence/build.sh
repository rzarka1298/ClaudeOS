#!/bin/sh
# Compiles the owner-presence helper (APPR-11, D-01 as amended by R-01) with
# the Command Line Tools clang into <runtime dir>/bin/ccc-presence. Never
# swiftc (the CLT swiftc cannot build Foundation programs here), never a
# committed binary. Re-run after any change to ccc-presence.m: an ad-hoc
# signature changes on every recompile.
#
# The build happens in a private mktemp directory under <runtime dir>/bin so
# concurrent builds cannot collide, and the result is re-signed ad-hoc with the
# explicit identifier below so the installed binary's code identifier is stable
# and meaningful (otherwise the linker signature carries the temp file's name).
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SOURCE="${SCRIPT_DIR}/ccc-presence.m"
RUNTIME_DIR="${CCC_RUNTIME_DIR:-${HOME}/.claude-command-center}"
BIN_DIR="${RUNTIME_DIR}/bin"
OUT="${BIN_DIR}/ccc-presence"
CODE_IDENTIFIER="com.claude-command-center.presence"

if ! mkdir -p "${BIN_DIR}" 2>/dev/null; then
  echo "ERROR: helper-build-failed: runtime-dir" >&2
  exit 1
fi

if ! xcrun --find clang >/dev/null 2>&1; then
  echo "ERROR: helper-build-failed: clang-not-found" >&2
  exit 1
fi

if ! WORK=$(mktemp -d "${BIN_DIR}/.build.XXXXXX" 2>/dev/null); then
  echo "ERROR: helper-build-failed: runtime-dir" >&2
  exit 1
fi
trap 'rm -rf "${WORK}"' EXIT INT TERM

TMP_OUT="${WORK}/ccc-presence"
DIAG="${WORK}/clang.log"

if ! xcrun clang -fobjc-arc -O2 \
  -framework Foundation -framework LocalAuthentication -framework Security \
  -o "${TMP_OUT}" "${SOURCE}" >"${DIAG}" 2>&1; then
  echo "ERROR: helper-build-failed: compile" >&2
  cat "${DIAG}" >&2
  exit 1
fi

# `-o runtime` is the hardened runtime: without it a same-user process can run THIS binary (the one the
# Keychain item trusts) with DYLD_INSERT_LIBRARIES and execute its own code inside the trusted identity.
# test-build.sh pins both the flag and the refusal of an inserted library.
if ! codesign -f -s - -o runtime -i "${CODE_IDENTIFIER}" "${TMP_OUT}" >"${DIAG}" 2>&1; then
  echo "ERROR: helper-build-failed: codesign" >&2
  cat "${DIAG}" >&2
  exit 1
fi

chmod 0700 "${TMP_OUT}"
mv -f "${TMP_OUT}" "${OUT}"
