#!/bin/sh
# Compiles the owner-presence helper (APPR-11, D-01 as amended by R-01) with
# the Command Line Tools clang into <runtime dir>/bin/ccc-presence. Never
# swiftc (the CLT swiftc cannot build Foundation programs here), never a
# committed binary. Re-run after any change to ccc-presence.m: an ad-hoc
# signature changes on every recompile.
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SOURCE="${SCRIPT_DIR}/ccc-presence.m"
RUNTIME_DIR="${CCC_RUNTIME_DIR:-${HOME}/.claude-command-center}"
BIN_DIR="${RUNTIME_DIR}/bin"
OUT="${BIN_DIR}/ccc-presence"
TMP_OUT="${OUT}.tmp"

mkdir -p "${BIN_DIR}"

if ! xcrun --find clang >/dev/null 2>&1; then
  echo "ERROR: helper-build-failed: clang-not-found" >&2
  exit 1
fi

if ! xcrun clang -fobjc-arc -O2 \
  -framework Foundation -framework LocalAuthentication -framework Security \
  -o "${TMP_OUT}" "${SOURCE}" >/dev/null 2>&1; then
  rm -f "${TMP_OUT}"
  echo "ERROR: helper-build-failed: compile" >&2
  exit 1
fi

chmod 0700 "${TMP_OUT}"
mv "${TMP_OUT}" "${OUT}"
