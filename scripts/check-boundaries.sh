#!/bin/sh
# Literal grep backstop layered under the eslint-plugin-boundaries lint rule
# (eslint.config.mjs) and the TypeScript project-reference layer
# (tsconfig.base.json) -- the third of the three boundary-gate layers
# recorded in docs/adr/0019-import-boundary-enforcement.md. A lint rule
# catches import edges through its element-type glob map; this script
# catches the case where that glob map silently stops matching (a config
# typo, a moved directory) by re-deriving the same prohibitions from a
# completely independent mechanism: a plain literal grep over tracked
# source files.
#
# Exits non-zero with the offending file and line on any hit. Comment lines
# are filtered out of every match so a header comment describing a rule (for
# example this file's own prose, or an eslint.config.mjs comment naming
# "obsidian" or "node:http") can never itself trip the gate it documents.

set -eu

FAILURES=0

# Every tracked TypeScript source file under packages/, excluding build
# output and the boundary-violation fixtures (those exist specifically to
# violate these rules under the lint gate, plan 01-03 task 1, and must not
# also trip the backstop).
list_source_files() {
  git ls-files -z -- 'packages/*.ts' 'packages/*.tsx' 2>/dev/null | \
    tr '\0' '\n' | \
    grep -v '/dist/' | \
    grep -v '/node_modules/' | \
    grep -v 'boundary-violations/'
}

# Prints "file:line:content" for every non-comment line in the given files
# matching the given extended regex. A "comment line" is one whose
# leading (whitespace-trimmed) characters are `//`, `/*`, or `*` (single-line
# comment, block-comment opener, or a JSDoc continuation line).
grep_noncomment() {
  pattern="$1"
  shift
  for f in "$@"; do
    [ -f "$f" ] || continue
    awk -v pattern="$pattern" -v fname="$f" '
      {
        trimmed = $0
        sub(/^[ \t]+/, "", trimmed)
        is_comment = (trimmed ~ /^\/\//) || (trimmed ~ /^\/\*/) || (trimmed ~ /^\*/)
        if (!is_comment && $0 ~ pattern) {
          print fname ":" NR ":" $0
        }
      }
    ' "$f"
  done
}

check_rule() {
  description="$1"
  pattern="$2"
  shift 2
  # Remaining args: files to scan (already pre-filtered by caller to the
  # relevant subset -- e.g. "every source file outside packages/plugin").
  hits=$(grep_noncomment "$pattern" "$@" || true)
  if [ -n "$hits" ]; then
    echo "BOUNDARY VIOLATION: $description"
    echo "$hits"
    FAILURES=$((FAILURES + 1))
  fi
}

SRC_FILES=$(list_source_files)

# --- Rule 1: no file outside packages/plugin imports the Obsidian API ---
NON_PLUGIN_FILES=$(printf '%s\n' "$SRC_FILES" | grep -v '^packages/plugin/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file outside packages/plugin imports the Obsidian API" \
  "from[[:space:]]*[\"']obsidian[\"']" \
  $NON_PLUGIN_FILES

# --- Rule 2: no file inside packages/plugin imports a Node HTTP module ---
PLUGIN_FILES=$(printf '%s\n' "$SRC_FILES" | grep '^packages/plugin/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file inside packages/plugin imports a Node HTTP module (must speak only through @ccc/service-api-client)" \
  "from[[:space:]]*[\"']node:https?[\"']" \
  $PLUGIN_FILES

# --- Rule 3: nothing outside packages/service or packages/operational-store
# imports the SQLite binding ---
NON_SQLITE_OWNERS=$(printf '%s\n' "$SRC_FILES" | grep -v '^packages/service/' | grep -v '^packages/operational-store/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file outside packages/service and packages/operational-store imports the better-sqlite3 binding" \
  "from[[:space:]]*[\"']better-sqlite3[\"']" \
  $NON_SQLITE_OWNERS

# --- Rule 4: nothing outside packages/keychain spawns the system security tool ---
NON_KEYCHAIN_FILES=$(printf '%s\n' "$SRC_FILES" | grep -v '^packages/keychain/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file outside packages/keychain spawns the macOS security(1) tool directly" \
  "(execa|spawn|execFile|exec).[[:space:]]*[\"'](/usr/bin/)?security[\"']" \
  $NON_KEYCHAIN_FILES

# --- Rule 5: no file anywhere references a mail-transport module or SMTP
# client -- the product has no email-send surface at any layer, ever
# (GMAIL-08). The absence is asserted, not assumed. ---
# shellcheck disable=SC2086
check_rule \
  "a file references a mail-transport module or SMTP client -- no email-send surface may exist at any layer" \
  "(nodemailer|node-smtp|smtp-client|SMTPClient|SmtpClient|SMTP|Smtp|smtp)" \
  $SRC_FILES

FILE_COUNT=$(printf '%s\n' "$SRC_FILES" | grep -c . || true)
echo "scripts/check-boundaries.sh: scanned ${FILE_COUNT} tracked source files, ${FAILURES} rule(s) violated."

if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
