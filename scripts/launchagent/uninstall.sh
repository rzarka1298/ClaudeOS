#!/bin/sh
# Deregisters the companion service's LaunchAgent (ADR-0015). Uses
# `launchctl bootout`, tolerating the not-registered case, then removes
# the property list -- never the deprecated `unload` subcommand, which
# exits zero while doing nothing on a malformed or already-removed job.
set -eu

LABEL="com.claude-command-center.service"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RUNTIME_DIR="${CCC_RUNTIME_DIR:-${HOME}/.claude-command-center}"
PRESENCE_HELPER="${RUNTIME_DIR}/bin/ccc-presence"
PRESENCE_RUN="${SCRIPT_DIR}/../presence/run-helper.mjs"
PRESENCE_TIMEOUT="${CCC_PRESENCE_HELPER_TIMEOUT:-90}"

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
rm -f "${PLIST_DEST}"

# The presence helper (APPR-11): delete its signing-key Keychain item with the very binary that
# the item trusts, then remove the binary. A helper that is already gone leaves nothing to do. If
# the item cannot be removed the binary is KEPT so this script can be run again (no other binary
# may delete the item without a Keychain prompt). FIX6B: the helper asks for Touch ID or the password
# before it deletes its key, so uninstalling shows ONE prompt; the call is bounded (default 90 s) and the
# helper's JSON answer is kept in the WARNING. `pnpm run dev:service` only needs the LaunchAgent gone, so
# it sets CCC_KEEP_PRESENCE=1 and the helper and its key stay.
if [ "${CCC_KEEP_PRESENCE:-}" = "1" ]; then
  :
elif [ -x "${PRESENCE_HELPER}" ]; then
  if helper_out=$(node "${PRESENCE_RUN}" "${PRESENCE_TIMEOUT}" "${PRESENCE_HELPER}" unenrol 2>&1); then
    rm -f "${PRESENCE_HELPER}"
  else
    echo "WARNING: the presence helper could not remove its Keychain item (approval-presence-pin) (${helper_out}); it was kept so you can run this script again." >&2
  fi
else
  rm -f "${PRESENCE_HELPER}"
fi

echo "Removed ${LABEL}"
