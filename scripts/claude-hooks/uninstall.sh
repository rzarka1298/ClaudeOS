#!/bin/sh
# Owner-run uninstaller for the Claude Code hook package (plan 05-09, PR-22).
# A thin POSIX shim: every behaviour lives in uninstall.mjs.
exec node "$(dirname "$0")/uninstall.mjs" "$@"
