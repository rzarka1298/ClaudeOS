#!/bin/sh
# Restarts the already-registered LaunchAgent after a code change, without
# ever deregistering it (ADR-0015). `kickstart -k` kills the running
# instance and lets `RunAtLoad`/`KeepAlive` bring up a fresh one -- this is
# the modern replacement for the deprecated `unload`+`load` restart dance.
set -eu

LABEL="com.claude-command-center.service"

launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "Restarted ${LABEL}"
