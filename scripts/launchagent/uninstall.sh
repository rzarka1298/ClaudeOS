#!/bin/sh
# Deregisters the companion service's LaunchAgent (ADR-0015). Uses
# `launchctl bootout`, tolerating the not-registered case, then removes
# the property list -- never the deprecated `unload` subcommand, which
# exits zero while doing nothing on a malformed or already-removed job.
set -eu

LABEL="com.claude-command-center.service"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
rm -f "${PLIST_DEST}"

echo "Removed ${LABEL}"
