#!/bin/sh
# Owner-run installer for the Codex hook package (plan 05.1-24, CODEX-06).
# A thin POSIX shim: every behaviour lives in install.mjs.
exec node "$(dirname "$0")/install.mjs" "$@"
